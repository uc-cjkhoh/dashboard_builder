using System.Text;

namespace DashboardBuilder.ClickHouse;

/// <summary>
/// The one place free-text SQL is accepted (D105): a card's "Edit SQL". The text becomes a derived table
/// (<c>FROM (…) AS t0</c>) inside the bounded, time-limited, <c>readonly=2</c> query every worksheet runs, so this guard only has to
/// keep it a single plain SELECT that cannot leave that wrapper or change the query's settings. Pure (no I/O), unit-tested.
/// Accepted: one statement starting with SELECT or WITH, comments stripped, balanced parentheses, no SETTINGS, FORMAT or INTO OUTFILE
/// clause, and a table function only from <see cref="AllowedTableFunctions"/> (a name followed by <c>(</c> where a table goes: after
/// FROM or JOIN, or after a comma in a FROM list). A name in backticks or double quotes is checked like a bare one, and a backslash
/// escapes the next character inside any quotes, as ClickHouse reads them (and as <see cref="Identifier.Quote"/> writes them).
/// </summary>
public static class CustomSql
{
    /// <summary>Table functions that read from outside ClickHouse's own tables (files, the network, other databases, the server's shell).</summary>
    internal static readonly HashSet<string> BlockedFunctions = new(StringComparer.OrdinalIgnoreCase)
    {
        "url", "urlcluster", "file", "filecluster", "s3", "s3cluster", "hdfs", "hdfscluster", "remote", "remotesecure",
        "cluster", "clusterallreplicas", "mysql", "postgresql", "mongodb", "redis", "jdbc", "odbc", "sqlite", "executable",
        "input", "azureblobstorage", "azureblobstoragecluster", "deltalake", "iceberg", "hudi", "gcs", "oss", "cosn",
    };

    /// <summary>The only table functions allowed where a table goes: they make rows from their arguments or read this connection's own
    /// tables. Any other name followed by <c>(</c> there is refused, so a table function added to a later ClickHouse is refused too.</summary>
    internal static readonly HashSet<string> AllowedTableFunctions = new(StringComparer.OrdinalIgnoreCase)
    {
        "numbers", "numbers_mt", "zeros", "zeros_mt", "generate_series", "generateseries", "generaterandom", "values", "view", "merge", "null",
    };

    private static readonly HashSet<string> SortWords = new(StringComparer.OrdinalIgnoreCase) { "asc", "desc", "ascending", "descending", "nulls", "collate", "with" };

    // Clause words that end a FROM list at the depth it was opened.
    private static readonly HashSet<string> EndsFrom = new(StringComparer.OrdinalIgnoreCase)
    {
        "where", "prewhere", "group", "having", "order", "limit", "union", "except", "intersect", "window", "qualify", "on", "using",
        "array", "sample", "final", "offset", "select", "with",
    };

    /// <summary>Check <paramref name="raw"/> and return it ready to embed: comments removed, a trailing <c>;</c> dropped, whitespace trimmed.</summary>
    /// <exception cref="RequestValidationException">Anything that is not one plain SELECT; the message says why in plain words (field <c>source.sql</c>).</exception>
    public static string Clean(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) throw Bad("Write a SELECT query.");
        if (raw.Length > ApiLimits.MaxCustomSqlChars) throw Bad($"The query can be at most {ApiLimits.MaxCustomSqlChars:N0} characters.");
        var text = Strip(raw).Trim();
        while (text.EndsWith(';')) text = text[..^1].TrimEnd(); // one trailing semicolon is just habit
        if (text.Length == 0) throw Bad("Write a SELECT query.");

        var tokens = Tokens(text).ToList();
        if (tokens.Count == 0 || tokens[0] is not { Kind: Token.Word } head || !head.Value.Equals("select", StringComparison.OrdinalIgnoreCase) && !head.Value.Equals("with", StringComparison.OrdinalIgnoreCase))
            throw Bad("The query must start with SELECT (or WITH).");
        var depth = 0;
        foreach (var (kind, value) in tokens)
        {
            if (kind == Token.Symbol && value == ";") throw Bad("Only one query can be saved; remove the extra ';'.");
            if (kind == Token.Symbol && value == "(") depth++;
            else if (kind == Token.Symbol && value == ")" && --depth < 0) throw Bad("There is a ')' with no '(' before it.");
            else if (kind == Token.Word && value.Equals("settings", StringComparison.OrdinalIgnoreCase)) throw Bad("A query can't change settings; remove the SETTINGS part.");
        }
        if (depth != 0) throw Bad("A '(' is never closed.");
        CheckOutput(tokens);
        CheckFunctions(tokens);
        return text;
    }

    /// <summary>The name a word or quoted name stands for (quotes removed, escapes and doubled quotes undone); null for anything else.</summary>
    private static string? NameOf((Token Kind, string Value) t)
    {
        if (t.Kind == Token.Word) return t.Value;
        if (t.Kind != Token.Name) return null;
        var q = t.Value[0];
        var o = new StringBuilder();
        for (var i = 1; i < t.Value.Length - 1; i++)
        {
            if (t.Value[i] == '\\' && i + 1 < t.Value.Length - 1) { o.Append(t.Value[++i]); continue; }
            if (t.Value[i] == q && t.Value[i + 1] == q) { o.Append(q); i++; continue; }
            o.Append(t.Value[i]);
        }
        return o.ToString();
    }

    private static bool IsWord((Token Kind, string Value) t, string word) => t.Kind == Token.Word && t.Value.Equals(word, StringComparison.OrdinalIgnoreCase);

    // FORMAT changes what ClickHouse sends back (it can only end the query, as SETTINGS is refused); INTO OUTFILE writes a file.
    private static void CheckOutput(List<(Token Kind, string Value)> tokens)
    {
        // Not a column called format at the end of an ORDER BY (… BY format DESC, …, format ASC) or an alias (AS format x).
        if (tokens.Count >= 3 && IsWord(tokens[^2], "format") && NameOf(tokens[^1]) is { } fmt && !SortWords.Contains(fmt)
            && !IsWord(tokens[^3], "as") && !IsWord(tokens[^3], "by") && tokens[^3] is not { Kind: Token.Symbol, Value: "," })
            throw Bad("A query can't choose its output format; remove the FORMAT part.");
        for (var i = 0; i + 1 < tokens.Count; i++)
            if (IsWord(tokens[i], "into") && IsWord(tokens[i + 1], "outfile")) throw Bad("A query can't write a file; remove the INTO OUTFILE part.");
    }

    // A name (bare or quoted) followed by '(': a blocked table function anywhere, and where a table goes, anything not allowed.
    private static void CheckFunctions(List<(Token Kind, string Value)> tokens)
    {
        var fromAt = new HashSet<int>(); // depths whose FROM list is open
        var query = new Stack<bool>([true]); // per depth: a query (the top level, or brackets that start with SELECT / WITH), not a call such as EXTRACT(YEAR FROM d)
        var depth = 0;
        for (var i = 0; i < tokens.Count; i++)
        {
            var t = tokens[i];
            if (t is { Kind: Token.Symbol, Value: "(" }) { depth++; query.Push(i + 1 < tokens.Count && (IsWord(tokens[i + 1], "select") || IsWord(tokens[i + 1], "with"))); continue; }
            if (t is { Kind: Token.Symbol, Value: ")" }) { fromAt.Remove(depth); depth--; if (query.Count > 1) query.Pop(); continue; }
            if (query.Peek() && (IsWord(t, "from") || IsWord(t, "join")) && !(i > 0 && IsWord(tokens[i - 1], "array")) && !(i > 1 && IsWord(tokens[i - 1], "left") && IsWord(tokens[i - 2], "array")))
            { fromAt.Add(depth); if (IsSource(i + 1)) CheckSource(i + 1); continue; }
            if (t.Kind == Token.Word && EndsFrom.Contains(t.Value)) { fromAt.Remove(depth); continue; }
            if (t is { Kind: Token.Symbol, Value: "," } && fromAt.Contains(depth) && IsSource(i + 1)) { CheckSource(i + 1); continue; }
            if (NameOf(t) is { } name && i + 1 < tokens.Count && tokens[i + 1] is { Kind: Token.Symbol, Value: "(" } && BlockedFunctions.Contains(name))
                throw Outside(name);
        }

        bool IsSource(int at) => at + 1 < tokens.Count && NameOf(tokens[at]) is not null && tokens[at + 1] is { Kind: Token.Symbol, Value: "(" };
        void CheckSource(int at)
        {
            var name = NameOf(tokens[at])!;
            if (!AllowedTableFunctions.Contains(name)) throw Outside(name);
        }
        static RequestValidationException Outside(string name) => Bad($"'{name}' reads outside this connection's tables and can't be used here.");
    }

    private enum Token { Word, Symbol, Literal, Name }

    /// <summary>Comments out, string / quoted-name contents kept verbatim. Throws on an unterminated string or comment.</summary>
    private static string Strip(string s)
    {
        var o = new StringBuilder(s.Length);
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (c is '\'' or '"' or '`') { var end = EndOfQuoted(s, i); o.Append(s, i, end - i); i = end - 1; continue; }
            if (c == '-' && i + 1 < s.Length && s[i + 1] == '-' || c == '#') { while (i < s.Length && s[i] != '\n') i++; o.Append('\n'); continue; }
            if (c == '/' && i + 1 < s.Length && s[i + 1] == '*')
            {
                var end = s.IndexOf("*/", i + 2, StringComparison.Ordinal);
                if (end < 0) throw Bad("A /* comment is never closed.");
                o.Append(' '); i = end + 1; continue;
            }
            o.Append(c);
        }
        return o.ToString();
    }

    // The index just after the quoted run that starts at `start` (a quote repeated inside it, or a backslash escape, does not end it — in backticks too).
    private static int EndOfQuoted(string s, int start)
    {
        var q = s[start];
        for (var i = start + 1; i < s.Length; i++)
        {
            if (s[i] == '\\') { i++; continue; } // ClickHouse reads a backslash escape inside ', " and ` alike
            if (s[i] == q) { if (i + 1 < s.Length && s[i + 1] == q) { i++; continue; } return i + 1; }
        }
        throw Bad(q == '\'' ? "A text value is missing its closing quote (')." : $"A name is missing its closing quote ({q}).");
    }

    private static IEnumerable<(Token Kind, string Value)> Tokens(string s)
    {
        for (var i = 0; i < s.Length;)
        {
            var c = s[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (c is '\'' or '"' or '`') { var end = EndOfQuoted(s, i); yield return (c == '\'' ? Token.Literal : Token.Name, s[i..end]); i = end; continue; }
            if (char.IsLetter(c) || c == '_') { var j = i + 1; while (j < s.Length && (char.IsLetterOrDigit(s[j]) || s[j] == '_')) j++; yield return (Token.Word, s[i..j]); i = j; continue; }
            if (char.IsDigit(c)) { var j = i + 1; while (j < s.Length && (char.IsLetterOrDigit(s[j]) || s[j] == '.' || s[j] == '_')) j++; yield return (Token.Literal, s[i..j]); i = j; continue; }
            yield return (Token.Symbol, c.ToString()); i++;
        }
    }

    private static RequestValidationException Bad(string message) => new(message, "source.sql");
}
