using DashboardBuilder.ClickHouse;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static DashboardBuilder.Tests.StubClickHouse;

namespace DashboardBuilder.Tests;

/// <summary>A custom SQL card can be viewed (rows), profiled, histogrammed and join-checked (D105 follow-up): each read takes an optional
/// <c>Source</c> (kind sql, for the very table it names) and reads the query as a derived table, against a stub ClickHouse.</summary>
public class CardGapsTests
{
    private const string UserSql = "SELECT region, amount, id FROM d.sales WHERE amount > 0";
    private static QuerySource Q(string? sql = UserSql, string name = "orders") => new("sql", "d", name, Sql: sql);
    private static Col[] Cols(params (string, string)[] c) => c.Select(x => new Col(x.Item1, x.Item2)).ToArray();

    // What the stub answers: DESCRIBE of the user's query (region String, amount Float64, id UInt64), the catalog tables, then a result per statement shape.
    private static Result Answer(string sql)
    {
        if (sql.StartsWith("DESCRIBE TABLE ("))
            return new(Cols(("name", "String"), ("type", "String")), [["region", "String"], ["amount", "Float64"], ["id", "UInt64"]]);
        if (sql.StartsWith("SHOW DATABASES")) return new(Cols(("name", "String")), [["d"]]);
        if (sql.StartsWith("SHOW TABLES")) return new(Cols(("name", "String")), [["orders"], ["regions"]]);
        if (sql.StartsWith("DESCRIBE TABLE `d`.`orders`"))
            return new(Cols(("name", "String"), ("type", "String")), [["catalog_only", "String"]]);
        if (sql.StartsWith("DESCRIBE TABLE `d`.`regions`"))
            return new(Cols(("name", "String"), ("type", "String")), [["region", "String"], ["label", "String"]]);
        if (sql.StartsWith("SELECT count() AS n")) return new(Cols(("n", "UInt64"), ("nulls", "UInt64"), ("d", "UInt64"), ("lo", "String"), ("hi", "String")), [[10UL, 1UL, 4UL, "1", "9"]]);
        if (sql.StartsWith("SELECT label, cut")) return new(Cols(("label", "String"), ("cut", "UInt64"), ("cnt", "UInt64")), [["north", 0UL, 6UL]]);
        if (sql.Contains("AS bin")) return new(Cols(("bin", "UInt64"), ("x0", "Float64"), ("x1", "Float64"), ("c", "UInt64")), [[0UL, 0.0, 5.0, 7UL], [1UL, 5.0, 10.0, 3UL]]);
        if (sql.StartsWith("SELECT sum(cnt)")) return new(Cols(("a", "UInt64"), ("b", "UInt64"), ("c", "UInt64"), ("d", "UInt64"), ("e", "UInt64"), ("f", "UInt64")), [[10UL, 0UL, 5UL, 2UL, 8UL, 4UL]]);
        return new(Cols(("c0", "String"), ("c1", "String"), ("c2", "String")), [["north", "2.5", "7"]]);
    }
    private static (StubClickHouse Stub, ClickHouseGateway Gw, ClickHouseConnectionInfo Info) Start()
    {
        var stub = new StubClickHouse(Answer);
        return (stub, new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance), new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false));
    }
    private static List<string> Selects(StubClickHouse stub) => stub.Statements.Select(x => x.Sql).Where(s => (s.StartsWith("SELECT") || s.StartsWith("WITH")) && !s.StartsWith("SELECT version()")).ToList();
    private static void NoCatalogRead(StubClickHouse stub) => Assert.DoesNotContain(stub.Statements, x => x.Sql.Contains("`d`.`orders`"));

    // --- 1. View data (rows) ------------------------------------------------------------------------------------------------
    [Fact] public async Task Rows_read_the_query_as_a_derived_table_with_the_queries_own_columns()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        var res = await gw.RowsAsync(info, new RowsRequest("d", "orders", ["region", "amount"], [new StatFilter("amount", ">", "5")], 20, Q(UserSql + ";")), default);
        var sql = Assert.Single(Selects(stub));
        Assert.Contains("FROM (SELECT region, amount, id FROM d.sales WHERE amount > 0) WHERE `amount` > ", sql);
        Assert.Contains("{p0:Float64}", sql); Assert.DoesNotContain("> 5", sql);
        Assert.EndsWith("LIMIT 21", sql);
        Assert.DoesNotContain(';', sql);
        NoCatalogRead(stub);
        Assert.Equal(["region", "amount"], res.Columns.Select(c => c.Name));
        Assert.Equal("Float64", res.Columns[1].Type);
    }
    [Fact] public async Task Rows_default_to_every_column_the_query_returns()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        var res = await gw.RowsAsync(info, new RowsRequest("d", "orders", null, null, null, Q()), default);
        Assert.Equal(["region", "amount", "id"], res.Columns.Select(c => c.Name));
        Assert.EndsWith("LIMIT 101", Assert.Single(Selects(stub)));
    }
    [Fact] public async Task Rows_refuse_a_column_or_filter_the_query_does_not_return()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        await Assert.ThrowsAsync<UnknownIdentifierException>(() => gw.RowsAsync(info, new RowsRequest("d", "orders", ["catalog_only"], null, null, Q()), default));
        await Assert.ThrowsAsync<UnknownIdentifierException>(() => gw.RowsAsync(info, new RowsRequest("d", "orders", ["region"], [new StatFilter("catalog_only", "=", "x")], null, Q()), default));
        Assert.Empty(Selects(stub));
    }
    [Fact] public async Task Rows_without_a_source_still_read_the_catalog_table()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        await gw.RowsAsync(info, new RowsRequest("d", "orders", null, null, null), default);
        Assert.Contains("FROM `d`.`orders` LIMIT 101", Assert.Single(Selects(stub)));
    }

    // --- 2. Column profile ----------------------------------------------------------------------------------------------------
    [Fact] public async Task A_profile_reads_the_query_as_a_derived_table_in_both_statements()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        var p = await gw.ProfileColumnAsync(info, "d", "orders", new ProfileRequest("amount", 5, Q()), default);
        Assert.Equal("amount", p.Column); Assert.Equal("Float64", p.Type); Assert.Equal(10, p.Rows);
        var sel = Selects(stub);
        Assert.Equal(2, sel.Count);
        Assert.Contains($"FROM (SELECT `amount` AS v FROM ({UserSql}))", sel[0]);
        Assert.Contains($"FROM ({UserSql})) GROUP BY label", sel[1]);
        Assert.EndsWith("LIMIT 5", sel[1].Split(" SETTINGS ")[0]);
        NoCatalogRead(stub);
    }
    [Fact] public async Task A_profile_of_a_column_the_query_does_not_return_is_refused()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        await Assert.ThrowsAsync<UnknownIdentifierException>(() => gw.ProfileColumnAsync(info, "d", "orders", new ProfileRequest("catalog_only", null, Q()), default));
        Assert.Empty(Selects(stub));
    }

    // --- 3. Histogram ------------------------------------------------------------------------------------------------------------
    [Fact] public async Task A_histogram_reads_the_query_as_a_derived_table()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        var h = await gw.HistogramAsync(info, "d", "orders", new HistogramRequest("amount", 2, [new StatFilter("region", "=", "north")], Q()), default);
        Assert.Equal(2, h.Bins.Count); Assert.False(h.Whole);
        var sql = Assert.Single(Selects(stub));
        Assert.Contains($"FROM ({UserSql}) WHERE `region` = {{p0:String}} AND `amount` IS NOT NULL", sql);
        Assert.Equal(3, sql.Split($"({UserSql})").Length - 1); // lo, hi and the buckets
        NoCatalogRead(stub);
    }
    [Fact] public async Task A_histogram_needs_a_numeric_column_of_the_query()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        await Assert.ThrowsAsync<UnknownIdentifierException>(() => gw.HistogramAsync(info, "d", "orders", new HistogramRequest("region", 2, null, Q()), default)); // text
        await Assert.ThrowsAsync<UnknownIdentifierException>(() => gw.HistogramAsync(info, "d", "orders", new HistogramRequest("catalog_only", 2, null, Q()), default));
        Assert.Empty(Selects(stub));
    }

    // --- 4. Check this join ---------------------------------------------------------------------------------------------------
    [Fact] public async Task A_join_check_reads_each_custom_sql_end_as_a_derived_table()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        var other = "SELECT region FROM d.labels";
        var req = new JoinPreviewRequest(new JoinKeyRef("d", "orders", "region", Q()), new JoinKeyRef("d", "regions", "region", Q(other, "regions")), 1000);
        var r = await gw.JoinPreviewAsync(info, req, default);
        Assert.Equal(10, r.From.Rows);
        var sel = Selects(stub);
        Assert.Equal(2, sel.Count);
        Assert.All(sel, s => { Assert.Contains($"FROM ({UserSql}) LIMIT 1000", s); Assert.Contains($"FROM ({other}) LIMIT 1000", s); });
        Assert.DoesNotContain(stub.Statements, x => x.Sql.Contains("`d`.`orders`") || x.Sql.Contains("`d`.`regions`"));
    }
    [Fact] public async Task A_join_check_mixes_a_custom_sql_end_with_a_table_end()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        var req = new JoinPreviewRequest(new JoinKeyRef("d", "orders", "region", Q()), new JoinKeyRef("d", "regions", "region"), 1000);
        await gw.JoinPreviewAsync(info, req, default);
        var sel = Selects(stub);
        Assert.All(sel, s => { Assert.Contains($"FROM ({UserSql}) LIMIT 1000", s); Assert.Contains("FROM `d`.`regions` LIMIT 1000", s); });
        NoCatalogRead(stub);
    }
    [Fact] public async Task A_join_check_still_needs_joinable_key_kinds_of_the_query_columns()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        var req = new JoinPreviewRequest(new JoinKeyRef("d", "orders", "region", Q()), new JoinKeyRef("d", "regions", "amount", Q(name: "regions")), 1000); // text to number
        var ex = await Assert.ThrowsAsync<RequestValidationException>(() => gw.JoinPreviewAsync(info, req, default));
        Assert.Equal("to.column", ex.Field);
        Assert.Empty(Selects(stub));
    }

    // --- the request rules (every read takes the same optional Source) ------------------------------------------------------
    private static string? Field(Action check) { try { check(); return null; } catch (RequestValidationException e) { return e.Field; } }

    [Fact] public void A_valid_source_for_the_named_table_is_accepted()
    {
        Assert.Null(Field(() => RequestRules.ValidateRows(new("d", "orders", null, null, null, Q()))));
        Assert.Null(Field(() => RequestRules.ValidateProfile(new("region", null, Q()), "d", "orders")));
        Assert.Null(Field(() => RequestRules.ValidateHistogram(new("amount", null, null, Q()), "d", "orders")));
        Assert.Null(Field(() => JoinPreviewRules.Validate(new(new("d", "orders", "region", Q()), new("d", "regions", "region"), null))));
    }
    [Fact] public void A_source_that_names_another_table_is_refused()
    {
        Assert.Equal("source.name", Field(() => RequestRules.ValidateRows(new("d", "orders", null, null, null, Q(name: "other")))));
        Assert.Equal("source.name", Field(() => RequestRules.ValidateRows(new("d", "orders", null, null, null, Q() with { Db = "x" }))));
        Assert.Equal("source.name", Field(() => RequestRules.ValidateProfile(new("region", null, Q(name: "other")), "d", "orders")));
        Assert.Equal("source.name", Field(() => RequestRules.ValidateHistogram(new("amount", null, null, Q(name: "other")), "d", "orders")));
        Assert.Equal("to.source.name", Field(() => JoinPreviewRules.Validate(new(new("d", "orders", "region"), new("d", "regions", "region", Q(name: "orders")), null))));
    }
    [Fact] public void A_source_that_is_not_custom_sql_is_refused()
    {
        var union = new QuerySource("union", "d", "orders", Tables: ["a", "b"]);
        var unpivot = new QuerySource("unpivot", "d", "orders", Table: "t", Columns: ["q1", "q2"]);
        Assert.Equal("source.kind", Field(() => RequestRules.ValidateRows(new("d", "orders", null, null, null, union))));
        Assert.Equal("source.kind", Field(() => RequestRules.ValidateProfile(new("region", null, unpivot), "d", "orders")));
        Assert.Equal("source.kind", Field(() => RequestRules.ValidateHistogram(new("amount", null, null, union), "d", "orders")));
        Assert.Equal("from.source.kind", Field(() => JoinPreviewRules.Validate(new(new("d", "orders", "region", union), new("d", "regions", "region"), null))));
    }
    [Fact] public void A_source_whose_query_the_guard_refuses_is_refused()
    {
        Assert.Equal("source.sql", Field(() => RequestRules.ValidateRows(new("d", "orders", null, null, null, Q("DROP TABLE t")))));
        Assert.Equal("source.sql", Field(() => RequestRules.ValidateRows(new("d", "orders", null, null, null, Q("SELECT 1; SELECT 2")))));
        Assert.Equal("source.sql", Field(() => RequestRules.ValidateProfile(new("region", null, Q("SELECT * FROM url('http://x', CSV)")), "d", "orders")));
        Assert.Equal("source.sql", Field(() => RequestRules.ValidateHistogram(new("amount", null, null, Q("SELECT a FROM t SETTINGS x = 1")), "d", "orders")));
        Assert.Equal("to.source.sql", Field(() => JoinPreviewRules.Validate(new(new("d", "orders", "region"), new("d", "regions", "region", Q("")), null))));
    }
    [Fact] public async Task The_gateway_enforces_the_same_rules_when_called_directly()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        await Assert.ThrowsAsync<RequestValidationException>(() => gw.RowsAsync(info, new RowsRequest("d", "orders", null, null, null, Q(name: "other")), default));
        await Assert.ThrowsAsync<RequestValidationException>(() => gw.ProfileColumnAsync(info, "d", "orders", new ProfileRequest("region", null, Q("DROP TABLE t")), default));
        await Assert.ThrowsAsync<RequestValidationException>(() => gw.HistogramAsync(info, "d", "orders", new HistogramRequest("amount", null, null, new QuerySource("union", "d", "orders", Tables: ["a", "b"])), default));
        Assert.Empty(stub.Statements);
    }
}
