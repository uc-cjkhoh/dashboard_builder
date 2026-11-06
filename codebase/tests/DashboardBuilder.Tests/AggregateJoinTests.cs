using DashboardBuilder.ClickHouse;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static DashboardBuilder.Tests.StubClickHouse;

namespace DashboardBuilder.Tests;

/// <summary>Aggregate-before-join (P43): each side of a two-table join is grouped to the key (+ its dimensions) first, so a measure
/// can't double-count when the other side repeats the key.</summary>
public class AggregateJoinTests
{
    private static AggregateJoin TwoSides(bool both = true)
    {
        var a = new AggregateJoin(both);
        a.AddSide("t0", "`db`.`orders`");
        a.AddSide("t1", "`db`.`items`");
        a.Keys([("`id`", "`order_id`")]);
        return a;
    }

    [Fact] public void Each_side_is_grouped_to_its_key_dimensions_and_partial_aggregates()
    {
        var a = TwoSides();
        a.Need("t0", "`region`");
        var sum = a.Measure("sum", "t0", "t0.`amount`", "measures[0]");
        var cnt = a.Measure("count", "t1", "", "measures[1]");
        Assert.Equal("sum(t0.`__m0`)", sum);
        Assert.Equal("sum(t1.`__m0`)", cnt);
        var from = a.FromSql(" INNER JOIN ", " ON t0.`id` = t1.`order_id`");
        Assert.Equal(" FROM (SELECT t0.`id` AS `id`, t0.`region` AS `region`, sum(t0.`amount`) AS `__m0` FROM `db`.`orders` AS t0 GROUP BY t0.`id`, t0.`region`) AS t0"
            + " INNER JOIN (SELECT t1.`order_id` AS `order_id`, count() AS `__m0` FROM `db`.`items` AS t1 GROUP BY t1.`order_id`) AS t1 ON t0.`id` = t1.`order_id`", from);
    }

    [Fact] public void An_average_is_the_sum_of_sums_over_the_sum_of_counts()
    {
        var a = TwoSides();
        var avg = a.Measure("avg", "t0", "t0.`amount`", "measures[0]");
        Assert.Equal("sum(t0.`__m0`) / nullIf(sum(t0.`__m1`), 0)", avg);
        Assert.Contains("sum(t0.`amount`) AS `__m0`, count(t0.`amount`) AS `__m1`", a.FromSql(" INNER JOIN ", " ON x"));
    }

    [Fact] public void Min_max_and_non_null_counts_recombine()
    {
        var a = TwoSides();
        Assert.Equal("min(t0.`__m0`)", a.Measure("min", "t0", "t0.`v`", "m"));
        Assert.Equal("max(t0.`__m1`)", a.Measure("max", "t0", "t0.`v`", "m"));
        Assert.Equal("sum(t0.`__m2`)", a.Measure("countnonnull", "t0", "t0.`v`", "m"));
    }

    [Fact] public void The_same_partial_aggregate_is_computed_once()
    {
        var a = TwoSides();
        Assert.Equal(a.Measure("sum", "t0", "t0.`x`", "m"), a.Measure("sum", "t0", "t0.`x`", "m"));
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(a.FromSql(" INNER JOIN ", " ON x"), @"sum\(t0\.`x`\)"));
    }

    [Theory] [InlineData("countdistinct")] [InlineData("median")] [InlineData("percentile")] [InlineData("stddev")] [InlineData("variance")] [InlineData("attr")]
    public void An_aggregate_that_cannot_be_recombined_is_refused_with_its_field(string agg)
    {
        var e = Assert.Throws<RequestValidationException>(() => TwoSides().Measure(agg, "t0", "t0.`v`", "measures[2]"));
        Assert.Equal("measures[2]", e.Field);
        Assert.Contains("before the join", e.Message);
    }

    [Fact] public void A_filter_stays_on_its_own_side_and_the_other_side_keeps_only_matching_keys_when_both_ways()
    {
        var a = TwoSides(both: true);
        a.Where("t1", "t1.`qty` > {p0:Float64}");
        var from = a.FromSql(" LEFT JOIN ", " ON x");
        Assert.Contains("FROM `db`.`items` AS t1 WHERE t1.`qty` > {p0:Float64} GROUP BY", from);
        Assert.Contains("FROM `db`.`orders` AS t0 WHERE t0.`id` IN (SELECT t1.`order_id` FROM `db`.`items` AS t1 WHERE t1.`qty` > {p0:Float64}) GROUP BY", from);
    }

    [Fact] public void With_one_way_filters_a_filter_changes_only_its_own_side()
    {
        var a = TwoSides(both: false);
        a.Where("t1", "t1.`qty` > {p0:Float64}");
        var from = a.FromSql(" LEFT JOIN ", " ON x");
        Assert.Contains("FROM `db`.`items` AS t1 WHERE t1.`qty` > {p0:Float64} GROUP BY", from);
        Assert.DoesNotContain(" IN (SELECT", from);
    }

    [Fact] public void A_compound_key_is_matched_as_a_tuple()
    {
        var a = new AggregateJoin(true);
        a.AddSide("t0", "`d`.`a`"); a.AddSide("t1", "`d`.`b`");
        a.Keys([("`k1`", "`j1`"), ("`k2`", "`j2`")]);
        a.Where("t1", "t1.`z` = {p0:String}");
        Assert.Contains("(t0.`k1`, t0.`k2`) IN (SELECT t1.`j1`, t1.`j2` FROM `d`.`b` AS t1 WHERE t1.`z` = {p0:String})", a.FromSql(" INNER JOIN ", " ON x"));
    }

    // --- request validation ---
    private static QueryRequest Q(JoinRef[] joins, MeasureRef[]? m = null, QueryFilter[]? f = null, ColumnRef[]? dims = null) =>
        new(new TableRef("db", "orders"), joins, dims ?? [new ColumnRef("db", "orders", "region")], [], m ?? [new MeasureRef("db", "orders", "amount", "sum")], f, null, null);
    private static JoinRef J(bool? agg = true, string? dir = null) =>
        new(new ColumnRef("db", "orders", "id"), new ColumnRef("db", "items", "order_id"), null, null, agg, dir);
    private static string? FieldOf(QueryRequest q) { try { RequestRules.ValidateQuery(q); return null; } catch (RequestValidationException e) { return e.Field; } }

    [Fact] public void A_flagged_join_in_a_two_table_view_is_accepted() => Assert.Null(FieldOf(Q([J()])));
    [Fact] public void A_flagged_join_needs_a_view_of_exactly_two_tables()
        => Assert.Equal("joins", FieldOf(Q([J(), new JoinRef(new ColumnRef("db", "orders", "u"), new ColumnRef("db", "users", "id"))])));
    [Theory] [InlineData("both")] [InlineData("single")] [InlineData(null)]
    public void The_filter_direction_is_both_or_single(string? dir) => Assert.Null(FieldOf(Q([J(true, dir)])));
    [Fact] public void An_unknown_filter_direction_is_refused() => Assert.Equal("joins[0].filterDirection", FieldOf(Q([J(true, "up")])));
    [Fact] public void A_calculation_a_top_n_or_an_unrecombinable_measure_is_refused_in_a_flagged_view()
    {
        Assert.Equal("measures[0]", FieldOf(Q([J()], [new MeasureRef("db", "orders", "amount", "median")])));
        Assert.Equal("filters[0]", FieldOf(Q([J()], null, [new QueryFilter("db", "orders", "region", "top", "3", null, new MeasureRef("db", "orders", "amount", "sum"))])));
    }
    [Fact] public void An_unflagged_join_is_unaffected() => Assert.Null(FieldOf(Q([J(null)], [new MeasureRef("db", "orders", "amount", "median")])));

    // --- the statement the gateway sends ---
    private static Result Answer(string sql)
    {
        if (sql.StartsWith("SHOW DATABASES")) return new([new Col("name", "String")], [["db"]]);
        if (sql.StartsWith("SHOW TABLES")) return new([new Col("name", "String")], [["orders"], ["items"]]);
        if (sql.StartsWith("DESCRIBE TABLE")) return new([new Col("name", "String"), new Col("type", "String")], [["id", "Int32"], ["order_id", "Int32"], ["region", "String"], ["amount", "Float64"], ["qty", "Int32"]]);
        return new([new Col("k0", "String"), new Col("v0", "Float64"), new Col("v1", "Float64")], [["north", 10.0, 3.0]]);
    }
    private static async Task<StubClickHouse> Run(QueryRequest req)
    {
        var stub = new StubClickHouse(Answer);
        await new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance).QueryAsync(new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false), req, default);
        return stub;
    }

    [Fact] public async Task The_gateway_joins_two_grouped_subqueries_and_combines_the_partials_with_the_filter_bound()
    {
        var req = Q([J(true, "both")], [new MeasureRef("db", "orders", "amount", "sum"), new MeasureRef("db", "items", "qty", "count")],
            [new QueryFilter("db", "items", "qty", ">", "2")]);
        using var stub = await Run(req);
        var sql = stub.Statements.Single(x => x.Sql.StartsWith("SELECT t0.`region` AS k0")).Sql;
        Assert.Contains("sum(t0.`__m0`) AS v0, sum(t1.`__m0`) AS v1 FROM (SELECT t0.`id` AS `id`, t0.`region` AS `region`, sum(t0.`amount`) AS `__m0` FROM `db`.`orders` AS t0 WHERE t0.`id` IN (SELECT t1.`order_id` FROM `db`.`items` AS t1 WHERE t1.`qty` > {p0:Float64}) GROUP BY t0.`id`, t0.`region`) AS t0 INNER JOIN (SELECT t1.`order_id` AS `order_id`, count() AS `__m0` FROM `db`.`items` AS t1 WHERE t1.`qty` > {p0:Float64} GROUP BY t1.`order_id`) AS t1 ON t0.`id` = t1.`order_id` GROUP BY k0", sql);
        Assert.DoesNotContain("1000", sql);
    }

    [Fact] public async Task An_unflagged_join_is_the_plain_join()
    {
        using var stub = await Run(Q([J(null)]));
        var sql = stub.Statements.Single(x => x.Sql.StartsWith("SELECT t0.`region` AS k0")).Sql;
        Assert.Contains("FROM `db`.`orders` AS t0 INNER JOIN `db`.`items` AS t1 ON t0.`id` = t1.`order_id`", sql);
    }
}
