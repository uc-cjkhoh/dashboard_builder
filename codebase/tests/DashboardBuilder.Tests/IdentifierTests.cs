using DashboardBuilder.ClickHouse;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>
/// The highest-value unit tests in the project: identifier quoting is the injection defence
/// (CLAUDE.md golden rule 2 / decision D6). Feed it hostile db/table/column names and assert
/// each is neutralised into a single safe token.
/// </summary>
public class IdentifierTests
{
    [Theory]
    [InlineData("users", "`users`")]
    [InlineData("default", "`default`")]
    [InlineData("my table", "`my table`")]
    [InlineData("Column-1", "`Column-1`")]
    [InlineData("表", "`表`")]
    public void Quote_wraps_plain_identifiers(string raw, string expected)
        => Assert.Equal(expected, Identifier.Quote(raw));

    [Fact]
    public void Quote_escapes_internal_backtick()
        => Assert.Equal("`a\\`b`", Identifier.Quote("a`b"));

    [Fact]
    public void Quote_escapes_backslash_before_backtick()
        // input: a\`b  ->  backslash doubled, backtick escaped  ->  `a\\\`b`
        => Assert.Equal("`a\\\\\\`b`", Identifier.Quote("a\\`b"));

    [Theory]
    [InlineData("users`; DROP TABLE x; --")]
    [InlineData("`; DROP DATABASE default; `")]
    [InlineData("x` UNION ALL SELECT * FROM system.users `")]
    [InlineData("a`b`c`d")]
    [InlineData("\\`")]
    [InlineData("trailing backslash\\")]
    public void Quote_neutralises_injection_attempts(string hostile)
    {
        var quoted = Identifier.Quote(hostile);
        Assert.True(IsSingleSafeToken(quoted),
            $"Quoted form is not a single safe identifier token: {quoted}");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void Quote_rejects_null_or_empty(string? raw)
        => Assert.Throws<ArgumentException>(() => Identifier.Quote(raw!));

    [Fact]
    public void Quote_rejects_nul_character()
        => Assert.Throws<ArgumentException>(() => Identifier.Quote("a\0b"));

    [Fact]
    public void QualifiedName_quotes_both_parts()
        => Assert.Equal("`db`.`table`", Identifier.QualifiedName("db", "table"));

    [Fact]
    public void QualifiedName_neutralises_hostile_parts()
    {
        var q = Identifier.QualifiedName("d`b", "t`; DROP");
        var parts = SplitOnUnescapedDot(q);
        Assert.Equal(2, parts.Count);
        Assert.All(parts, p => Assert.True(IsSingleSafeToken(p), $"Unsafe part: {p}"));
    }

    /// <summary>
    /// True iff <paramref name="s"/> is exactly one backtick-quoted token: it starts and ends
    /// with a backtick and no interior backtick is left unescaped (every ` is preceded by an
    /// odd run of backslashes), so it cannot terminate the identifier early.
    /// </summary>
    private static bool IsSingleSafeToken(string s)
    {
        if (s.Length < 2 || s[0] != '`' || s[^1] != '`') return false;
        var inner = s[1..^1];
        for (var i = 0; i < inner.Length; i++)
        {
            if (inner[i] == '\\') { i++; continue; }  // skip the escaped char
            if (inner[i] == '`') return false;        // an unescaped backtick breaks out
        }
        return true;
    }

    /// <summary>Split <c>`a`.`b`</c> on the dot that sits between two quoted tokens.</summary>
    private static List<string> SplitOnUnescapedDot(string s)
    {
        var parts = new List<string>();
        var inQuote = false;
        var start = 0;
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (c == '\\') { i++; continue; }
            if (c == '`') inQuote = !inQuote;
            else if (c == '.' && !inQuote) { parts.Add(s[start..i]); start = i + 1; }
        }
        parts.Add(s[start..]);
        return parts;
    }
}
