using System.Text;

namespace DashboardBuilder.ClickHouse;

/// <summary>
/// The one place free-text SQL is accepted (D105): a card's "Edit SQL". The text becomes a derived table
/// (<c>FROM (…) AS t0</c>) inside the bounded, time-limited, <c>readonly=2</c> query every worksheet runs, so this guard only has to
/// keep it a single plain SELECT that cannot leave that wrapper or change the query's settings. Pure (no I/O), unit-tested.
/// Accepted: one statement starting with SELECT or WITH, comments stripped, balanced parentheses, no SETTINGS clause, no table
/// function that reaches outside the connection's own tables (url, file, s3, remote, mysql, …).
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
        CheckFunctions(tokens);
        return text;
    }

    // A word directly followed by '(' that names a blocked table function.
    private static void CheckFunctions(List<(Token Kind, string Value)> tokens)
    {
        for (var i = 0; i + 1 < tokens.Count; i++)
            if (tokens[i].Kind == Token.Word && tokens[i + 1] is { Kind: Token.Symbol, Value: "(" } && BlockedFunctions.Contains(tokens[i].Value))
                throw Bad($"'{tokens[i].Value}' reads outside this connection's tables and can't be used here.");
    }

    private enum Token { Word, Symbol, Literal }

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

    // The index just after the quoted run that starts at `start` (a quote repeated inside it, or a backslash escape, does not end it).
    private static int EndOfQuoted(string s, int start)
    {
        var q = s[start];
        for (var i = start + 1; i < s.Length; i++)
        {
            if (s[i] == '\\' && q != '`') { i++; continue; }
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
            if (c is '\'' or '"' or '`') { var end = EndOfQuoted(s, i); yield return (Token.Literal, s[i..end]); i = end; continue; }
            if (char.IsLetter(c) || c == '_') { var j = i + 1; while (j < s.Length && (char.IsLetterOrDigit(s[j]) || s[j] == '_')) j++; yield return (Token.Word, s[i..j]); i = j; continue; }
            if (char.IsDigit(c)) { var j = i + 1; while (j < s.Length && (char.IsLetterOrDigit(s[j]) || s[j] == '.' || s[j] == '_')) j++; yield return (Token.Literal, s[i..j]); i = j; continue; }
            yield return (Token.Symbol, c.ToString()); i++;
        }
    }

    private static RequestValidationException Bad(string message) => new(message, "source.sql");
}
