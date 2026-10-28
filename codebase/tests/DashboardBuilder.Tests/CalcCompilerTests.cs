using DashboardBuilder.ClickHouse;
using DashboardBuilder.ClickHouse.Calc;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>SQL emitted for a validated calculation tree: literals bound, ratios null-safe, numbers widened.</summary>
public class CalcCompilerTests
{
    private static FieldNode F(string c) => new("db", "orders", c);
    private static AggNode Agg(string fn, ExprNode a) => new(fn, a);
    private static BinNode Bin(string op, ExprNode l, ExprNode r) => new(op, l, r);

    private static (string Sql, string Category) Q(string db, string table, string column) => (
        $"t0.`{column}`",
        column switch
        {
            "amount" or "qty" => ClickHouseType.Numeric,
            "status" => ClickHouseType.Text,
            "placed" => ClickHouseType.Temporal,
            _ => ClickHouseType.Other,
        });

    private static (string Sql, List<(string Name, string Type, object Value)> Parameters) Compile(
        ExprNode n, string prefix = "c0", bool sampled = false, bool approximate = false)
    {
        var ps = new List<(string Name, string Type, object Value)>();
        var sql = CalcCompiler.Compile(n, Q, ps, prefix, sampled, approximate);
        return (sql, ps);
    }

    [Fact]
    public void A_ratio_of_sums_is_null_safe_and_float()
    {
        var (sql, ps) = Compile(Bin("/", Agg("sum", F("amount")), Agg("sum", F("qty"))));
        Assert.Equal("(sum(toFloat64(t0.`amount`)) / nullIf(sum(toFloat64(t0.`qty`)), 0))", sql);
        Assert.Empty(ps);
    }

    [Fact]
    public void A_number_literal_is_a_bound_parameter()
    {
        var (sql, ps) = Compile(Bin("*", F("amount"), new NumNode(10)));
        Assert.Equal("(toFloat64(t0.`amount`) * {c0p0:Float64})", sql);
        Assert.Equal(new[] { ("c0p0", "Float64", (object)10d) }, ps);
    }

    [Fact]
    public void Parameters_are_numbered_per_call_with_the_prefix()
    {
        var (sql, ps) = Compile(Bin("+", new NumNode(1.5), new NumNode(2)), prefix: "m3");
        Assert.Equal("({m3p0:Float64} + {m3p1:Float64})", sql);
        Assert.Equal(new[] { ("m3p0", "Float64", (object)1.5), ("m3p1", "Float64", (object)2d) }, ps);
    }

    [Fact]
    public void A_literal_never_appears_in_the_sql_text()
    {
        var (sql, ps) = Compile(Bin("+", F("amount"), new NumNode(123456)));
        Assert.DoesNotContain("123456", sql);
        Assert.Equal(123456d, Assert.Single(ps).Value);
    }

    [Fact]
    public void A_zero_divisor_literal_is_still_a_parameter()
        => Assert.Equal("(toFloat64(t0.`amount`) / nullIf({c0p0:Float64}, 0))", Compile(Bin("/", F("amount"), new NumNode(0))).Sql);

    [Fact]
    public void Negation_wraps_in_parentheses()
        => Assert.Equal("(-toFloat64(t0.`amount`))", Compile(new UnNode("-", F("amount"))).Sql);

    [Fact]
    public void Count_of_a_field_counts_non_null_exact_and_sampled()
    {
        Assert.Equal("count(t0.`status`)", Compile(Agg("count", F("status"))).Sql);
        Assert.Equal("sum(if(isNotNull(t0.`status`), t0._sample_factor, 0))", Compile(Agg("count", F("status")), sampled: true).Sql);
    }

    [Fact]
    public void A_sampled_sum_of_a_product_is_scaled_once()
        => Assert.Equal("sum((toFloat64(t0.`amount`) * toFloat64(t0.`qty`)) * t0._sample_factor)",
            Compile(Agg("sum", Bin("*", F("amount"), F("qty"))), sampled: true).Sql);

    [Fact]
    public void Min_of_a_date_uses_the_bare_reference()
        => Assert.Equal("min(t0.`placed`)", Compile(Agg("min", F("placed"))).Sql);

    [Fact]
    public void Max_of_a_number_is_widened()
        => Assert.Equal("max(toFloat64(t0.`amount`))", Compile(Agg("max", F("amount"))).Sql);

    [Fact]
    public void Countd_is_exact_unless_approximate()
    {
        Assert.Equal("uniqExact(t0.`status`)", Compile(Agg("countd", F("status"))).Sql);
        Assert.Equal("uniq(t0.`status`)", Compile(Agg("countd", F("status")), approximate: true).Sql);
        Assert.Equal("uniqExact(t0.`status`)", Compile(Agg("countd", F("status")), sampled: true).Sql);
        Assert.Equal("uniq(t0.`status`)", Compile(Agg("countd", F("status")), sampled: true, approximate: true).Sql);
    }

    [Fact]
    public void Avg_is_not_scaled_when_sampled()
        => Assert.Equal("avg(toFloat64(t0.`amount`))", Compile(Agg("avg", F("amount")), sampled: true).Sql);

    [Fact]
    public void A_row_level_field_widens_numbers_and_leaves_text_bare()
    {
        Assert.Equal("toFloat64(t0.`qty`)", Compile(F("qty")).Sql);
        Assert.Equal("t0.`status`", Compile(F("status")).Sql);
    }

    [Fact]
    public void An_unknown_operator_or_aggregate_is_refused_not_emitted()
    {
        Assert.Throws<InvalidOperationException>(() => Compile(Bin("%", F("amount"), F("qty"))));
        Assert.Throws<InvalidOperationException>(() => Compile(Agg("mode", F("amount"))));
        Assert.Throws<InvalidOperationException>(() => Compile(new UnNode("!", F("amount"))));
    }

    // ---- ClickHouseGateway.AggregateSql ----

    [Theory]
    [InlineData("sum", false, false, "sum(x)")]
    [InlineData("sum", true, false, "sum(x * t0._sample_factor)")]
    [InlineData("count", false, false, "count()")]
    [InlineData("count", true, false, "sum(t0._sample_factor)")]
    [InlineData("countnonnull", false, false, "count(x)")]
    [InlineData("countnonnull", true, false, "sum(if(isNotNull(x), t0._sample_factor, 0))")]
    [InlineData("avg", false, false, "avg(x)")]
    [InlineData("avg", true, false, "avg(x)")]
    [InlineData("min", true, false, "min(x)")]
    [InlineData("max", true, false, "max(x)")]
    [InlineData("countdistinct", false, false, "uniqExact(x)")]
    [InlineData("countdistinct", false, true, "uniq(x)")]
    [InlineData("countdistinct", true, false, "uniqExact(x)")]
    [InlineData("countdistinct", true, true, "uniq(x)")]
    [InlineData("median", false, false, "quantileExactInclusive(0.5)(x)")]
    [InlineData("median", true, true, "quantileExactInclusive(0.5)(x)")]
    [InlineData("stddev", false, false, "if(count(x) < 2, NULL, stddevSamp(x))")]
    [InlineData("stddev", true, true, "if(count(x) < 2, NULL, stddevSamp(x))")]
    [InlineData("variance", false, false, "if(count(x) < 2, NULL, varSamp(x))")]
    [InlineData("attr", false, false, "if(uniqExact(x) = 1, min(x), NULL)")]
    [InlineData("attr", true, true, "if(uniqExact(x) = 1, min(x), NULL)")]
    public void AggregateSql_follows_the_table(string agg, bool sampled, bool approximate, string expected)
        => Assert.Equal(expected, ClickHouseGateway.AggregateSql(agg, "x", sampled, approximate));

    [Fact]
    public void Percentile_binds_its_fraction_and_is_never_scaled()
    {
        Assert.Equal("quantileExactInclusive({c0p1:Float64})(x)", ClickHouseGateway.AggregateSql("percentile", "x", true, true, "{c0p1:Float64}"));
        Assert.Throws<InvalidOperationException>(() => ClickHouseGateway.AggregateSql("percentile", "x", false, false)); // no fraction text
    }

    [Fact]
    public void A_percentile_calculation_binds_the_fraction_after_the_argument_literals()
    {
        var (sql, ps) = Compile(new AggNode("percentile", Bin("*", F("amount"), new NumNode(2)), 0.9));
        Assert.Equal("quantileExactInclusive({c0p1:Float64})((toFloat64(t0.`amount`) * {c0p0:Float64}))", sql);
        Assert.Equal(new[] { ("c0p0", "Float64", (object)2d), ("c0p1", "Float64", (object)0.9d) }, ps);
    }

    [Theory]
    [InlineData("median", "quantileExactInclusive(0.5)(toFloat64(t0.`amount`))")]
    [InlineData("stddev", "if(count(toFloat64(t0.`amount`)) < 2, NULL, stddevSamp(toFloat64(t0.`amount`)))")]
    [InlineData("variance", "if(count(toFloat64(t0.`amount`)) < 2, NULL, varSamp(toFloat64(t0.`amount`)))")]
    public void The_new_aggregates_compile_over_a_widened_number(string fn, string expected)
    {
        var (sql, ps) = Compile(Agg(fn, F("amount")));
        Assert.Equal(expected, sql);
        Assert.Empty(ps);
    }

    [Fact]
    public void AggregateSql_refuses_an_unknown_aggregate()
        => Assert.Throws<InvalidOperationException>(() => ClickHouseGateway.AggregateSql("mode", "x", false, false));
}
