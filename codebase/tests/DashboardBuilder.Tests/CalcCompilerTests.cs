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
    public void Boolean_and_NULL_literals_are_fixed_keywords_not_user_text()
    {
        var (sql, ps) = Compile(new CaseNode([new WhenArm(new BoolNode(true), new NullNode())], new StrNode("x")));
        Assert.Equal("if(true, NULL, {c0p0:String})", sql);
        Assert.Single(ps);
        Assert.Equal("false", Compile(new BoolNode(false)).Sql);
    }

    [Fact]
    public void IN_binds_every_value_and_keeps_source_order()
    {
        var (sql, ps) = Compile(new InNode(F("qty"), [new NumNode(1), new NumNode(2)]));
        Assert.Equal("(toFloat64(t0.`qty`) IN ({c0p0:Float64}, {c0p1:Float64}))", sql);
        Assert.Equal(new[] { ("c0p0", "Float64", (object)1d), ("c0p1", "Float64", (object)2d) }, ps);
        var (tsql, tps) = Compile(new InNode(F("status"), [new StrNode("a' OR 1=1 --")]));
        Assert.Equal("(t0.`status` IN ({c0p0:String}))", tsql);
        Assert.DoesNotContain("OR 1=1", tsql);
        Assert.Equal("a' OR 1=1 --", tps[0].Value);
    }

    [Fact]
    public void A_date_literal_is_a_bound_string_read_as_a_Date_and_an_IN_list_of_dates_binds_each()
    {
        var (sql, ps) = Compile(new CmpNode(">=", F("placed"), new DateNode("2024-01-31")));
        Assert.Equal("(t0.`placed` >= toDate({c0p0:String}))", sql);
        Assert.Equal(new[] { ("c0p0", "String", (object)"2024-01-31") }, ps);
        var (isql, ips) = Compile(new InNode(F("placed"), [new DateNode("2024-01-01"), new DateNode("2024-02-29")]));
        Assert.Equal("(t0.`placed` IN (toDate({c0p0:String}), toDate({c0p1:String})))", isql);
        Assert.Equal(new[] { ("c0p0", "String", (object)"2024-01-01"), ("c0p1", "String", (object)"2024-02-29") }, ips);
    }

    [Fact]
    public void A_boolean_compared_with_equals_compiles_to_the_plain_comparison()
    {
        Assert.Equal("(t0.`active` = true)", Compile(new CmpNode("=", F("active"), new BoolNode(true))).Sql);
        Assert.Equal("(t0.`active` != false)", Compile(new CmpNode("!=", F("active"), new BoolNode(false))).Sql);
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

    [Fact]
    public void TEXT_compiles_to_toString_over_the_compiled_child_with_nothing_bound_for_a_field()
    {
        var (sql, ps) = Compile(Fn("text", F("placed")));
        Assert.Equal("toString(t0.`placed`)", sql);
        Assert.Empty(ps);
    }

    [Fact]
    public void TEXT_of_a_number_literal_binds_the_number_and_of_a_calculated_date_formats_the_date()
    {
        var (sql, ps) = Compile(Fn("text", new NumNode(12.5)));
        Assert.Equal("toString({c0p0:Float64})", sql);
        Assert.Single(ps);
        var (sql2, _) = Compile(Fn("text", Fn("date", S("2024-03-05"))));
        Assert.StartsWith("toString(", sql2);
        Assert.DoesNotContain("2024-03-05", sql2);
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

    [Theory]
    [InlineData("ltrim", "trimLeft(t0.`status`)")]
    [InlineData("rtrim", "trimRight(t0.`status`)")]
    public void LTRIM_and_RTRIM_strip_one_side(string fn, string expected)
    {
        var (sql, ps) = Compile(Fn(fn, F("status")));
        Assert.Equal(expected, sql);
        Assert.Empty(ps);
    }

    [Fact]
    public void FIND_counts_characters_and_binds_the_needle()
    {
        var (sql, ps) = Compile(Fn("find", F("status"), S("ab")));
        Assert.Equal("toFloat64(positionUTF8(t0.`status`, {c0p0:String}))", sql);
        Assert.Equal(new[] { ("c0p0", "String", (object)"ab") }, ps);
    }

    [Fact]
    public void MID_binds_start_and_length_as_unsigned_integers()
    {
        var (sql, ps) = Compile(Fn("mid", F("status"), new NumNode(2), new NumNode(3)));
        Assert.Equal("substringUTF8(t0.`status`, {c0p0:UInt32}, {c0p1:UInt32})", sql);
        Assert.Equal(new[] { ("c0p0", "UInt32", (object)2u), ("c0p1", "UInt32", (object)3u) }, ps);
    }

    [Fact]
    public void MID_without_a_length_runs_to_the_end()
    {
        var (sql, ps) = Compile(Fn("mid", F("status"), new NumNode(2)));
        Assert.Equal("substringUTF8(t0.`status`, {c0p0:UInt32})", sql);
        Assert.Equal(new[] { ("c0p0", "UInt32", (object)2u) }, ps);
    }

    [Fact]
    public void FIND_with_a_start_binds_it_as_an_unsigned_integer()
    {
        var (sql, ps) = Compile(Fn("find", F("status"), S("ab"), new NumNode(3)));
        Assert.Equal("toFloat64(positionUTF8(t0.`status`, {c0p0:String}, {c0p1:UInt32}))", sql);
        Assert.Equal(new[] { ("c0p0", "String", (object)"ab"), ("c0p1", "UInt32", (object)3u) }, ps);
    }

    [Theory]
    [InlineData("icontains", "(positionCaseInsensitiveUTF8(t0.`status`, {c0p0:String}) > 0)")]
    [InlineData("istartswith", "startsWith(lowerUTF8(t0.`status`), lowerUTF8({c0p0:String}))")]
    [InlineData("iendswith", "endsWith(lowerUTF8(t0.`status`), lowerUTF8({c0p0:String}))")]
    public void The_case_insensitive_predicates_bind_the_needle(string fn, string expected)
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
    public void Regular_expression_functions_bind_the_pattern_once_and_answer_NULL_for_no_match()
    {
        var (sql, ps) = Compile(Fn("regexp_match", F("status"), S("^op")));
        Assert.Equal("match(t0.`status`, {c0p0:String})", sql);
        Assert.Equal(new[] { ("c0p0", "String", (object)"^op") }, ps);
        (sql, ps) = Compile(Fn("regexp_extract", F("status"), S("([a-z]+)-")));
        Assert.Equal("if(match(t0.`status`, {c0p0:String}), extract(t0.`status`, {c0p0:String}), NULL)", sql); // one bound value, used twice
        Assert.Single(ps);
        (sql, ps) = Compile(Fn("regexp_extract_nth", F("status"), S("(a)(b)"), new NumNode(2)));
        Assert.Equal("if(match(t0.`status`, {c0p0:String}), regexpExtract(t0.`status`, {c0p0:String}, {c0p1:UInt32}), NULL)", sql);
        Assert.Equal(new[] { ("c0p0", "String", (object)"(a)(b)"), ("c0p1", "UInt32", (object)2u) }, ps);
        (sql, ps) = Compile(Fn("regexp_replace", F("status"), S("[^0-9]"), S("")));
        Assert.Equal("replaceRegexpAll(t0.`status`, {c0p0:String}, {c0p1:String})", sql);
        Assert.Equal(new[] { ("c0p0", "String", (object)"[^0-9]"), ("c0p1", "String", (object)"") }, ps);
    }

    [Fact]
    public void A_literal_inside_a_nested_text_function_keeps_source_order_numbering()
    {
        var (sql, ps) = Compile(Fn("left", Fn("replace", F("status"), S("a"), S("b")), new NumNode(4)));
        Assert.Equal("leftUTF8(replaceAll(t0.`status`, {c0p0:String}, {c0p1:String}), {c0p2:UInt32})", sql);
        Assert.Equal(3, ps.Count);
    }

    private const string Guard = "match({0}, '^[0-9 ,.+]+$') AND NOT match({0}, '^ *[0-9]{{8}} *$')";

    [Fact]
    public void DATEDIFF_binds_its_unit_and_widens_to_float()
    {
        var (sql, ps) = Compile(Fn("datediff", S("Month"), F("placed"), Fn("dateadd", S("day"), new NumNode(1), F("placed"))));
        var r = "addDays(toDateTime64(t0.`placed`, 0), {c0p1:Int32})";
        Assert.Equal($"toFloat64(dateDiff({{c0p0:String}}, t0.`placed`, if({r} > toDateTime64('1900-01-03 00:00:00', 0, 'UTC') AND {r} < toDateTime64('2299-12-29 00:00:00', 0, 'UTC'), {r}, NULL)))", sql);
        Assert.Equal(new[] { ("c0p0", "String", (object)"month"), ("c0p1", "Int32", (object)1) }, ps);
    }

    [Theory]
    [InlineData("year", "addYears")]
    [InlineData("quarter", "addQuarters")]
    [InlineData("month", "addMonths")]
    [InlineData("week", "addWeeks")]
    [InlineData("day", "addDays")]
    [InlineData("hour", "addHours")]
    [InlineData("minute", "addMinutes")]
    [InlineData("second", "addSeconds")]
    public void DATEADD_picks_a_fixed_function_per_unit_and_binds_only_the_amount(string unit, string function)
    {
        var (sql, ps) = Compile(Fn("dateadd", S(unit.ToUpperInvariant()), new UnNode("-", new NumNode(7)), F("placed")));
        var r = $"{function}(toDateTime64(t0.`placed`, 0), {{c0p0:Int32}})";
        Assert.Equal($"if({r} > toDateTime64('1900-01-03 00:00:00', 0, 'UTC') AND {r} < toDateTime64('2299-12-29 00:00:00', 0, 'UTC'), {r}, NULL)", sql);
        Assert.Equal(new[] { ("c0p0", "Int32", (object)(-7)) }, ps);
    }

    [Theory]
    [InlineData("year", "toFloat64(toYear(t0.`placed`))")]
    [InlineData("month", "toFloat64(toMonth(t0.`placed`))")]
    [InlineData("day", "toFloat64(toDayOfMonth(t0.`placed`))")]
    [InlineData("quarter", "toFloat64(toQuarter(t0.`placed`))")]
    [InlineData("week", "toFloat64(toISOWeek(t0.`placed`))")]
    [InlineData("weekday", "toFloat64(toDayOfWeek(t0.`placed`))")]
    public void Date_parts_are_fixed_functions_widened_to_float(string fn, string expected)
    {
        var (sql, ps) = Compile(Fn(fn, F("placed")));
        Assert.Equal(expected, sql);
        Assert.Empty(ps);
    }

    [Fact]
    public void ISOYEAR_is_a_fixed_function_widened_to_float()
    {
        var (sql, ps) = Compile(Fn("isoyear", F("placed")));
        Assert.Equal("toFloat64(toISOYear(t0.`placed`))", sql);
        Assert.Empty(ps);
    }

    [Theory]
    [InlineData("weekday", "dateName('weekday', toDateTime64(t0.`placed`, 0))")]
    [InlineData("Month", "dateName('month', toDateTime64(t0.`placed`, 0))")]
    [InlineData("year", "dateName('year', toDateTime64(t0.`placed`, 0))")]
    [InlineData("QUARTER", "dateName('quarter', toDateTime64(t0.`placed`, 0))")]
    public void DATENAME_picks_a_fixed_part_and_binds_nothing(string part, string expected)
    {
        var (sql, ps) = Compile(Fn("datename", S(part), F("placed")));
        Assert.Equal(expected, sql);
        Assert.Empty(ps);
    }

    [Theory]
    [InlineData("year")]
    [InlineData("quarter")]
    [InlineData("month")]
    [InlineData("week")]
    [InlineData("day")]
    [InlineData("hour")]
    [InlineData("minute")]
    [InlineData("second")]
    public void DATETRUNC_picks_a_fixed_unit_on_a_DateTime64_and_binds_nothing(string unit)
    {
        var (sql, ps) = Compile(Fn("datetrunc", S(unit.ToUpperInvariant()), F("placed")));
        var t = $"dateTrunc('{unit}', toDateTime64(t0.`placed`, 0))";
        Assert.Equal(unit is "year" or "quarter" or "month" or "week" ? $"toDateTime64({t}, 0)" : t, sql);
        Assert.Empty(ps);
    }

    [Fact]
    public void FISCALYEAR_binds_the_start_month_and_names_the_year_the_fiscal_year_ends_in()
    {
        var (sql, ps) = Compile(Fn("fiscalyear", new NumNode(10), F("placed")));
        Assert.Equal("toFloat64(toYear(t0.`placed`) + if({c0p0:Int32} > 1 AND toMonth(t0.`placed`) >= {c0p0:Int32}, 1, 0))", sql);
        Assert.Equal(new[] { ("c0p0", "Int32", (object)10) }, ps);
    }

    [Fact]
    public void FISCALQUARTER_counts_months_from_the_bound_start_month()
    {
        var (sql, ps) = Compile(Fn("fiscalquarter", new NumNode(4), F("placed")));
        Assert.Equal("toFloat64(intDiv((toInt32(toMonth(t0.`placed`)) - {c0p0:Int32} + 12) % 12, 3) + 1)", sql);
        Assert.Equal(new[] { ("c0p0", "Int32", (object)4) }, ps);
    }

    [Fact]
    public void MAKEDATE_guards_whole_numbers_range_and_the_day_round_trip_and_binds_each_literal_once()
    {
        var (sql, ps) = Compile(Fn("makedate", new NumNode(2024), new NumNode(2), new NumNode(30)));
        var (y, m, d) = ("{c0p0:Float64}", "{c0p1:Float64}", "{c0p2:Float64}");
        var x = $"makeDate32(toInt32({y}), toInt32({m}), toInt32({d}))";
        Assert.Equal($"if({y} = floor({y}) AND {m} = floor({m}) AND {d} = floor({d}) AND {y} >= 1901 AND {y} <= 2298 AND {m} >= 1 AND {m} <= 12 AND {d} >= 1 AND {d} <= 31 AND toDayOfMonth({x}) = {d}, toDateTime64({x}, 0), NULL)", sql);
        Assert.Equal(new[] { ("c0p0", "Float64", (object)2024.0), ("c0p1", "Float64", (object)2.0), ("c0p2", "Float64", (object)30.0) }, ps);
    }

    [Fact]
    public void DATE_guards_digit_only_text_and_out_of_range_results_and_binds_its_literal_once()
    {
        var (sql, ps) = Compile(Fn("date", S("2024-03-05")));
        var p = "parseDateTime64BestEffortOrNull({c0p0:String}, 0)";
        Assert.Equal($"if({string.Format(Guard, "{c0p0:String}")}, NULL, toDate(if({p} > toDateTime64('1970-01-02 00:00:00', 0) AND {p} < toDateTime64('2149-01-01 00:00:00', 0), {p}, NULL)))", sql);
        Assert.Equal(new[] { ("c0p0", "String", (object)"2024-03-05") }, ps);
    }

    [Fact]
    public void A_date_function_over_a_text_field_has_no_literal_text_in_the_sql()
    {
        var (sql, _) = Compile(Fn("datediff", S("day"), Fn("date", F("status")), Fn("dateadd", S("month"), new NumNode(3), F("placed"))));
        Assert.DoesNotContain("'day'", sql);
        Assert.DoesNotContain("'month'", sql);
    }
}
