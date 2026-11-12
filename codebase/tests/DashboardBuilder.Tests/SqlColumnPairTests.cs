using DashboardBuilder.ClickHouse;
using DashboardBuilder.Features.Rows;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary><c>col = col</c> in MySQL text (D106): MySQL ignores case for text, ClickHouse does not, and only the columns' types say whether it matters. The translator lists each
/// such comparison as a probe, <see cref="SqlController"/> has ClickHouse describe the two columns (against a stub here), and the comparison is folded when both are text.</summary>
public class SqlColumnPairTests
{
    private static readonly string Tools = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src", "DashboardBuilder", "Tools"));
    private const string Join = "SELECT a.n FROM orders AS a JOIN customers AS b ON a.cust = b.name";

    private static async Task<(string Sql, string[] Changes, int Warnings, StubClickHouse Stub)> Run(string sql, Func<string, StubClickHouse.Result> describe)
    {
        var stub = new StubClickHouse(s => s.StartsWith("DESCRIBE TABLE", StringComparison.Ordinal) ? describe(s) : new StubClickHouse.Result([], []));
        var ctx = new DefaultHttpContext();
        ctx.Features.Set<Microsoft.AspNetCore.Http.Features.ISessionFeature>(new Microsoft.AspNetCore.Http.Features.DefaultSessionFeature { Session = new SqlTranslatorTests.MemorySession() });
        var registry = new ConnectionRegistry(new HttpContextAccessor { HttpContext = ctx });
        registry.Save(new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false));
        var controller = new SqlController(registry, new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance), NullLoggerFactory.Instance, new SqlTranslator(Tools, "python3", null))
            { ControllerContext = new ControllerContext { HttpContext = ctx } };
        var result = await controller.Translate(new TranslateRequest(sql, "mysql", "clickhouse"), default);
        ctx.Response.Body = new MemoryStream();
        ctx.RequestServices = new ServiceCollection().AddLogging().BuildServiceProvider();
        await result.ExecuteAsync(ctx);
        ctx.Response.Body.Position = 0;
        var body = System.Text.Json.JsonDocument.Parse(await new StreamReader(ctx.Response.Body).ReadToEndAsync()).RootElement;
        return (body.GetProperty("sql").GetString()!, body.GetProperty("changes").EnumerateArray().Select(x => x.GetString()!).ToArray(), body.GetProperty("warnings").GetArrayLength(), stub);
    }
    private static StubClickHouse.Result Types(string l, string r) => new([new("name", "String"), new("type", "String")], [["l", l], ["r", r]]);

    [Fact] public async Task Two_text_columns_are_compared_without_regard_to_case_as_in_MySQL()
    {
        var (sql, changes, warnings, stub) = await Run(Join, _ => Types("String", "LowCardinality(Nullable(String))"));
        using var _ = stub;
        Assert.Equal("SELECT a.n FROM orders AS a JOIN customers AS b ON lowerUTF8(toString(a.cust)) = lowerUTF8(toString(b.name))", sql);
        Assert.Contains("case-fold", changes); Assert.Equal(1, warnings);
        Assert.Single(stub.Statements, x => x.Sql.StartsWith("DESCRIBE TABLE", StringComparison.Ordinal)); // one probe for one comparison
        Assert.Contains("a.cust AS l, b.name AS r FROM orders AS a JOIN customers AS b", stub.Statements.Single(x => x.Sql.StartsWith("DESCRIBE TABLE", StringComparison.Ordinal)).Sql.Replace("\n", " "));
    }
    [Fact] public async Task Numbers_dates_and_a_text_against_a_number_are_left_as_written()
    {
        foreach (var (l, r) in new[] { ("Int32", "UInt64"), ("Date", "Date"), ("String", "Int32"), ("Array(String)", "Array(String)"), ("UUID", "UUID") })
        {
            var (sql, changes, warnings, stub) = await Run(Join, _ => Types(l, r));
            using var _ = stub;
            Assert.Equal("SELECT a.n FROM orders AS a JOIN customers AS b ON a.cust = b.name", sql);
            Assert.Empty(changes); Assert.Equal(0, warnings);
        }
    }
    [Fact] public async Task A_probe_ClickHouse_cannot_answer_leaves_the_comparison_alone()
    {
        var (sql, changes, _, stub) = await Run(Join, _ => throw new InvalidOperationException("no such column"));
        using var _ = stub;
        Assert.Equal("SELECT a.n FROM orders AS a JOIN customers AS b ON a.cust = b.name", sql); Assert.Empty(changes);
    }
    [Fact] public async Task A_comparison_with_a_literal_asks_nothing_and_the_other_comparisons_are_each_probed()
    {
        var (_, _, _, s1) = await Run("SELECT a FROM t WHERE x = 5 AND y = 'z'", _ => Types("String", "String"));
        using (s1) Assert.DoesNotContain(s1.Statements, x => x.Sql.StartsWith("DESCRIBE TABLE", StringComparison.Ordinal));
        var (sql, _, _, s2) = await Run("SELECT a FROM t WHERE x = y AND n != m", sql => sql.Contains("n AS l") ? Types("Int32", "Int32") : Types("String", "String"));
        using (s2)
        {
            Assert.Equal("SELECT a FROM t WHERE lowerUTF8(toString(x)) = lowerUTF8(toString(y)) AND n <> m", sql); // the text pair folds, the number pair does not
            Assert.Equal(2, s2.Statements.Count(x => x.Sql.StartsWith("DESCRIBE TABLE", StringComparison.Ordinal)));
        }
    }
    [Fact] public async Task Grouping_sorting_and_DISTINCT_on_a_text_column_say_that_ClickHouse_keeps_Open_and_open_apart()
    {
        StubClickHouse.Result One(string type) => new([new("name", "String"), new("type", "String")], [["l", type]]);
        var (sql, changes, warnings, stub) = await Run("SELECT region, COUNT(*) FROM orders GROUP BY region ORDER BY region", _ => One("LowCardinality(String)"));
        using (stub)
        {
            Assert.Equal("SELECT region, count(*) FROM orders GROUP BY region ORDER BY region NULLS FIRST", sql); // not rewritten: the output values would change
            Assert.Equal(1, warnings); Assert.Contains("nulls-first", changes);
            Assert.Single(stub.Statements, x => x.Sql.StartsWith("DESCRIBE TABLE", StringComparison.Ordinal)); // GROUP BY and ORDER BY on the same column ask once
        }
        var (_, _, numberWarnings, s2) = await Run("SELECT qty FROM orders GROUP BY qty", _ => One("UInt32"));
        using (s2) Assert.Equal(0, numberWarnings);
        var (_, _, distinctWarnings, s3) = await Run("SELECT DISTINCT region FROM orders", _ => One("String"));
        using (s3) Assert.Equal(1, distinctWarnings);
        var (_, _, aliasWarnings, s4) = await Run("SELECT UPPER(region) AS r FROM orders GROUP BY r", _ => throw new InvalidOperationException("unknown column")); // an alias: ClickHouse cannot type it here, so no note
        using (s4) Assert.Equal(0, aliasWarnings);
    }
    [Fact] public void Text_types_are_String_FixedString_and_Enum_also_inside_Nullable_and_LowCardinality()
    {
        foreach (var t in new[] { "String", "Nullable(String)", "LowCardinality(String)", "LowCardinality(Nullable(String))", "FixedString(4)", "Enum8('a' = 1)", "Nullable(Enum16('a' = 1))" })
            Assert.True(SqlController.IsText(t), t);
        foreach (var t in new[] { "Int32", "Array(String)", "UUID", "Date", "Nullable(Int8)", "Map(String, String)", "Tuple(String)" })
            Assert.False(SqlController.IsText(t), t);
    }
}
