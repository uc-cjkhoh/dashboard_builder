using DashboardBuilder.ClickHouse;
using DashboardBuilder.ClickHouse.Calc;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>A calculated field as a row-level filter (D82): validated like a calculated dimension, compiled once by the calc compiler,
/// its compared values bound, and placed in WHERE — before aggregation. An aggregate-containing calculation is a 400.</summary>
public class CalcFilterTests
{
    private static readonly FieldNode Amount = new("db", "orders", "amount");
    private static readonly FieldNode Status = new("db", "orders", "status");
    private static readonly ExprNode Doubled = new BinNode("*", Amount, new NumNode(2));
    private static readonly ExprNode Total = new AggNode("sum", Amount);

    private static readonly Dictionary<(string, string, string), (string Sql, string Category)> Refs = new()
    {
        [("db", "orders", "amount")] = ("t0.`amount`", ClickHouseType.Numeric),
        [("db", "orders", "status")] = ("t0.`status`", ClickHouseType.Text),
    };

    private static QueryFilter F(string op, ExprNode? calc, string? value = null, string[]? values = null, string? cast = null) =>
        new("", "", "Doubled", op, value, values, null, null, cast, calc);

    private static QueryRequest Q(params QueryFilter[] filters) =>
        new(new TableRef("db", "orders"), null, null, null, [new MeasureRef("db", "orders", "amount", "sum")], filters, null, null);

    private static string? FieldOf(Action a) => Assert.Throws<RequestValidationException>(a).Field;

    [Fact] public void A_row_level_calculation_filter_passes_the_request_rules() =>
        RequestRules.ValidateQuery(Q(F(">", Doubled, "10"), F("in", Status, values: ["a", "b"])));

    [Fact] public void A_filter_on_an_aggregate_calculation_is_a_400_naming_the_calc() =>
        Assert.Equal("filters[0].calc", FieldOf(() => RequestRules.ValidateQuery(Q(F(">", Total, "10")))));

    [Fact] public void A_calculated_filter_can_not_be_a_top_n() =>
        Assert.Equal("filters[0].calc", FieldOf(() => RequestRules.ValidateQuery(Q(F("top", Doubled, "5")))));

    [Fact] public void A_calculated_filter_takes_no_cast() =>
        Assert.Equal("filters[0].cast", FieldOf(() => RequestRules.ValidateQuery(Q(F("=", Doubled, "1", cast: "number")))));

    [Fact] public void A_too_deep_calculation_filter_is_a_400() =>
        Assert.StartsWith("filters[0].calc", FieldOf(() => RequestRules.ValidateQuery(Q(F("=", Deep(13), "1")))));

    private static ExprNode Deep(int n) { ExprNode e = Amount; for (var i = 0; i < n; i++) e = new BinNode("+", e, new NumNode(1)); return e; }

    [Fact] public void An_in_list_is_still_bounded_for_a_calculation() =>
        Assert.Equal("filters[0].values", FieldOf(() => RequestRules.ValidateQuery(Q(F("in", Status, values: Enumerable.Range(0, ApiLimits.MaxInValues + 1).Select(i => i.ToString()).ToArray())))));

    [Fact] public void The_filter_count_cap_counts_calculated_filters_too() =>
        Assert.Equal("filters", FieldOf(() => RequestRules.ValidateQuery(Q(Enumerable.Range(0, ApiLimits.MaxFilters + 1).Select(_ => F("=", Doubled, "1")).ToArray()))));

    [Fact]
    public void A_row_level_calculation_becomes_a_condition_with_its_values_bound()
    {
        var ps = new List<(string Name, string Type, object Value)>();
        var c = CalcSql.CompileCalc(Doubled, "filters[0]", Refs, ps, "c0", false, false);
        var (sql, category) = CalcSql.CalcFilterSql(c, "filters[0]");
        Assert.Equal(ClickHouseType.Numeric, category);
        var cond = ClickHouseGateway.BuildCondition(">", "p0", sql, category, "Doubled", "filters[0]", "10", null, ps);
        Assert.Equal($"{sql} > {{p0:Float64}}", cond);
        Assert.DoesNotContain("10", cond);
        Assert.Contains(ps, p => p.Name == "p0" && (double)p.Value == 10);
        Assert.Contains(ps, p => p.Name.StartsWith("c0p")); // the calculation's own literal is bound too
    }

    [Theory]
    [InlineData("text", ClickHouseType.Text)]
    [InlineData("number", ClickHouseType.Numeric)]
    public void The_filter_category_follows_the_calculation_type(string kind, string expected)
    {
        ExprNode tree = kind == "text" ? Status : Doubled;
        var c = CalcSql.CompileCalc(tree, "filters[0]", Refs, [], "c0", false, false);
        Assert.Equal(expected, CalcSql.CalcFilterSql(c, "filters[0]").Category);
    }

    [Fact]
    public void An_aggregate_calculation_is_refused_at_compile_time_too()
    {
        var c = CalcSql.CompileCalc(Total, "filters[0]", Refs, [], "c0", false, false);
        Assert.Equal("filters[0].calc", FieldOf(() => CalcSql.CalcFilterSql(c, "filters[0]")));
    }

    [Fact]
    public void Requests_differing_only_in_a_filter_calculation_never_share_a_cache_entry()
    {
        var info = new ClickHouseConnectionInfo("h", 8443, "u", "pw", true, false);
        Assert.NotEqual(ClickHouseGateway.CacheKey(info, Q(F(">", Doubled, "1")), 5000),
            ClickHouseGateway.CacheKey(info, Q(F(">", new BinNode("*", Amount, new NumNode(3)), "1")), 5000));
    }

    [Fact]
    public void A_filter_with_a_calculation_reads_from_the_wire()
    {
        const string wire = """{"db":"","table":"","column":"Doubled","op":">","value":"10","values":null,"calc":{"k":"bin","op":"*","l":{"k":"field","db":"db","table":"orders","column":"amount"},"r":{"k":"num","v":2}}}""";
        var f = System.Text.Json.JsonSerializer.Deserialize<QueryFilter>(wire, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
        Assert.Equal(Doubled, f!.Calc);
    }
}
