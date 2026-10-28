using DashboardBuilder.ClickHouse;
using DashboardBuilder.ClickHouse.Calc;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>E13 request rules for calculated fields: role (measure vs dimension), label and limits.
/// The tree itself is validated against the catalog in the gateway; here only shape, role and limits.</summary>
public class CalcRulesTests
{
    private static readonly ExprNode Field = new FieldNode("db", "t", "amount");
    private static readonly ExprNode RowLevel = new BinNode("*", Field, new NumNode(2));
    private static readonly ExprNode Aggregate = new BinNode("/", new AggNode("sum", Field), new AggNode("sum", new FieldNode("db", "t", "qty")));

    private static MeasureRef M(ExprNode? calc, string? agg, string? label = "calc") => new("", "", label!, agg!, calc);
    private static ColumnRef D(ExprNode? calc, string? part = null, string? label = "calc") => new("", "", label!, part, calc);

    private static QueryRequest Q(MeasureRef[]? measures = null, ColumnRef[]? rows = null, ColumnRef[]? cols = null, QueryFilter[]? filters = null) =>
        new(new TableRef("db", "t"), null, rows, cols, measures, filters, null, null);

    private static string? FieldOf(QueryRequest r) => Assert.Throws<RequestValidationException>(() => RequestRules.ValidateQuery(r)).Field;

    private static ExprNode Deep(int depth) { ExprNode n = Field; for (var i = 1; i < depth; i++) n = new UnNode("-", n); return n; }
    // A balanced tree of exactly `nodes` nodes (odd), shallow enough that only the node limit can reject it.
    private static ExprNode Wide(int nodes) => nodes == 1 ? new NumNode(1)
        : new BinNode("+", Wide(((nodes - 1) / 2) | 1), Wide(nodes - 1 - (((nodes - 1) / 2) | 1)));

    [Fact] public void Limits_mirror_the_calc_limits()
    {
        Assert.Equal(CalcLimits.MaxDepth, ApiLimits.MaxCalcDepth);
        Assert.Equal(CalcLimits.MaxNodes, ApiLimits.MaxCalcNodes);
    }

    [Fact] public void A_ratio_measure_with_no_aggregation_passes() => RequestRules.ValidateQuery(Q(measures: [M(Aggregate, null)]));
    [Theory] [InlineData("sum")] [InlineData("AVG")] [InlineData("min")] [InlineData("max")] [InlineData("countdistinct")] [InlineData("countnonnull")]
    public void A_row_level_measure_with_a_value_aggregation_passes(string agg) => RequestRules.ValidateQuery(Q(measures: [M(RowLevel, agg)]));
    [Fact] public void A_row_level_dimension_passes() => RequestRules.ValidateQuery(Q(rows: [D(RowLevel)], cols: [D(RowLevel)]));
    [Fact] public void A_calculation_label_may_be_absent() => RequestRules.ValidateQuery(Q(rows: [D(RowLevel, label: null)]));

    [Theory] [InlineData("sum")] [InlineData("count")] [InlineData("")]
    public void An_aggregate_tree_in_a_measure_needs_no_aggregation(string agg) => Assert.Equal("measures[0].calc", FieldOf(Q(measures: [M(Aggregate, agg)])));
    [Fact] public void A_row_level_measure_needs_an_aggregation() => Assert.Equal("measures[0].calc", FieldOf(Q(measures: [M(RowLevel, null)])));
    [Fact] public void Counting_rows_does_not_use_the_calculation()
    {
        var e = Assert.Throws<RequestValidationException>(() => RequestRules.ValidateQuery(Q(measures: [M(RowLevel, "count")])));
        Assert.Equal("measures[0].calc", e.Field);
        Assert.Equal("Counting rows doesn't use the calculation.", e.Message);
    }
    [Fact] public void An_unknown_aggregation_on_a_calculation_is_rejected() => Assert.Equal("measures[1].calc", FieldOf(Q(measures: [M(Aggregate, null), M(RowLevel, "median")])));
    [Fact] public void An_aggregate_tree_in_a_dimension_is_rejected() => Assert.Equal("rowDimensions[0].calc", FieldOf(Q(rows: [D(Aggregate)])));
    [Fact] public void An_aggregate_tree_in_a_column_dimension_is_rejected() => Assert.Equal("columnDimensions[1].calc", FieldOf(Q(cols: [D(RowLevel), D(Aggregate)])));
    [Fact] public void A_calculated_dimension_has_no_date_part() => Assert.Equal("rowDimensions[0].datePart", FieldOf(Q(rows: [D(RowLevel, "month")])));

    [Fact] public void A_label_over_60_characters_is_rejected()
    {
        Assert.Equal("measures[0].column", FieldOf(Q(measures: [M(Aggregate, null, new string('x', CalcLimits.MaxName + 1))])));
        Assert.Equal("rowDimensions[0].column", FieldOf(Q(rows: [D(RowLevel, label: new string('x', CalcLimits.MaxName + 1))])));
        RequestRules.ValidateQuery(Q(rows: [D(RowLevel, label: new string('x', CalcLimits.MaxName))]));
    }

    [Fact] public void A_tree_deeper_than_12_is_rejected()
    {
        RequestRules.ValidateQuery(Q(rows: [D(Deep(CalcLimits.MaxDepth))]));
        Assert.Equal("rowDimensions[0].calc", FieldOf(Q(rows: [D(Deep(CalcLimits.MaxDepth + 1))])));
        Assert.Equal("measures[0].calc", FieldOf(Q(measures: [M(Deep(CalcLimits.MaxDepth + 1), "sum")])));
    }
    [Fact] public void A_tree_of_201_nodes_is_rejected()
    {
        RequestRules.ValidateQuery(Q(measures: [M(Wide(199), "sum")]));
        Assert.Equal("measures[0].calc", FieldOf(Q(measures: [M(Wide(201), "sum")])));
    }
    [Fact] public void A_hostile_deep_tree_is_a_400_not_a_crash() =>
        Assert.Equal("columnDimensions[0].calc", FieldOf(Q(cols: [D(Deep(5000))])));

    [Fact] public void A_top_filter_ranks_by_a_ratio_with_no_aggregation()
    {
        QueryFilter F(MeasureRef by) => new("db", "t", "region", "top", "5", null, by);
        RequestRules.ValidateQuery(Q(filters: [F(M(Aggregate, null))]));
        RequestRules.ValidateQuery(Q(filters: [F(M(RowLevel, "sum"))]));
        Assert.Equal("filters[0].topBy.calc", FieldOf(Q(filters: [F(M(Aggregate, "sum"))])));
        Assert.Equal("filters[0].topBy.calc", FieldOf(Q(filters: [F(M(RowLevel, "count"))])));
        Assert.Equal("filters[0].topBy.calc", FieldOf(Q(filters: [F(M(Deep(13), "sum"))])));
        Assert.Equal("filters[0].topBy.column", FieldOf(Q(filters: [F(M(Aggregate, null, new string('x', 61)))])));
    }

    [Fact] public void ContainsAggregate_finds_an_aggregate_anywhere()
    {
        Assert.True(CalcValidator.ContainsAggregate(Aggregate));
        Assert.True(CalcValidator.ContainsAggregate(new UnNode("-", new BinNode("+", new NumNode(1), new AggNode("avg", Field)))));
        Assert.False(CalcValidator.ContainsAggregate(RowLevel));
        Assert.False(CalcValidator.ContainsAggregate(new NumNode(1)));
    }
}
