using DashboardBuilder.ClickHouse;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static DashboardBuilder.Tests.StubClickHouse;

namespace DashboardBuilder.Tests;

/// <summary>A filter on an aggregated measure (SQL HAVING): the clause the builder writes (golden strings, bound parameters),
/// the request rules (rejected, never clamped), and the statements the gateway sends against a stub ClickHouse endpoint.</summary>
public class HavingTests
{
    private static List<(string Name, string Type, object Value)> Ps() => [];
    private static HavingFilter H(int m, string op, string? v, string[]? vs = null) => new(m, op, v, vs);

    [Fact] public void No_measure_filters_add_no_clause() => Assert.Equal("", ClickHouseGateway.BuildHaving(null, 1, Ps()));

    [Theory]
    [InlineData(">", " HAVING (v0 > {h0:Float64})")]
    [InlineData(">=", " HAVING (v0 >= {h0:Float64})")]
    [InlineData("<", " HAVING (v0 < {h0:Float64})")]
    [InlineData("<=", " HAVING (v0 <= {h0:Float64})")]
    [InlineData("=", " HAVING (v0 = {h0:Float64})")]
    [InlineData("!=", " HAVING (v0 != {h0:Float64})")]
    public void A_comparison_binds_its_number_as_a_float(string op, string sql)
    {
        var ps = Ps();
        Assert.Equal(sql, ClickHouseGateway.BuildHaving([H(0, op, "1000")], 1, ps));
        Assert.Equal([("h0", "Float64", (object)1000d)], ps);
    }

    [Fact] public void A_range_binds_both_bounds_and_filters_stack_with_AND()
    {
        var ps = Ps();
        var sql = ClickHouseGateway.BuildHaving([H(1, "between", null, ["10", "20.5"]), H(0, ">", "-3")], 2, ps);
        Assert.Equal(" HAVING (v1 >= {h0a:Float64} AND v1 <= {h0b:Float64}) AND (v0 > {h1:Float64})", sql);
        Assert.Equal(["h0a", "h0b", "h1"], ps.Select(p => p.Name).ToArray());
        Assert.Equal([10d, 20.5d, -3d], ps.Select(p => (double)p.Value).ToArray());
    }

    [Theory]
    [InlineData("1; DROP TABLE x")] [InlineData("1e999")] [InlineData("NaN")] [InlineData("1,000")] [InlineData("")] [InlineData("0x10")]
    public void A_value_that_is_not_a_plain_number_is_rejected_and_never_reaches_sql(string value)
    {
        var ex = Assert.Throws<RequestValidationException>(() => ClickHouseGateway.BuildHaving([H(0, ">", value)], 1, Ps()));
        Assert.Equal("having[0].value", ex.Field);
    }

    [Theory] [InlineData("like")] [InlineData("in")] [InlineData("contains")] [InlineData("top")] [InlineData("> 1 OR 1=1")] [InlineData("")]
    public void An_operator_outside_the_whitelist_is_rejected(string op)
        => Assert.Equal("having[0].op", Assert.Throws<RequestValidationException>(() => ClickHouseGateway.BuildHaving([H(0, op, "1")], 1, Ps())).Field);

    [Theory] [InlineData(-1)] [InlineData(2)]
    public void A_measure_index_outside_the_view_is_rejected_not_clamped(int index)
        => Assert.Equal("having[0].measure", Assert.Throws<RequestValidationException>(() => ClickHouseGateway.BuildHaving([H(index, ">", "1")], 2, Ps())).Field);

    [Fact] public void A_range_needs_both_ends_in_order()
    {
        Assert.Equal("having[0].values", Assert.Throws<RequestValidationException>(() => RequestRules.ValidateHaving([H(0, "between", null, ["1"])], 1)).Field);
        Assert.Equal("having[0].values", Assert.Throws<RequestValidationException>(() => RequestRules.ValidateHaving([H(0, "between", null, ["9", "1"])], 1)).Field);
        RequestRules.ValidateHaving([H(0, "between", null, ["1", "1"])], 1);
    }

    [Fact] public void The_count_is_bounded()
    {
        RequestRules.ValidateHaving(Enumerable.Range(0, ApiLimits.MaxHaving).Select(_ => H(0, ">", "1")).ToArray(), 1);
        Assert.Equal("having", Assert.Throws<RequestValidationException>(() => RequestRules.ValidateHaving(Enumerable.Range(0, ApiLimits.MaxHaving + 1).Select(_ => H(0, ">", "1")).ToArray(), 1)).Field);
    }

    [Fact] public void A_null_entry_is_rejected() => Assert.Equal("having[0]", Assert.Throws<RequestValidationException>(() => RequestRules.ValidateHaving([null!], 1)).Field);

    private static QueryRequest Req(HavingFilter[]? having, bool? other = null, int? limit = 10, bool? total = null, params MeasureRef[] measures) =>
        new(new TableRef("d", "t"), null, [new ColumnRef("d", "t", "region")], null,
            measures.Length > 0 ? measures : [new MeasureRef("d", "t", "amount", "sum")], null, limit, null, WithTotal: total, OtherBucket: other, Having: having);

    [Fact] public void The_query_rules_check_the_index_against_the_views_measures_and_refuse_an_Other_bucket()
    {
        RequestRules.ValidateQuery(Req([H(0, ">", "1")]));
        Assert.Equal("having[0].measure", Assert.Throws<RequestValidationException>(() => RequestRules.ValidateQuery(Req([H(1, ">", "1")]))).Field);
        Assert.Equal("otherBucket", Assert.Throws<RequestValidationException>(() => RequestRules.ValidateQuery(Req([H(0, ">", "1")], other: true))).Field);
        RequestRules.ValidateQuery(Req(null, other: true)); // no measure filter: unchanged
        // No measures: the implicit count is measure 0.
        RequestRules.ValidateQuery(new QueryRequest(new TableRef("d", "t"), null, null, null, null, null, 10, null, Having: [H(0, ">", "1")]));
    }

    private static Result Answer(string sql)
    {
        if (sql.StartsWith("SHOW DATABASES")) return new([new Col("name", "String")], [["d"]]);
        if (sql.StartsWith("SHOW TABLES")) return new([new Col("name", "String")], [["t"]]);
        if (sql.StartsWith("DESCRIBE TABLE")) return new([new Col("name", "String"), new Col("type", "String")], [["region", "String"], ["amount", "Float64"], ["qty", "Int32"]]);
        if (sql.StartsWith("SELECT count() FROM")) return new([new Col("n", "UInt64")], [[2]]);
        if (!sql.Contains(" AS k0")) return new([new Col("v0", "Float64")], [[2500.0]]);
        if (sql.Contains(" AS v1")) return new([new Col("k0", "String"), new Col("v0", "Float64"), new Col("v1", "Float64")], [["north", 2500.0, 4.0]]);
        return new([new Col("k0", "String"), new Col("v0", "Float64")], [["north", 2500.0]]);
    }
    private static async Task<StubClickHouse> Run(QueryRequest req)
    {
        var stub = new StubClickHouse(Answer);
        var gw = new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance);
        await gw.QueryAsync(new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false), req, default);
        return stub;
    }
    private static Seen Main(StubClickHouse s) => s.Statements.Single(x => x.Sql.StartsWith("SELECT t0.`region` AS k0"));

    [Fact] public async Task The_statement_groups_then_filters_then_orders_then_limits_with_the_number_bound()
    {
        using var stub = await Run(Req([H(0, ">=", "1000")]));
        var sql = Main(stub).Sql;
        Assert.Contains("GROUP BY k0 HAVING (v0 >= {h0:Float64}) ORDER BY k0 ASC LIMIT 11", sql);
        Assert.DoesNotContain("1000", sql);
        Assert.Contains("param_h0=1000", Main(stub).Url);
    }

    [Fact] public async Task A_row_filter_stays_in_WHERE_and_the_group_count_counts_only_the_groups_that_pass()
    {
        var req = Req([H(0, ">", "5")], total: true) with { Filters = [new QueryFilter("d", "t", "region", "=", "north")] };
        using var stub = await Run(req);
        var sql = Main(stub).Sql;
        Assert.True(sql.IndexOf("WHERE", StringComparison.Ordinal) < sql.IndexOf("GROUP BY", StringComparison.Ordinal));
        Assert.True(sql.IndexOf("GROUP BY", StringComparison.Ordinal) < sql.IndexOf("HAVING", StringComparison.Ordinal));
        var count = stub.Statements.Single(x => x.Sql.StartsWith("SELECT count() FROM"));
        Assert.Contains("HAVING (v0 > {h0:Float64})", count.Sql);
        Assert.Contains("param_h0=5", count.Url);
    }

    [Fact] public async Task A_top_N_ranks_before_the_measure_filter_and_never_sees_it()
    {
        var req = Req([H(0, ">", "5")]) with { Filters = [new QueryFilter("d", "t", "region", "top", "3", TopBy: new MeasureRef("d", "t", "amount", "sum"))] };
        using var stub = await Run(req);
        var sql = Main(stub).Sql;
        var rank = sql[sql.IndexOf("IN (SELECT", StringComparison.Ordinal)..sql.IndexOf("LIMIT 3)", StringComparison.Ordinal)];
        Assert.DoesNotContain("HAVING", rank);
        Assert.Contains("HAVING (v0 > {h0:Float64})", sql);
    }

    [Fact] public async Task A_view_without_a_dimension_filters_its_single_group_and_counts_it_through_the_statement()
    {
        var req = new QueryRequest(new TableRef("d", "t"), null, null, null, [new MeasureRef("d", "t", "amount", "sum")], null, 10, null, WithTotal: true, Having: [H(0, ">", "1")]);
        using var stub = await Run(req);
        Assert.Contains(" HAVING (v0 > {h0:Float64})", stub.Statements.Single(x => x.Sql.StartsWith("SELECT count() FROM")).Sql);
    }

    [Fact] public async Task A_measure_filter_works_on_a_calculated_and_a_counted_measure()
    {
        using var stub = await Run(Req([H(1, "<", "9")], measures: [new MeasureRef("d", "t", "amount", "sum"), new MeasureRef("d", "t", "x", "count")]));
        Assert.Contains("count() AS v1", Main(stub).Sql);
        Assert.Contains("HAVING (v1 < {h0:Float64})", Main(stub).Sql);
    }

    [Fact] public void The_cache_key_tells_two_measure_filters_apart()
    {
        var info = new ClickHouseConnectionInfo("h", 1, "u", "p", false, false);
        Assert.NotEqual(ClickHouseGateway.CacheKey(info, Req([H(0, ">", "1")]), 5000), ClickHouseGateway.CacheKey(info, Req([H(0, ">", "2")]), 5000));
        Assert.NotEqual(ClickHouseGateway.CacheKey(info, Req(null), 5000), ClickHouseGateway.CacheKey(info, Req([H(0, ">", "1")]), 5000));
    }
}
