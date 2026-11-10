using DashboardBuilder.ClickHouse;
using DashboardBuilder.ClickHouse.Calc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static DashboardBuilder.Tests.StubClickHouse;

namespace DashboardBuilder.Tests;

/// <summary>QueryAsync over a union / unpivot source against a stub ClickHouse endpoint (no real server): the statements it sends, the
/// bound values they carry, the refusals, the cache key and the request rules the CSV export shares.</summary>
public class SourceQueryTests
{
    private static readonly Dictionary<string, (string Name, string Type)[]> Tables = new()
    {
        ["a"] = [("region", "String"), ("amount", "Float64"), ("day", "Date")],
        ["b"] = [("region", "String"), ("amount", "Float64"), ("day", "Date")],
        ["real"] = [("x", "UInt64")],
        ["wide"] = [("k", "String"), ("q1", "Int32"), ("q2", "Int32")],
    };

    private static Result Answer(string sql)
    {
        if (sql.StartsWith("SHOW DATABASES")) return new([new Col("name", "String")], [["d"]]);
        if (sql.StartsWith("SHOW TABLES")) return new([new Col("name", "String")], Tables.Keys.Select(t => new object?[] { t }).ToArray());
        if (sql.StartsWith("DESCRIBE TABLE"))
        {
            var t = Tables.Keys.First(k => sql.EndsWith($"`{k}`", StringComparison.Ordinal));
            return new([new Col("name", "String"), new Col("type", "String")], Tables[t].Select(c => new object?[] { c.Name, c.Type }).ToArray());
        }
        if (sql.StartsWith("SELECT uniq(")) return new([new Col("u", "UInt64"), new Col("lo", "Date"), new Col("hi", "Date")], [[3, 19000, 19400]]);
        if (sql.StartsWith("SELECT count() FROM")) return new([new Col("n", "UInt64")], [[1]]);
        return new([new Col("k0", "String"), new Col("v0", "Float64")], [["north", 2.5]]);
    }

    private static QuerySource Union() => new("union", "d", "U", Tables: ["a", "b"]);
    private static QueryRequest Req(QuerySource? source = null, ColumnRef[]? rows = null, MeasureRef[]? measures = null, QueryFilter[]? filters = null, string? bucket = null) =>
        new(new TableRef("d", "U"), null, rows ?? [new ColumnRef("d", "U", "region")], null,
            measures ?? [new MeasureRef("d", "U", "amount", "sum")], filters, 10, null, DateBucket: bucket, Source: source ?? Union());

    private static async Task<(StubClickHouse Stub, QueryResult? Result)> Run(QueryRequest req)
    {
        var stub = new StubClickHouse(Answer);
        var gw = new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance);
        var info = new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false);
        var result = await gw.QueryAsync(info, req, default);
        return (stub, result);
    }
    private static List<Seen> Selects(StubClickHouse s) => s.Statements.Where(x => x.Sql.StartsWith("SELECT") && !x.Sql.StartsWith("SELECT version()")).ToList();
    private static string Carried(Seen s, string name) => s.Url + s.Form;

    [Fact] public async Task A_source_query_reads_the_derived_table_as_t0_and_binds_its_labels()
    {
        var (stub, result) = await Run(Req());
        using var _ = stub;
        var main = Selects(stub).Single();
        Assert.Contains("FROM (SELECT {us0:String} AS `Source table`, `region`, `amount`, `day` FROM `d`.`a` UNION ALL SELECT {us1:String} AS `Source table`, `region`, `amount`, `day` FROM `d`.`b`) AS t0", main.Sql);
        Assert.Contains("sum(t0.`amount`)", main.Sql);
        Assert.Contains("LIMIT 11", main.Sql);
        Assert.Contains("param_us0", Carried(main, "us0")); Assert.Contains("param_us1", Carried(main, "us1"));
        Assert.DoesNotContain("'a'", main.Sql);
        Assert.Equal("north", result!.Rows[0].Keys[0]);
    }
    [Fact] public async Task Filters_and_a_calculation_over_a_source_ride_with_the_same_parameters()
    {
        var calc = new BinNode("*", new FieldNode("d", "U", "amount"), new NumNode(2));
        var (stub, _) = await Run(Req(filters: [new QueryFilter("d", "U", "region", "=", "north")],
            measures: [new MeasureRef("d", "U", "Doubled", "sum", Calc: calc)]));
        using var s = stub;
        var main = Selects(stub).Single();
        Assert.Contains("WHERE t0.`region` = {p0:String}", main.Sql);
        Assert.Contains("sum((toFloat64(t0.`amount`) * {c0p0:Float64})) AS v0", main.Sql);
        foreach (var name in new[] { "param_us0", "param_us1", "param_p0", "param_c0p0" }) Assert.Contains(name, main.Url + main.Form);
    }
    [Fact] public async Task The_date_grain_probe_carries_the_source_and_its_parameters()
    {
        var (stub, _) = await Run(Req(rows: [new ColumnRef("d", "U", "day")], bucket: "auto"));
        using var s = stub;
        var probe = Selects(stub).First(x => x.Sql.StartsWith("SELECT uniq("));
        Assert.Contains("FROM (SELECT {us0:String} AS `Source table`", probe.Sql);
        Assert.Contains("param_us0", probe.Url + probe.Form); Assert.Contains("param_us1", probe.Url + probe.Form);
        Assert.DoesNotContain("param_us0", Selects(stub).First(x => x.Sql.StartsWith("SELECT uniq(")).Sql);
    }
    [Fact] public async Task A_total_statement_over_a_source_carries_the_parameters_too()
    {
        var (stub, _) = await Run(Req() with { WithTotal = true });
        using var s = stub;
        var count = Selects(stub).First(x => x.Sql.StartsWith("SELECT count() FROM"));
        Assert.Contains("{us0:String}", count.Sql); Assert.Contains("param_us1", count.Url + count.Form);
    }
    [Fact] public async Task An_unpivot_source_reads_one_arrayJoin_with_bound_field_names()
    {
        var src = new QuerySource("unpivot", "d", "P", Table: "wide", Columns: ["q1", "q2"], Keep: ["k"]);
        var (stub, _) = await Run(new QueryRequest(new TableRef("d", "P"), null, [new ColumnRef("d", "P", "Field")], null, [new MeasureRef("d", "P", "Value", "sum")], null, 10, null, Source: src));
        using var s = stub;
        var main = Selects(stub).Single();
        Assert.Contains("arrayJoin([({uf0:String}, `q1`), ({uf1:String}, `q2`)])", main.Sql);
        Assert.Contains("param_uf0", main.Url + main.Form);
    }
    [Fact] public async Task A_filter_on_a_real_table_inside_a_source_query_is_refused()
    {
        using var stub = new StubClickHouse(Answer);
        var gw = new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance);
        var info = new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false);
        var ex = await Assert.ThrowsAsync<UnknownIdentifierException>(() => gw.QueryAsync(info, Req(filters: [new QueryFilter("d", "real", "x", "=", "1")]), default));
        Assert.Equal("Field references a table not in the query.", ex.Message);
        Assert.Empty(Selects(stub));
    }
    [Fact] public async Task A_measure_or_dimension_on_a_real_table_inside_a_source_query_is_refused()
    {
        using var stub = new StubClickHouse(Answer);
        var gw = new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance);
        var info = new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false);
        var m = await Assert.ThrowsAsync<UnknownIdentifierException>(() => gw.QueryAsync(info, Req(measures: [new MeasureRef("d", "real", "x", "sum")]), default));
        Assert.Equal("Field references a table not in the query.", m.Message);
        var d = await Assert.ThrowsAsync<UnknownIdentifierException>(() => gw.QueryAsync(info, Req(rows: [new ColumnRef("d", "real", "x")]), default));
        Assert.Equal("Field references a table not in the query.", d.Message);
    }
    [Fact] public async Task An_unknown_column_is_named_in_the_message()
    {
        using var stub = new StubClickHouse(Answer);
        var gw = new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance);
        var info = new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false);
        var ex = await Assert.ThrowsAsync<UnknownIdentifierException>(() => gw.QueryAsync(info, Req(measures: [new MeasureRef("d", "U", "quantity_typo", "sum")]), default));
        Assert.Contains("quantity_typo", ex.Message);
        Assert.Contains("d.U", ex.Message);
    }
    [Fact] public void The_column_name_in_the_message_is_cleaned_and_cut()
    {
        var ex = UnknownIdentifierException.Column("a\nb\u2028c\u2029" + new string('x', 100));
        Assert.DoesNotContain("\n", ex.Message); Assert.DoesNotContain("\u2028", ex.Message); Assert.DoesNotContain("\u2029", ex.Message);
        Assert.True(ex.Message.Length < 100);
        Assert.Equal("Unknown column.", UnknownIdentifierException.Column("").Message);
    }
    [Fact] public async Task An_unknown_source_table_or_column_is_an_unknown_identifier()
    {
        using var stub = new StubClickHouse(Answer);
        var gw = new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance);
        var info = new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false);
        await Assert.ThrowsAsync<UnknownIdentifierException>(() => gw.QueryAsync(info, Req(new QuerySource("union", "d", "U", Tables: ["a", "ghost"])), default));
        await Assert.ThrowsAsync<UnknownIdentifierException>(() => gw.QueryAsync(info, Req(measures: [new MeasureRef("d", "U", "nope", "sum")]), default));
    }

    // --- cache key ---------------------------------------------------------------------------------------------------
    private static string Key(QueryRequest r) => ClickHouseGateway.CacheKey(new ClickHouseConnectionInfo("h", 1, "u", "p", false, false), r, 5000);
    [Fact] public void The_cache_key_differs_with_and_without_a_source_and_between_two_sources()
    {
        var plain = Req() with { Source = null };
        var u = Req();
        var other = Req(new QuerySource("union", "d", "U", Tables: ["a", "real"]));
        Assert.NotEqual(Key(plain), Key(u));
        Assert.NotEqual(Key(u), Key(other));
        Assert.Equal(Key(u), Key(Req()));
        Assert.DoesNotContain("\"p\"", Key(u)); // never the password
    }

    // --- request rules shared by /api/query and the CSV export ----------------------------------------------------------
    private static string? ExportField(QueryRequest r) { try { RequestRules.ValidateQuery(r, ApiLimits.MaxExportRows); return null; } catch (RequestValidationException e) { return e.Field; } }
    [Fact] public void The_csv_export_rejects_a_bad_source_like_the_query_does()
    {
        Assert.Null(ExportField(Req()));
        Assert.Equal("source.tables", ExportField(Req(new QuerySource("union", "d", "U", Tables: ["a"]))));
        Assert.Equal("source.kind", ExportField(Req(Union() with { Kind = "x" })));
        Assert.Equal("joins", ExportField(Req() with { Joins = [new JoinRef(new ColumnRef("d", "U", "a"), new ColumnRef("d", "t", "b"))] }));
    }
    [Fact] public void Null_elements_in_tables_columns_and_keep_are_400s()
    {
        string? F(QuerySource s) { try { RequestRules.ValidateSource(s); return null; } catch (RequestValidationException e) { return e.Field; } }
        Assert.Equal("source.tables[1]", F(new("union", "d", "U", Tables: ["a", null!])));
        Assert.Equal("source.columns[0]", F(new("union", "d", "U", Tables: ["a", "b"], Columns: [null!])));
        Assert.Equal("source.columns[1]", F(new("unpivot", "d", "P", Table: "t", Columns: ["a", null!])));
        Assert.Equal("source.keep[0]", F(new("unpivot", "d", "P", Table: "t", Columns: ["a", "b"], Keep: [null!])));
        Assert.Equal("source.tables", F(new("union", "d", "U", Tables: null)));
    }
}
