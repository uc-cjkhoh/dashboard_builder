using DashboardBuilder.ClickHouse;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>Common MySQL functions in the Edit SQL translator (D106): each is pinned by its exact ClickHouse text. The values these texts return were checked
/// against MySQL's documented results on a real server by <c>tests/live/translate-smoke.mjs</c> (the "fn:" cases); these tests keep the text from drifting.</summary>
public class SqlFunctionTests
{
    private static readonly string Tools = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src", "DashboardBuilder", "Tools"));
    private static SqlTranslator Tr() => new(Tools, "python3", null);
    private static async Task<TranslateResult> My(string sql) => await Tr().TranslateAsync(sql, "mysql", "clickhouse", default);
    private static async Task<string> My2Ch(string sql) => (await My(sql)).Sql;
    private static async Task<string> Refused(string sql) => (await Assert.ThrowsAsync<SqlTranslateException>(() => My2Ch(sql))).Message;

    [Fact] public async Task CONCAT_WS_skips_NULL_arguments_instead_of_doubling_the_separator()
        => Assert.Equal("SELECT arrayStringConcat(arrayFilter(x -> isNotNull(x), [toString(a), 'x', toString(b)]), '-') FROM t", await My2Ch("SELECT CONCAT_WS('-', a, 'x', b) FROM t"));

    [Fact] public async Task UPPER_and_LOWER_use_the_UTF8_forms_and_a_comparison_with_LOWER_is_not_lowered_twice()
    {
        Assert.Equal("SELECT upperUTF8(a), lowerUTF8(b) FROM t", await My2Ch("SELECT UPPER(a), LCASE(b) FROM t"));
        Assert.Equal("SELECT x FROM t WHERE lowerUTF8(a) = lowerUTF8('ABC')", await My2Ch("SELECT x FROM t WHERE LOWER(a) = 'ABC'"));
    }

    [Fact] public async Task REGEXP_ignores_case_with_a_leading_flag_unless_the_match_type_says_c()
    {
        var r = await My("SELECT a REGEXP 'x', a RLIKE p, REGEXP_LIKE(a, '^b', 'c') FROM t");
        Assert.Equal("SELECT match(a, '(?i)x'), match(a, concat('(?i)', p)), match(a, '^b') FROM t", r.Sql);
        Assert.Contains("regexp-ci", r.Changes);
        Assert.Equal("SELECT replaceRegexpAll(a, '(?i)(x)', '\\\\1-') FROM t", await My2Ch("SELECT REGEXP_REPLACE(a, '(x)', '$1-') FROM t")); // $1 is \1 in ClickHouse
        Assert.Equal("SELECT if(match(a, '(?i)x'), extract(a, '(?i)x'), NULL) FROM t", await My2Ch("SELECT REGEXP_SUBSTR(a, 'x') FROM t"));      // no match: NULL, not ''
        Assert.Contains("match type", await Refused("SELECT REGEXP_LIKE(a, 'x', 'm') FROM t"));
        Assert.Contains("start position", await Refused("SELECT REGEXP_REPLACE(a, 'x', 'y', 2) FROM t"));
    }

    [Fact] public async Task ROUND_and_CAST_AS_SIGNED_of_a_decimal_literal_round_half_away_from_zero_as_MySQLs_exact_numbers_do()
    {
        var r = await My("SELECT ROUND(2.5), ROUND(-2.567, 2), ROUND(a, 1), CAST(2.5 AS SIGNED) FROM t");
        Assert.Equal("SELECT ROUND(toDecimal128('2.5', 1)), ROUND(toDecimal128('-2.567', 3), 2), ROUND(a, 1), CAST(round(toDecimal128('2.5', 1)) AS Nullable(Int64)) FROM t", r.Sql);
        Assert.Contains("round-half-away", r.Changes);
        Assert.Single(await Warn("SELECT CAST(a AS SIGNED) FROM t"));                      // a column's fraction is cut in ClickHouse: said so
        Assert.Empty(await Warn("SELECT CAST('5' AS SIGNED), CAST(5 AS SIGNED) FROM t"));  // text and whole numbers are the same in both
    }
    private static async Task<IReadOnlyList<string>> Warn(string sql) => (await My(sql)).Warnings;

    [Fact] public async Task GREATEST_and_LEAST_answer_NULL_when_an_argument_is_NULL()
    {
        var r = await My("SELECT GREATEST(a, b), LEAST(1, 2) FROM t");
        Assert.Equal("SELECT if(isNull(a) OR isNull(b), NULL, greatest(a, b)), least(1, 2) FROM t", r.Sql);
        Assert.Contains("null-aware", r.Changes);
    }

    [Fact] public async Task Bit_operators_work_on_unsigned_64_bit_numbers_through_the_bit_functions()
    {
        var r = await My("SELECT a & b, a | 1, a ^ b, a << 2, a >> 1, ~a, BIT_COUNT(a) FROM t");
        Assert.Equal("SELECT bitAnd(toUInt64(a), toUInt64(b)), bitOr(toUInt64(a), toUInt64(1)), bitXor(toUInt64(a), toUInt64(b)), bitShiftLeft(toUInt64(a), toUInt64(2)), "
            + "bitShiftRight(toUInt64(a), toUInt64(1)), bitNot(toUInt64(a)), bitCount(toUInt64(a)) FROM t", r.Sql);
        Assert.Contains("bit-ops", r.Changes);
    }

    [Fact] public async Task GROUP_CONCAT_keeps_the_separator_order_distinct_and_NULL_handling_and_says_about_the_1024_cut()
    {
        var plain = await My("SELECT GROUP_CONCAT(a) FROM t");
        Assert.Equal("SELECT if(countIf(isNotNull(a)) = 0, NULL, arrayStringConcat(groupArrayIf(toString(a), isNotNull(a)), ',')) FROM t", plain.Sql); // MySQL's default separator is ','
        Assert.Contains(plain.Warnings, w => w.Contains("1024"));
        Assert.Contains("group-concat", plain.Changes);
        Assert.Equal("SELECT if(countIf(isNotNull(a)) = 0, NULL, arrayStringConcat(arrayMap(t -> tupleElement(t, 1), arrayReverseSort(t -> tupleElement(t, 2), "
            + "arrayDistinct(groupArrayIf(tuple(toString(a), tuple(isNotNull(b), b)), isNotNull(a))))), ';')) FROM t",
            await My2Ch("SELECT GROUP_CONCAT(DISTINCT a ORDER BY b DESC SEPARATOR ';') FROM t"));
        Assert.Contains("ascending and others descending", await Refused("SELECT GROUP_CONCAT(a ORDER BY b, c DESC) FROM t"));
    }

    [Fact] public async Task Text_helpers_ignore_case_and_answer_NULL_as_MySQL_does()
    {
        var r = await My("SELECT ELT(n, a, b), FIND_IN_SET(a, b), FIELD(a, 'x', 'y'), STRCMP(a, b) FROM t");
        Assert.Equal("SELECT if(n >= 1 AND n <= 2, arrayElement([toString(a), toString(b)], n), NULL), "
            + "if(isNull(a) OR isNull(b), NULL, indexOf(splitByChar(',', lowerUTF8(toString(b))), lowerUTF8(toString(a)))), "
            + "indexOf([lowerUTF8('x'), lowerUTF8('y')], lowerUTF8(toString(a))), "
            + "if(isNull(a) OR isNull(b), NULL, multiIf(lowerUTF8(toString(a)) < lowerUTF8(toString(b)), -1, lowerUTF8(toString(a)) = lowerUTF8(toString(b)), 0, 1)) FROM t", r.Sql);
        Assert.Contains("case-fold", r.Changes);
    }

    [Fact] public async Task SHA_functions_are_hex_text_and_FORMAT_is_refused()
    {
        Assert.Equal("SELECT lower(hex(SHA1(a))), lower(hex(SHA512(a))), lower(hex(SHA256(a))) FROM t", await My2Ch("SELECT SHA1(a), SHA2(a, 512), SHA2(a, 0) FROM t"));
        Assert.Contains("SHA2", await Refused("SELECT SHA2(a, 100) FROM t"));
        Assert.Contains("FORMAT", await Refused("SELECT FORMAT(a, 2) FROM t"));
    }

    [Fact] public async Task Date_part_functions_follow_MySQLs_numbering_and_take_date_text()
    {
        Assert.Equal("SELECT (modulo(toDayOfWeek(CAST(d AS Nullable(DATE))), 7) + 1), (toDayOfWeek(CAST(d AS Nullable(DATE))) - 1), dateName('month', CAST(d AS Nullable(DATE))), "
            + "dateName('weekday', CAST(d AS Nullable(DATE))), (toRelativeDayNum(CAST(d AS Nullable(DATE))) + 719528) FROM t",
            await My2Ch("SELECT DAYOFWEEK(d), WEEKDAY(d), MONTHNAME(d), DAYNAME(d), TO_DAYS(d) FROM t")); // Sunday = 1 / Monday = 0; TO_DAYS counts from year 0
        Assert.Equal("SELECT QUARTER(toDate('2024-03-05')), HOUR(toDateTime('2024-03-05 10:00:00')), EXTRACT(YEAR FROM toDate('2024-03-05')), toDateTime('2024-03-05') FROM t",
            await My2Ch("SELECT QUARTER('2024-03-05'), HOUR('2024-03-05 10:00:00'), EXTRACT(YEAR FROM '2024-03-05'), TIMESTAMP('2024-03-05') FROM t"));
        Assert.Equal("SELECT d + INTERVAL 1 DAY, d - INTERVAL 2 MONTH, d + toIntervalDay(n) FROM t", await My2Ch("SELECT ADDDATE(d, 1), SUBDATE(d, INTERVAL 2 MONTH), TIMESTAMPADD(DAY, n, d) FROM t"));
        Assert.Contains("two arguments", await Refused("SELECT TIMESTAMP(d, t) FROM t"));
    }
}
