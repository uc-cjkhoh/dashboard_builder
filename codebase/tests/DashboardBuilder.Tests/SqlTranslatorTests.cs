using System.Net;
using System.Net.Http.Json;
using DashboardBuilder.ClickHouse;
using DashboardBuilder.Features.Rows;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>The Edit SQL dialect switch (D106): sqlglot run as a child process, its answers, its refusals, its limits. These run the real script
/// and vendored library from <c>src/DashboardBuilder/Tools</c> (they need <c>python3</c>, as the server does).</summary>
public class SqlTranslatorTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public SqlTranslatorTests(WebApplicationFactory<Program> factory) => _factory = factory;

    private static readonly string Tools = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src", "DashboardBuilder", "Tools"));
    private static SqlTranslator Tr(string? python = null, TimeSpan? timeout = null, string? tools = null) => new(tools ?? Tools, python ?? "python3", timeout);
    private static async Task<string> My2Ch(string sql) => (await Tr().TranslateAsync(sql, "mysql", "clickhouse", default)).Sql;
    private static async Task<IReadOnlyList<string>> Warn(string sql) => (await Tr().TranslateAsync(sql, "mysql", "clickhouse", default)).Warnings;
    private static async Task<IReadOnlyList<string>> Changes(string sql) => (await Tr().TranslateAsync(sql, "mysql", "clickhouse", default)).Changes;

    [Fact] public async Task MySQL_functions_and_limits_become_their_ClickHouse_forms()
    {
        var ch = await My2Ch("SELECT IFNULL(a, 0) AS x, DATE_FORMAT(d, '%Y-%m') AS m FROM t LIMIT 5, 10");
        Assert.Contains("COALESCE(a, 0)", ch); Assert.Contains("formatDateTime(d, '%Y-%m')", ch); Assert.EndsWith("LIMIT 10 OFFSET 5", ch);
    }
    [Fact] public async Task A_MySQL_double_quoted_text_is_a_string_in_ClickHouse()
        => Assert.Equal("SELECT * FROM t WHERE x ILIKE 'abc'", await My2Ch("SELECT * FROM t WHERE x LIKE \"abc\"")); // a string, not a name: it reached ILIKE as one
    [Fact] public async Task A_simple_ClickHouse_query_reads_as_MySQL()
    {
        var my = (await Tr().TranslateAsync("SELECT cust_id, amount FROM `shop`.`orders` WHERE amount > 10 ORDER BY amount DESC LIMIT 5", "clickhouse", "mysql", default)).Sql;
        Assert.Equal("SELECT cust_id, amount FROM `shop`.`orders` WHERE amount > 10 ORDER BY amount DESC LIMIT 5", my);
    }
    [Fact] public async Task A_ClickHouse_only_function_does_not_survive_a_round_trip_so_the_browser_asks_ClickHouse_to_compare()
    {
        // toDate has no MySQL form: it comes back upper-cased, which ClickHouse (case-sensitive) would not know.
        var my = (await Tr().TranslateAsync("SELECT toDate(ts) FROM t", "clickhouse", "mysql", default)).Sql;
        Assert.Contains("TODATE(ts)", my);
        Assert.Contains("TODATE(ts)", await My2Ch(my));
    }
    // --- where sqlglot's plain output would run but mean something else (D106): each is pinned by its exact text -------------------------
    [Fact] public async Task DATEDIFF_is_a_minus_b_in_days_in_the_order_ClickHouse_takes()
        => Assert.Equal("SELECT dateDiff('day', b, a) FROM t", await My2Ch("SELECT DATEDIFF(a, b) FROM t")); // a - b: start = b, end = a
    [Fact] public async Task TIMESTAMPDIFF_counts_whole_units_with_age_for_days_and_up_and_elapsed_seconds_below()
    {
        // Checked on ClickHouse 26.8: age('hour', ...) is wrong there, so hours, minutes and seconds go through elapsed seconds.
        Assert.Equal("SELECT age('day', a, b), age('week', a, b), age('month', a, b), age('quarter', a, b), age('year', a, b) FROM t",
            await My2Ch("SELECT TIMESTAMPDIFF(DAY, a, b), TIMESTAMPDIFF(WEEK, a, b), TIMESTAMPDIFF(MONTH, a, b), TIMESTAMPDIFF(QUARTER, a, b), TIMESTAMPDIFF(YEAR, a, b) FROM t"));
        Assert.Equal("SELECT intDiv(dateDiff('second', a, b), 3600), intDiv(dateDiff('second', a, b), 60), dateDiff('second', a, b) FROM t",
            await My2Ch("SELECT TIMESTAMPDIFF(HOUR, a, b), TIMESTAMPDIFF(MINUTE, a, b), TIMESTAMPDIFF(SECOND, a, b) FROM t"));
        Assert.Contains("FRAC_SECOND", (await Assert.ThrowsAsync<SqlTranslateException>(() => My2Ch("SELECT TIMESTAMPDIFF(FRAC_SECOND, a, b) FROM t"))).Message);
        Assert.Contains("MICROSECOND", (await Assert.ThrowsAsync<SqlTranslateException>(() => My2Ch("SELECT TIMESTAMPDIFF(MICROSECOND, a, b) FROM t"))).Message);
    }
    [Fact] public async Task Date_arithmetic_becomes_plus_or_minus_an_interval_with_a_number()
    {
        Assert.Equal("SELECT d + INTERVAL 1 MONTH, NOW() - INTERVAL 7 DAY FROM t", await My2Ch("SELECT DATE_ADD(d, INTERVAL 1 MONTH), DATE_SUB(NOW(), INTERVAL 7 DAY) FROM t"));
        Assert.Equal("SELECT d + INTERVAL 1 DAY, d - INTERVAL 2 HOUR FROM t", await My2Ch("SELECT d + INTERVAL '1' DAY, d - INTERVAL '2' HOUR FROM t"));
        Assert.Contains("YEAR_MONTH", (await Assert.ThrowsAsync<SqlTranslateException>(() => My2Ch("SELECT DATE_ADD(d, INTERVAL '1-2' YEAR_MONTH) FROM t"))).Message);
        Assert.Contains("plain number", (await Assert.ThrowsAsync<SqlTranslateException>(() => My2Ch("SELECT DATE_ADD(d, INTERVAL n DAY) FROM t"))).Message);
    }
    [Fact] public async Task A_double_pipe_is_refused_because_it_means_OR_in_MySQL_and_joining_text_in_ClickHouse()
    {
        var ex = await Assert.ThrowsAsync<SqlTranslateException>(() => My2Ch("SELECT a ||\n  b FROM t"));
        Assert.Contains("CONCAT", ex.Message); Assert.Equal((1, 11, 9), (ex.Failure.Line, ex.Failure.Col, ex.Failure.Start));
        Assert.Equal("SELECT a OR b FROM t", await My2Ch("SELECT a OR b FROM t"));
        Assert.Contains("'x||y'", await My2Ch("SELECT 'x||y' AS s")); // inside text it is just text
    }
    [Fact] public async Task LIKE_ignores_case_as_in_MySQL_so_it_becomes_ILIKE_keeping_NOT_and_ESCAPE()
    {
        Assert.Equal("SELECT 1 FROM t WHERE y ILIKE 'a%' AND z NOT ILIKE '%b' AND NOT (w ILIKE 'x')", await My2Ch("SELECT 1 FROM t WHERE y LIKE 'a%' AND z NOT LIKE '%b' AND NOT (w LIKE 'x')"));
        Assert.Contains("ESCAPE", await My2Ch("SELECT 1 FROM t WHERE y LIKE 'a#_%' ESCAPE '#'"));
    }
    [Fact] public async Task Text_comparisons_ignore_case_as_in_MySQL_by_comparing_the_lower_cased_text_of_any_column_type()
    {
        Assert.Equal("SELECT a FROM t WHERE lowerUTF8(toString(x)) = lowerUTF8('abc')", await My2Ch("SELECT a FROM t WHERE x = 'abc'"));
        Assert.Equal("SELECT a FROM t WHERE lowerUTF8(toString(x)) <> lowerUTF8('Z')", await My2Ch("SELECT a FROM t WHERE x != 'Z'"));
        Assert.Equal("SELECT a FROM t WHERE lowerUTF8('abc') = lowerUTF8(toString(x))", await My2Ch("SELECT a FROM t WHERE 'abc' = x")); // the literal on the left
        Assert.Equal("SELECT a FROM t WHERE lowerUTF8(toString(k)) IN (lowerUTF8('p'), lowerUTF8('Q'))", await My2Ch("SELECT a FROM t WHERE k IN ('p', 'Q')"));
        Assert.Equal("SELECT a FROM t WHERE NOT (lowerUTF8(toString(k)) IN (lowerUTF8('p'), lowerUTF8('Q')))", await My2Ch("SELECT a FROM t WHERE k NOT IN ('p', 'Q')"));
        Assert.Equal(["case-fold"], await Changes("SELECT a FROM t WHERE x = 'abc'"));
        var note = await Warn("SELECT a FROM t WHERE x = 'abc'");
        Assert.Single(note); Assert.Contains("ignore upper/lower case", note[0]); Assert.Contains("slower", note[0]); Assert.Contains("accents", note[0]);
    }
    [Fact] public async Task A_comparison_is_left_alone_when_folding_would_break_or_mean_nothing()
    {
        foreach (var same in new[]
        {
            "SELECT a FROM t WHERE n = 5", "SELECT a FROM t WHERE c = '123'", "SELECT a FROM t WHERE d = ''", "SELECT a FROM t WHERE d = '2024-01-01T10:00:00'",
            "SELECT a FROM t WHERE d = '2024-01-01 10:00:00'", "SELECT a FROM t WHERE e = '1e5'", "SELECT a FROM t WHERE e = '0xFF'", "SELECT a FROM t WHERE 'a' = 'B'",
            "SELECT a FROM t WHERE k IN ('p', 5)", "SELECT a FROM t WHERE v IN (SELECT 1)", "SELECT a FROM t WHERE (SELECT 1) = 'A'", "SELECT a FROM t WHERE z = NULL",
            "SELECT a FROM t WHERE f > 'a'", "SELECT a FROM t",
        })
        {
            Assert.Equal(same, await My2Ch(same));
            Assert.Empty(await Warn(same));
            Assert.DoesNotContain("case-fold", await Changes(same));
        }
        Assert.Equal("SELECT a FROM t WHERE LOWER(n) = 'x'", await My2Ch("SELECT a FROM t WHERE LOWER(n) = 'x'")); // LOWER() already ignores case
    }
    [Fact] public async Task DIV_by_zero_is_NULL_as_in_MySQL_and_the_repairs_that_change_meaning_are_reported()
    {
        Assert.Equal("SELECT CAST(5 / nullIf(b, 0) AS Nullable(Int64)), a / nullIf(b, 0), a % nullIf(b, 0) FROM t", await My2Ch("SELECT 5 DIV b, a / b, a % b FROM t"));
        Assert.Equal(["div-null"], await Changes("SELECT 5 DIV b, a / b FROM t"));
        Assert.Equal(["nulls-first"], await Changes("SELECT a FROM t ORDER BY a"));
        Assert.Equal(["ilike"], await Changes("SELECT a FROM t WHERE x LIKE 'a%'"));
        Assert.Equal(["case-fold", "div-null", "ilike", "nulls-first"], await Changes("SELECT a / b FROM t WHERE x = 'q' AND y LIKE 'a%' ORDER BY a"));
        Assert.Empty(await Changes("SELECT DATEDIFF(a, b), DATE_ADD(d, INTERVAL 1 DAY), IFNULL(a, 0) FROM t")); // form-only repairs are not meaning changes
    }
    [Fact] public async Task A_ClickHouse_comparison_comes_back_from_MySQL_ignoring_case_so_the_round_trip_reports_a_change()
    {
        // ClickHouse `x = 'abc'` is case-sensitive; read as MySQL and translated back it ignores case. The columns do not change, the rows do.
        var my = (await Tr().TranslateAsync("SELECT a FROM t WHERE x = 'abc'", "clickhouse", "mysql", default)).Sql;
        var back = await Tr().TranslateAsync(my, "mysql", "clickhouse", default);
        Assert.Contains("lowerUTF8(toString(x))", back.Sql);
        Assert.Contains("case-fold", back.Changes);
    }
    [Fact] public async Task A_ClickHouse_LIKE_comes_back_from_MySQL_as_ILIKE_which_ignores_case_so_the_browser_must_not_trust_that_round_trip()
    {
        // ClickHouse LIKE is case-sensitive. MySQL's is not, so MySQL -> ClickHouse writes ILIKE: the round trip changes which rows match.
        var my = (await Tr().TranslateAsync("SELECT a FROM t WHERE x LIKE 'A%'", "clickhouse", "mysql", default)).Sql;
        Assert.Contains("LIKE 'A%'", my); Assert.DoesNotContain("ILIKE", my);
        Assert.Contains("x ILIKE 'A%'", await My2Ch(my));
    }
    [Fact] public async Task A_trailing_semicolon_is_dropped() => Assert.Equal("SELECT 1", await My2Ch("SELECT 1;"));

    [Fact] public async Task A_query_that_cannot_be_read_says_where()
    {
        var ex = await Assert.ThrowsAsync<SqlTranslateException>(() => My2Ch("SELECT a FROM t WHERE ("));
        Assert.Contains("unfinished", ex.Message);
        Assert.Equal((1, 23, 22), (ex.Failure.Line, ex.Failure.Col, ex.Failure.Start));
        var ex2 = await Assert.ThrowsAsync<SqlTranslateException>(() => My2Ch("SELECT a,\n  b FROM t WHERE a = 1 AND"));
        Assert.Equal(2, ex2.Failure.Line);
    }
    [Fact] public async Task Two_queries_are_refused() => Assert.Contains("Only one query", (await Assert.ThrowsAsync<SqlTranslateException>(() => My2Ch("SELECT 1; SELECT 2"))).Message);

    [Fact] public async Task The_request_is_validated_before_anything_runs()
    {
        async Task<string?> Field(string sql, string from = "mysql", string to = "clickhouse") { try { await Tr().TranslateAsync(sql, from, to, default); return null; } catch (RequestValidationException e) { return e.Field; } }
        Assert.Equal("sql", await Field(""));
        Assert.Equal("sql", await Field("   "));
        Assert.Equal("sql", await Field(new string('x', ApiLimits.MaxCustomSqlChars + 1)));
        Assert.Equal("from", await Field("SELECT 1", "mysql", "mysql"));
        Assert.Equal("from", await Field("SELECT 1", "oracle", "clickhouse"));
        Assert.Equal("from", await Field("SELECT 1", "mysql", "'; drop"));
    }
    [Fact] public async Task The_text_goes_over_stdin_so_quotes_and_shell_characters_are_just_text()
        => Assert.Contains("'$(touch /tmp/x); `id` \"q\"'", await My2Ch("SELECT '$(touch /tmp/x); `id` \"q\"' AS s"));

    [Fact] public async Task A_server_without_the_tools_or_python_says_so()
    {
        await Assert.ThrowsAsync<SqlTranslatorUnavailableException>(() => Tr(tools: Path.Combine(Path.GetTempPath(), "no-such-tools")).TranslateAsync("SELECT 1", "mysql", "clickhouse", default));
        await Assert.ThrowsAsync<SqlTranslatorUnavailableException>(() => Tr(python: "no-such-python-binary").TranslateAsync("SELECT 1", "mysql", "clickhouse", default));
    }
    [Fact] public async Task A_translation_that_takes_too_long_is_stopped()
        => Assert.Contains("too long", (await Assert.ThrowsAsync<RequestValidationException>(() => Tr(timeout: TimeSpan.FromMilliseconds(1)).TranslateAsync("SELECT 1", "mysql", "clickhouse", default))).Message);

    [Fact] public void The_script_s_answers_become_results_or_the_right_exception()
    {
        Assert.Equal("SELECT 1", SqlTranslator.Interpret("""{"ok": true, "sql": "SELECT 1"}""").Sql);
        var withWarnings = SqlTranslator.Interpret("""{"ok": true, "sql": "SELECT 1", "warnings": ["a", "", "b"]}""");
        Assert.Equal(["a", "b"], withWarnings.Warnings); Assert.Empty(SqlTranslator.Interpret("""{"ok": true, "sql": "SELECT 1"}""").Warnings);
        Assert.Equal(["ilike"], SqlTranslator.Interpret("""{"ok": true, "sql": "SELECT 1", "changes": ["ilike", ""]}""").Changes); Assert.Empty(SqlTranslator.Interpret("""{"ok": true, "sql": "SELECT 1"}""").Changes);
        Assert.Throws<SqlTranslatorUnavailableException>(() => SqlTranslator.Interpret("not json"));
        Assert.Throws<SqlTranslatorUnavailableException>(() => SqlTranslator.Interpret("""{"ok": false, "kind": "missing", "error": "x"}"""));
        Assert.Throws<SqlTranslatorUnavailableException>(() => SqlTranslator.Interpret(""));
        var e = Assert.Throws<SqlTranslateException>(() => SqlTranslator.Interpret("""{"ok": false, "kind": "unsupported", "error": "No equivalent."}"""));
        Assert.Equal("No equivalent.", e.Message); Assert.Null(e.Failure.Line);
        Assert.Throws<SqlTranslateException>(() => SqlTranslator.Interpret("""{"ok": true, "sql": ""}"""));
    }

    // --- the endpoint -----------------------------------------------------------------------------------------------------
    [Fact] public async Task Translate_without_a_connection_is_409()
        => Assert.Equal(HttpStatusCode.Conflict, (await _factory.CreateClient().PostAsJsonAsync("/api/sql/translate", new { sql = "SELECT 1", from = "mysql", to = "clickhouse" })).StatusCode);
    [Fact] public async Task Translate_only_accepts_post()
        => Assert.Equal(HttpStatusCode.MethodNotAllowed, (await _factory.CreateClient().GetAsync("/api/sql/translate")).StatusCode);

    // --- the controller, in process (a fake in-memory session stands in for the connection) ----------------------------------
    private sealed class MemorySession : ISession
    {
        private readonly Dictionary<string, byte[]> _d = [];
        public bool IsAvailable => true; public string Id => "t"; public IEnumerable<string> Keys => _d.Keys;
        public void Clear() => _d.Clear(); public Task CommitAsync(CancellationToken c = default) => Task.CompletedTask; public Task LoadAsync(CancellationToken c = default) => Task.CompletedTask;
        public void Remove(string key) => _d.Remove(key); public void Set(string key, byte[] value) => _d[key] = value;
        public bool TryGetValue(string key, out byte[]? value) => _d.TryGetValue(key, out value);
    }
    private static async Task<(int Status, System.Text.Json.JsonElement Body)> Post(TranslateRequest req, bool connected = true, SqlTranslator? translator = null)
    {
        var ctx = new DefaultHttpContext();
        ctx.Features.Set<Microsoft.AspNetCore.Http.Features.ISessionFeature>(new Microsoft.AspNetCore.Http.Features.DefaultSessionFeature { Session = new MemorySession() });
        var registry = new ConnectionRegistry(new HttpContextAccessor { HttpContext = ctx });
        if (connected) registry.Save(new ClickHouseConnectionInfo("h", 8443, "u", "p", true, false));
        var gw = new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance);
        var controller = new SqlController(registry, gw, NullLoggerFactory.Instance, translator ?? Tr()) { ControllerContext = new ControllerContext { HttpContext = ctx } };
        var result = await controller.Translate(req, default);
        ctx.Response.Body = new MemoryStream();
        ctx.RequestServices = new ServiceCollection().AddLogging().BuildServiceProvider();
        await result.ExecuteAsync(ctx);
        ctx.Response.Body.Position = 0;
        return (ctx.Response.StatusCode, System.Text.Json.JsonDocument.Parse(await new StreamReader(ctx.Response.Body).ReadToEndAsync()).RootElement.Clone());
    }

    [Fact] public async Task The_endpoint_answers_the_translated_query()
    {
        var (status, body) = await Post(new("SELECT IFNULL(a, 0) FROM t LIMIT 2, 3", "mysql", "clickhouse"));
        Assert.Equal(200, status); Assert.Equal("SELECT COALESCE(a, 0) FROM t LIMIT 3 OFFSET 2", body.GetProperty("sql").GetString());
        Assert.Equal(0, body.GetProperty("warnings").GetArrayLength()); Assert.Equal(0, body.GetProperty("changes").GetArrayLength());
        var (_, warned) = await Post(new("SELECT a FROM t WHERE name = 'abc'", "mysql", "clickhouse"));
        Assert.Equal(1, warned.GetProperty("warnings").GetArrayLength()); Assert.Equal("case-fold", warned.GetProperty("changes")[0].GetString());
    }
    [Fact] public async Task The_endpoint_places_a_parse_error()
    {
        var (status, body) = await Post(new("SELECT a FROM t WHERE (", "mysql", "clickhouse"));
        Assert.Equal(400, status);
        Assert.Equal("sql", body.GetProperty("field").GetString()); Assert.Equal(1, body.GetProperty("line").GetInt32()); Assert.Equal(22, body.GetProperty("start").GetInt32());
        Assert.Contains("unfinished", body.GetProperty("error").GetString());
    }
    [Fact] public async Task The_endpoint_refuses_a_bad_dialect_pair_a_missing_session_and_a_server_without_python()
    {
        var (s1, b1) = await Post(new("SELECT 1", "mysql", "oracle")); Assert.Equal(400, s1); Assert.Equal("from", b1.GetProperty("field").GetString());
        Assert.Equal(409, (await Post(new("SELECT 1", "mysql", "clickhouse"), connected: false)).Status);
        var (s3, b3) = await Post(new("SELECT 1", "mysql", "clickhouse"), translator: Tr(python: "no-such-python-binary"));
        Assert.Equal(503, s3); Assert.Contains("Python 3", b3.GetProperty("error").GetString());
    }
}
