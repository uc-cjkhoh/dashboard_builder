using DashboardBuilder.ClickHouse;
using DashboardBuilder.ClickHouse.Calc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static DashboardBuilder.Tests.StubClickHouse;

namespace DashboardBuilder.Tests;

/// <summary>Aggregate Measures off (<see cref="QueryRequest.Disaggregate"/>): one row per source row. The request shape the server accepts,
/// what it refuses with the field to blame, and that the result cache keeps the two modes apart.</summary>
public class DisaggregateTests
{
    private static readonly MeasureRef Sales = new("shop", "orders", "amount", "sum");
    private static readonly MeasureRef Profit = new("shop", "orders", "discount", "sum");
    private static readonly ColumnRef State = new("shop", "orders", "region");

    private static QueryRequest Q(bool? disaggregate = true, MeasureRef[]? measures = null, JoinRef[]? joins = null, HavingFilter[]? having = null,
        bool? other = null, ColumnRef[]? rows = null) =>
        new(new TableRef("shop", "orders"), joins, rows, null, measures ?? [Sales, Profit], null, 5000, null, OtherBucket: other, Having: having, Disaggregate: disaggregate);

    private static string? FieldOf(QueryRequest r) => Assert.Throws<RequestValidationException>(() => RequestRules.ValidateQuery(r)).Field;

    [Fact] public void Two_measures_and_no_dimension_is_the_scatter_case() => RequestRules.ValidateQuery(Q());
    [Fact] public void Dimensions_stay_allowed_as_detail() => RequestRules.ValidateQuery(Q(rows: [State]));
    [Fact] public void Off_or_absent_is_the_aggregated_query() { RequestRules.ValidateQuery(Q(null)); RequestRules.ValidateQuery(Q(false, [])); }

    [Fact] public void A_view_with_no_measure_is_refused() => Assert.Equal("measures", FieldOf(Q(measures: [])));
    [Fact] public void A_filter_on_a_measure_is_refused() => Assert.Equal("having", FieldOf(Q(having: [new HavingFilter(0, ">", "5")])));
    [Fact] public void The_other_bucket_is_refused() => Assert.Equal("otherBucket", FieldOf(Q(other: true)));
    [Fact] public void Aggregating_before_the_join_is_refused()
        => Assert.Equal("joins", FieldOf(Q(joins: [new JoinRef(new ColumnRef("shop", "orders", "region"), new ColumnRef("shop", "customers", "country"), Aggregate: true)])));

    [Fact] public void The_result_cache_keeps_the_two_modes_apart()
    {
        var info = new ClickHouseConnectionInfo("h", 8443, "u", "p", true, false);
        Assert.NotEqual(ClickHouseGateway.CacheKey(info, Q(null), 5000), ClickHouseGateway.CacheKey(info, Q(true), 5000));
    }

    // --- the statement the gateway sends (a stub ClickHouse records it) ---
    private static Result Answer(string sql)
    {
        if (sql.StartsWith("SHOW DATABASES")) return new([new Col("name", "String")], [["shop"]]);
        if (sql.StartsWith("SHOW TABLES")) return new([new Col("name", "String")], [["orders"]]);
        if (sql.StartsWith("DESCRIBE TABLE")) return new([new Col("name", "String"), new Col("type", "String")],
            [["amount", "Float64"], ["discount", "Float64"], ["region", "String"], ["status", "String"]]);
        return sql.Contains(" AS k0") // the columns the statement selects: a key only when the view has a dimension
            ? new([new Col("k0", "String"), new Col("v0", "Float64"), new Col("v1", "Float64")], [["north", 10.0, 3.0]])
            : new([new Col("v0", "Float64"), new Col("v1", "Float64")], [[10.0, 3.0]]);
    }
    private static async Task<(StubClickHouse Stub, QueryResult Result)> Run(QueryRequest req)
    {
        var stub = new StubClickHouse(Answer);
        var result = await new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance)
            .QueryAsync(new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false), req, default);
        return (stub, result);
    }
    private static string QuerySql(StubClickHouse stub) => stub.Statements.Single(x => x.Sql.StartsWith("SELECT ") && !x.Sql.StartsWith("SELECT version()")).Sql.Trim(); // the one data statement

    [Fact] public async Task Each_source_row_is_one_result_row_with_the_raw_value_and_no_group_by()
    {
        var (stub, result) = await Run(Q(rows: [State]));
        using var _ = stub;
        var sql = QuerySql(stub);
        Assert.StartsWith("SELECT t0.`region` AS k0, t0.`amount` AS v0, t0.`discount` AS v1 FROM `shop`.`orders` AS t0", sql);
        Assert.DoesNotContain("GROUP BY", sql);
        Assert.DoesNotContain("sum(", sql); // the pills' aggregation is ignored
        Assert.Equal(["amount", "discount"], result.Measures); // named by the field, not "sum amount"
    }

    [Fact] public async Task Paging_is_stable_because_the_order_ends_in_every_key_and_measure()
    {
        var (stub, _) = await Run(Q(rows: [State]));
        using var _s = stub;
        Assert.EndsWith(" ORDER BY k0 ASC, v0 ASC, v1 ASC LIMIT 5001", QuerySql(stub)); // k0 first (the default sort), then every measure; 5000 rows + the probe row
    }

    [Fact] public async Task It_is_never_sampled_even_when_approximate_is_asked_for()
    {
        var (stub, result) = await Run(Q() with { Approximate = true });
        using var _ = stub;
        var sql = QuerySql(stub);
        Assert.DoesNotContain("_sample_factor", sql);
        Assert.DoesNotContain("SAMPLE", sql);
        Assert.Null(result.Approx);
    }

    [Fact] public async Task A_row_level_calculation_is_the_per_row_expression()
    {
        var calc = new BinNode("*", new FieldNode("shop", "orders", "amount"), new NumNode(2));
        var (stub, _) = await Run(Q(measures: [new MeasureRef("", "", "Doubled", "sum", calc), Sales]));
        using var _s = stub;
        var sql = QuerySql(stub);
        Assert.Contains("* {c0p0:Float64}", sql); // the constant is bound, the aggregation word is not written
        Assert.DoesNotContain("sum(", sql);
    }

    [Fact] public async Task An_aggregate_calculation_has_no_value_per_row_and_is_refused_with_its_field()
    {
        var calc = new AggNode("sum", new FieldNode("shop", "orders", "amount"));
        using var stub = new StubClickHouse(Answer);
        var ex = await Assert.ThrowsAsync<RequestValidationException>(() => new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance)
            .QueryAsync(new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false), Q(measures: [new MeasureRef("", "", "Total", null, calc), Sales]), default));
        Assert.Equal("measures[0].calc", ex.Field);
    }

    [Fact] public async Task A_text_measure_is_refused_with_its_field()
    {
        using var stub = new StubClickHouse(Answer);
        var ex = await Assert.ThrowsAsync<RequestValidationException>(() => new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance)
            .QueryAsync(new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false), Q(measures: [Sales, new MeasureRef("shop", "orders", "status", "countdistinct")]), default));
        Assert.Equal("measures[1]", ex.Field);
    }

    [Fact] public async Task The_aggregated_query_is_unchanged_when_it_is_off()
    {
        var (stub, _) = await Run(Q(false, rows: [State]));
        using var _s = stub;
        var sql = QuerySql(stub);
        Assert.Contains("GROUP BY k0", sql);
        Assert.Contains("sum(t0.`amount`) AS v0", sql);
    }
}
