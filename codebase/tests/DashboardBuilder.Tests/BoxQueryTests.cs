using DashboardBuilder.ClickHouse;
using DashboardBuilder.ClickHouse.Calc;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>The joined / calculated box plot (POST /api/boxplot): a worksheet-shaped request whose one row dimension is the
/// value and whose optional one column dimension is the group. Validated with the worksheet rules plus the box rules.</summary>
public class BoxQueryTests
{
    private static readonly ColumnRef Value = new("db", "orders", "amount");
    private static readonly ColumnRef Group = new("db", "customers", "region");

    private static QueryRequest Q(ColumnRef[]? rows = null, ColumnRef[]? cols = null, MeasureRef[]? measures = null, int? limit = 10, HavingFilter[]? having = null) =>
        new(new TableRef("db", "orders"), null, rows ?? [Value], cols, measures, null, limit, null, Having: having);

    private static string? FieldOf(Action a) => Assert.Throws<RequestValidationException>(a).Field;

    [Fact] public void A_value_with_or_without_a_group_passes()
    {
        RequestRules.ValidateBoxQuery(Q());
        RequestRules.ValidateBoxQuery(Q(cols: [Group]));
    }
    [Fact] public void Exactly_one_value_is_needed() =>
        Assert.Equal("rowDimensions", FieldOf(() => RequestRules.ValidateBoxQuery(Q(rows: []))));
    [Fact] public void At_most_one_group() =>
        Assert.Equal("columnDimensions", FieldOf(() => RequestRules.ValidateBoxQuery(Q(cols: [Group, Group]))));
    [Fact] public void Measures_and_measure_filters_are_refused()
    {
        Assert.Equal("measures", FieldOf(() => RequestRules.ValidateBoxQuery(Q(measures: [new MeasureRef("db", "orders", "amount", "sum")]))));
        Assert.Equal("having", FieldOf(() => RequestRules.ValidateBoxQuery(Q(having: [new HavingFilter(0, ">", "1")]))));
    }
    [Fact] public void The_group_limit_is_rejected_beyond_the_cap_never_clamped() =>
        Assert.Equal("limit", FieldOf(() => RequestRules.ValidateBoxQuery(Q(limit: ApiLimits.MaxRowLimit + 1))));
    [Fact] public void An_aggregate_before_joining_relationship_is_refused()
    {
        var join = new JoinRef(new ColumnRef("db", "orders", "cid"), new ColumnRef("db", "customers", "id"), Aggregate: true);
        var r = Q(cols: [Group]) with { Joins = [join] };
        Assert.Equal("joins", FieldOf(() => RequestRules.ValidateBoxQuery(r)));
    }
    [Fact] public void A_calculated_value_is_checked_like_a_calculated_dimension()
    {
        var calc = new ColumnRef("", "", "Doubled", Calc: new BinNode("*", new FieldNode("db", "orders", "amount"), new NumNode(2)));
        RequestRules.ValidateBoxQuery(Q(rows: [calc]));
        var agg = new ColumnRef("", "", "Total", Calc: new AggNode("sum", new FieldNode("db", "orders", "amount")));
        Assert.Equal("rowDimensions[0].calc", FieldOf(() => RequestRules.ValidateBoxQuery(Q(rows: [agg]))));
    }
    [Fact] public void A_joined_from_clause_goes_through_the_fence_queries()
    {
        const string from = "`db`.`orders` AS t0 INNER JOIN `db`.`customers` AS t1 ON t0.`cid` = t1.`id`";
        var sql = ClickHouseGateway.BuildBoxOutlierSql("t0.`amount`", from, "t1.`region`", " WHERE t0.`x` = {p0:String}", 10, 501);
        Assert.Contains("FROM " + from + " WHERE", sql);
        Assert.Contains("t1.`region` AS __bx_label", sql);
    }
}
