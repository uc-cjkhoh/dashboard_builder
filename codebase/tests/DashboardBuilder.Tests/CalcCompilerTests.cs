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

    // ---- logic: comparisons, connectives, IF / CASE / IFNULL ----

    private static CmpNode Cmp(string op, ExprNode l, ExprNode r) => new(op, l, r);
    private static readonly CmpNode Big = new(">", F("amount"), new NumNode(100));

    [Fact]
    public void A_comparison_binds_its_literal()
    {
        var (sql, ps) = Compile(Cmp(">=", F("amount"), new NumNode(100)));
        Assert.Equal("(toFloat64(t0.`amount`) >= {c0p0:Float64})", sql);
        Assert.Equal(new[] { ("c0p0", "Float64", (object)100d) }, ps);
    }

    [Fact]
    public void A_text_literal_is_a_bound_String_never_in_the_SQL()
    {
        var (sql, ps) = Compile(Cmp("=", F("status"), new StrNode("o'pen'; DROP TABLE x")));
        Assert.Equal("(t0.`status` = {c0p0:String})", sql);
        Assert.DoesNotContain("DROP", sql);
        Assert.DoesNotContain("pen", sql);
        Assert.Equal(new[] { ("c0p0", "String", (object)"o'pen'; DROP TABLE x") }, ps);
    }

    [Fact]
    public void Connectives_and_negation_are_function_calls()
    {
        var (sql, _) = Compile(new LogicNode("or", new LogicNode("and", Big, Cmp("<", F("qty"), new NumNode(5))), new NotNode(Cmp("=", F("status"), new StrNode("x")))));
        Assert.Equal("or(and((toFloat64(t0.`amount`) > {c0p0:Float64}), (toFloat64(t0.`qty`) < {c0p1:Float64})), not((t0.`status` = {c0p2:String})))", sql);
    }

    [Fact]
    public void IF_is_if_and_a_NULL_condition_falls_to_the_else()
    {
        var (sql, ps) = Compile(new CaseNode([new WhenArm(Big, new StrNode("big"))], new StrNode("small")));
        Assert.Equal("if((toFloat64(t0.`amount`) > {c0p0:Float64}), {c0p1:String}, {c0p2:String})", sql);
        Assert.Equal(new[] { "Float64", "String", "String" }, ps.Select(p => p.Type));
    }

    [Fact]
    public void CASE_is_multiIf_and_without_ELSE_ends_in_NULL()
    {
        var two = new CaseNode([new WhenArm(Big, new NumNode(1)), new WhenArm(Cmp(">", F("amount"), new NumNode(10)), new NumNode(2))], new NumNode(0));
        Assert.Equal("multiIf((toFloat64(t0.`amount`) > {c0p0:Float64}), {c0p1:Float64}, (toFloat64(t0.`amount`) > {c0p2:Float64}), {c0p3:Float64}, {c0p4:Float64})", Compile(two).Sql);
        Assert.Equal("multiIf((toFloat64(t0.`amount`) > {c0p0:Float64}), {c0p1:Float64}, NULL)", Compile(new CaseNode([new WhenArm(Big, new NumNode(1))], null)).Sql);
    }

    [Fact]
    public void IFNULL_and_ISNULL()
    {
        Assert.Equal("ifNull(toFloat64(t0.`amount`), {c0p0:Float64})", Compile(new IfNullNode(F("amount"), new NumNode(0))).Sql);
        Assert.Equal("isNull(t0.`status`)", Compile(new IsNullNode(F("status"))).Sql);
    }

    [Fact]
    public void Division_inside_a_branch_keeps_nullIf()
        => Assert.Equal("if((toFloat64(t0.`qty`) > {c0p0:Float64}), (toFloat64(t0.`amount`) / nullIf(toFloat64(t0.`qty`), 0)), {c0p1:Float64})",
            Compile(new CaseNode([new WhenArm(Cmp(">", F("qty"), new NumNode(0)), Bin("/", F("amount"), F("qty")))], new NumNode(0))).Sql);

    [Fact]
    public void An_unknown_comparison_or_logic_operator_is_refused_not_emitted()
    {
        Assert.Throws<InvalidOperationException>(() => Compile(Cmp("~", F("amount"), F("qty"))));
        Assert.Throws<InvalidOperationException>(() => Compile(new LogicNode("xor", Big, Big)));
    }

    [Fact]
    public void A_sampled_aggregate_over_a_conditional_is_scaled_once()
        => Assert.Equal("sum(if((t0.`status` = {c0p0:String}), toFloat64(t0.`amount`), {c0p1:Float64}) * t0._sample_factor)",
            Compile(Agg("sum", new CaseNode([new WhenArm(Cmp("=", F("status"), new StrNode("open")), F("amount"))], new NumNode(0))), sampled: true).Sql);

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

    // ---- text functions: fixed ClickHouse functions over compiled children; every literal bound ----

    private static FnNode Fn(string fn, params ExprNode[] args) => new(fn, args);
    private static StrNode S(string v) => new(v);

    [Theory]
    [InlineData("lower", "lowerUTF8(t0.`status`)")]
    [InlineData("upper", "upperUTF8(t0.`status`)")]
    [InlineData("trim", "trimBoth(t0.`status`)")]
    [InlineData("len", "toFloat64(lengthUTF8(t0.`status`))")]
    public void One_argument_text_functions_compile_to_utf8_aware_functions(string fn, string expected)
    {
        var (sql, ps) = Compile(Fn(fn, F("status")));
        Assert.Equal(expected, sql);
        Assert.Empty(ps);
    }

    [Theory]
    [InlineData("left", "leftUTF8(t0.`status`, {c0p0:UInt32})")]
    [InlineData("right", "rightUTF8(t0.`status`, {c0p0:UInt32})")]
    public void LEFT_and_RIGHT_bind_the_length_as_an_unsigned_integer(string fn, string expected)
    {
        var (sql, ps) = Compile(Fn(fn, F("status"), new NumNode(3)));
        Assert.Equal(expected, sql);
        Assert.Equal(new[] { ("c0p0", "UInt32", (object)3u) }, ps);
    }

    [Fact]
    public void REPLACE_binds_both_strings_and_never_writes_them_into_the_sql()
    {
        var (sql, ps) = Compile(Fn("replace", F("status"), S("secret-a"), S("secret-b")));
        Assert.Equal("replaceAll(t0.`status`, {c0p0:String}, {c0p1:String})", sql);
        Assert.DoesNotContain("secret", sql);
        Assert.Equal(new[] { ("c0p0", "String", (object)"secret-a"), ("c0p1", "String", (object)"secret-b") }, ps);
    }

    [Fact]
    public void CONCAT_joins_its_arguments_in_order()
    {
        var (sql, ps) = Compile(Fn("concat", F("status"), S(" - "), F("status")));
        Assert.Equal("concat(t0.`status`, {c0p0:String}, t0.`status`)", sql);
        Assert.Equal(new[] { ("c0p0", "String", (object)" - ") }, ps);
    }

    [Theory]
    [InlineData("contains", "(position(t0.`status`, {c0p0:String}) > 0)")]
    [InlineData("startswith", "startsWith(t0.`status`, {c0p0:String})")]
    [InlineData("endswith", "endsWith(t0.`status`, {c0p0:String})")]
    public void The_text_predicates_are_case_sensitive_and_bind_the_needle(string fn, string expected)
    {
        var (sql, ps) = Compile(Fn(fn, F("status"), S("ab")));
        Assert.Equal(expected, sql);
        Assert.Equal(new[] { ("c0p0", "String", (object)"ab") }, ps);
    }

    [Fact]
    public void SPLIT_is_null_for_a_null_value_and_for_a_position_past_the_last_token()
    {
        var (sql, ps) = Compile(Fn("split", Fn("lower", F("status")), S("-"), new NumNode(2)));
        Assert.Equal("if(isNull(lowerUTF8(t0.`status`)), NULL, arrayElementOrNull(splitByString({c0p0:String}, assumeNotNull(lowerUTF8(t0.`status`))), {c0p1:UInt32}))", sql);
        Assert.Equal(new[] { ("c0p0", "String", (object)"-"), ("c0p1", "UInt32", (object)2u) }, ps);
    }

    [Fact]
    public void A_literal_inside_a_nested_text_function_keeps_source_order_numbering()
    {
        var (sql, ps) = Compile(Fn("left", Fn("replace", F("status"), S("a"), S("b")), new NumNode(4)));
        Assert.Equal("leftUTF8(replaceAll(t0.`status`, {c0p0:String}, {c0p1:String}), {c0p2:UInt32})", sql);
        Assert.Equal(3, ps.Count);
    }
}
