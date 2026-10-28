using DashboardBuilder.ClickHouse;
using DashboardBuilder.ClickHouse.Calc;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>Task 7 seams of the gateway: plain measures share <see cref="ClickHouseGateway.AggregateSql"/> (E10); calculated
/// dimensions, measures and Top-N ranks are validated against the catalog, compiled once and reused with their parameters.</summary>
public class CalcGatewayTests
{
    // Characterisation: the literal measure SQL QueryCoreAsync built inline before it called AggregateSql.
    [Theory]
    [InlineData("count", "", false, false, "count()")]
    [InlineData("count", "", true, false, "sum(t0._sample_factor)")]
    [InlineData("sum", "t0.`amount`", false, false, "sum(t0.`amount`)")]
    [InlineData("sum", "t0.`amount`", true, true, "sum(t0.`amount` * t0._sample_factor)")]
    [InlineData("countdistinct", "t0.`status`", false, false, "uniqExact(t0.`status`)")]
    [InlineData("countdistinct", "t0.`status`", false, true, "uniq(t0.`status`)")]
    [InlineData("countdistinct", "t0.`status`", true, true, "uniq(t0.`status`)")]
    [InlineData("min", "t0.`placed`", true, true, "min(t0.`placed`)")]
    [InlineData("max", "t0.`amount`", false, false, "max(t0.`amount`)")]
    [InlineData("avg", "t0.`amount`", true, true, "avg(t0.`amount`)")]
    public void Plain_measures_keep_the_sql_they_had_inline(string agg, string col, bool sampled, bool approximate, string expected) =>
        Assert.Equal(expected, ClickHouseGateway.AggregateSql(agg, col, sampled, approximate));

    private static readonly FieldNode Amount = new("db", "orders", "amount");
    private static readonly FieldNode Qty = new("db", "orders", "qty");
    private static readonly FieldNode Status = new("db", "orders", "status");
    private static readonly ExprNode Ratio = new BinNode("/", new AggNode("sum", Amount), new AggNode("sum", Qty));
    private static readonly ExprNode Doubled = new BinNode("*", Amount, new NumNode(2));

    // What the gateway resolves through QualifyAsync + the catalog for these fields.
    private static readonly Dictionary<(string, string, string), (string Sql, string Category)> Refs = new()
    {
        [("db", "orders", "amount")] = ("t0.`amount`", ClickHouseType.Numeric),
        [("db", "orders", "qty")] = ("t0.`qty`", ClickHouseType.Numeric),
        [("db", "orders", "status")] = ("t0.`status`", ClickHouseType.Text),
    };

    private static List<(string Name, string Type, object Value)> Ps() => [];

    private static CompiledCalc Compile(ExprNode n, string field = "measures[0]", string prefix = "c0",
        List<(string Name, string Type, object Value)>? ps = null, bool sampled = false, bool approximate = false) =>
        CalcSql.CompileCalc(n, field, Refs, ps ?? Ps(), prefix, sampled, approximate);

    private static string? FieldOf(Action a) => Assert.Throws<RequestValidationException>(a).Field;

    // --- countNonNull (E11) ---

    [Fact] public void CountNonNull_is_a_whitelisted_aggregation() => Assert.Contains("countnonnull", ClickHouseGateway.Aggregations);
    [Fact] public void CountNonNull_is_matched_case_insensitively() => Assert.Contains("countNonNull", ClickHouseGateway.Aggregations);

    [Fact] public void A_plain_countNonNull_on_a_text_column_passes_the_request_rules() =>
        RequestRules.ValidateQuery(new QueryRequest(new TableRef("db", "orders"), null, null, null,
            [new MeasureRef("db", "orders", "status", "countNonNull")], null, null, null));

    [Theory]
    [InlineData(false, "count(t0.`status`)")]
    [InlineData(true, "sum(if(isNotNull(t0.`status`), t0._sample_factor, 0))")]
    public void CountNonNull_counts_values_not_rows(bool sampled, string expected) =>
        Assert.Equal(expected, ClickHouseGateway.AggregateSql("countnonnull", "t0.`status`", sampled, sampled));

    [Theory]
    [InlineData("sum", "sum(t0.`amount`)")]
    [InlineData("avg", "avg(t0.`amount`)")]
    [InlineData("countdistinct", "uniqExact(t0.`amount`)")]
    [InlineData("countnonnull", "count(t0.`amount`)")]
    public void A_plain_top_n_rank_keeps_its_sql_and_learns_countNonNull(string agg, string expected) =>
        Assert.Equal(expected, ClickHouseGateway.PlainRankSql(agg, "t0.`amount`"));

    // --- Cache (Review Focus 5) ---

    [Fact]
    public void Requests_differing_only_in_a_calculation_never_share_a_cache_entry()
    {
        var info = new ClickHouseConnectionInfo("h", 8443, "u", "pw", true, false);
        QueryRequest Q(ExprNode calc) => new(new TableRef("db", "orders"), null, null, null,
            [new MeasureRef("", "", "Margin", null!, calc)], null, null, null);
        var other = new BinNode("/", new AggNode("sum", Qty), new AggNode("sum", Amount));
        Assert.NotEqual(ClickHouseGateway.CacheKey(info, Q(Ratio), 5000), ClickHouseGateway.CacheKey(info, Q(other), 5000));
        Assert.NotEqual(ClickHouseGateway.CacheKey(info, Q(new NumNode(1)), 5000), ClickHouseGateway.CacheKey(info, Q(new NumNode(2)), 5000));
    }

    // --- Joins can't be calculations ---

    [Theory]
    [InlineData(true, "joins[0].left.calc")]
    [InlineData(false, "joins[0].right.calc")]
    public void A_calculation_is_not_a_join_key(bool left, string field)
    {
        var plain = new ColumnRef("db", "orders", "id");
        var calc = new ColumnRef("db", "orders", "id", Calc: Doubled);
        var req = new QueryRequest(new TableRef("db", "orders"), [new JoinRef(left ? calc : plain, left ? plain : calc)], null, null, null, null, null, null);
        var e = Assert.Throws<RequestValidationException>(() => RequestRules.ValidateQuery(req));
        Assert.Equal(field, e.Field);
        Assert.Equal("Calculations can't be used as a join key.", e.Message);
    }

    // --- Field refs ---

    [Fact]
    public void Every_field_in_a_tree_is_collected_for_qualification() =>
        Assert.Equal([Amount, Qty, Status],
            CalcSql.CalcFields(new BinNode("+", Ratio, new UnNode("-", new AggNode("countd", Status)))));

    [Fact] public void A_constant_has_no_fields() => Assert.Empty(CalcSql.CalcFields(new BinNode("+", new NumNode(1), new NumNode(2))));

    // --- Validate + compile ---

    [Fact]
    public void A_ratio_compiles_as_an_aggregate_number()
    {
        var c = Compile(Ratio);
        Assert.Equal("(sum(toFloat64(t0.`amount`)) / nullIf(sum(toFloat64(t0.`qty`)), 0))", c.Sql);
        Assert.True(c.Info.IsAggregate);
        Assert.Equal(CalcType.Number, c.Info.Type);
    }

    [Fact]
    public void A_validation_error_names_the_node_under_the_request_field()
    {
        var bad = new BinNode("+", Status, Amount);
        var e = Assert.Throws<RequestValidationException>(() => Compile(bad, "rowDimensions[1]"));
        Assert.Equal("rowDimensions[1].calc.l", e.Field);
        Assert.Contains("Arithmetic needs numbers", e.Message);
    }

    [Fact] public void A_root_error_is_the_calc_itself() =>
        Assert.Equal("measures[2].calc", FieldOf(() => Compile(new AggNode("median", Amount), "measures[2]")));

    [Fact] public void An_unknown_field_is_a_400_with_its_path() =>
        Assert.Equal("filters[3].topBy.calc.arg", FieldOf(() => Compile(new AggNode("sum", new FieldNode("db", "orders", "nope")), "filters[3].topBy")));

    [Fact]
    public void A_constant_only_calculation_compiles_with_no_tables()
    {
        var ps = Ps();
        var c = Compile(new BinNode("+", new NumNode(1), new NumNode(2)), prefix: "c3", ps: ps);
        Assert.Empty(c.Info.Tables);
        Assert.Equal("({c3p0:Float64} + {c3p1:Float64})", c.Sql);
        Assert.Equal(["c3p0", "c3p1"], ps.Select(p => p.Name));
    }

    [Fact]
    public void Each_compiled_calculation_gets_its_own_parameter_names()
    {
        var ps = Ps();
        Compile(Doubled, prefix: "c0", ps: ps);
        Compile(Doubled, prefix: "c1", ps: ps);
        Assert.Equal(["c0p0", "c1p0"], ps.Select(p => p.Name));
    }

    // --- Measures (E4, E13) ---

    [Fact]
    public void An_aggregate_measure_is_used_as_is()
    {
        var (sql, numeric) = CalcSql.CalcMeasureSql(null, Compile(Ratio), "measures[0]", false, false);
        Assert.Equal("(sum(toFloat64(t0.`amount`)) / nullIf(sum(toFloat64(t0.`qty`)), 0))", sql);
        Assert.True(numeric);
    }

    [Theory]
    [InlineData("sum", false, false, "sum((toFloat64(t0.`amount`) * {c0p0:Float64}))")]
    [InlineData("SUM", true, true, "sum((toFloat64(t0.`amount`) * {c0p0:Float64}) * t0._sample_factor)")]
    [InlineData("avg", false, false, "avg((toFloat64(t0.`amount`) * {c0p0:Float64}))")]
    [InlineData("countDistinct", false, true, "uniq((toFloat64(t0.`amount`) * {c0p0:Float64}))")]
    [InlineData("countNonNull", false, false, "count((toFloat64(t0.`amount`) * {c0p0:Float64}))")]
    public void A_row_level_measure_is_aggregated_by_its_pill(string agg, bool sampled, bool approximate, string expected)
    {
        var (sql, numeric) = CalcSql.CalcMeasureSql(agg, Compile(Doubled), "measures[0]", sampled, approximate);
        Assert.Equal(expected, sql);
        Assert.True(numeric);
    }

    [Theory]
    [InlineData("min", false)]
    [InlineData("max", false)]
    [InlineData("countDistinct", true)]
    [InlineData("countNonNull", true)]
    public void A_text_measure_is_numeric_only_when_counted(string agg, bool numeric) =>
        Assert.Equal(numeric, CalcSql.CalcMeasureSql(agg, Compile(Status), "measures[0]", false, false).Numeric);

    [Fact] public void Summing_text_is_a_400() =>
        Assert.Equal("measures[1].calc", FieldOf(() => CalcSql.CalcMeasureSql("sum", Compile(Status), "measures[1]", false, false)));

    [Theory] [InlineData(null)] [InlineData("count")] [InlineData("median")]
    public void A_row_level_measure_needs_a_value_aggregation(string? agg) =>
        Assert.Equal("measures[0].calc", FieldOf(() => CalcSql.CalcMeasureSql(agg, Compile(Doubled), "measures[0]", false, false)));

    [Fact] public void An_aggregate_takes_no_further_aggregation() =>
        Assert.Equal("measures[0].calc", FieldOf(() => CalcSql.CalcMeasureSql("sum", Compile(Ratio), "measures[0]", false, false)));

    [Fact] public void An_aggregate_is_not_a_dimension() =>
        Assert.Equal("rowDimensions[0].calc", FieldOf(() => CalcSql.CalcDimensionSql(Compile(Ratio, "rowDimensions[0]"), "rowDimensions[0]")));

    [Fact] public void A_row_level_dimension_groups_by_its_expression() =>
        Assert.Equal("(toFloat64(t0.`amount`) * {c0p0:Float64})", CalcSql.CalcDimensionSql(Compile(Doubled, "rowDimensions[0]"), "rowDimensions[0]"));

    // --- Names ---

    [Theory]
    [InlineData("Margin", "Margin")]
    [InlineData(null, "calculation")]
    [InlineData("", "calculation")]
    public void A_calculation_is_named_by_its_label(string? label, string expected) => Assert.Equal(expected, CalcSql.CalcLabel(label));

    [Fact] public void An_over_long_label_is_not_echoed() => Assert.Equal("calculation", CalcSql.CalcLabel(new string('x', 61)));

    // --- Reuse in the Other / total / auto-grain statements (Review Focus 2) ---

    [Fact]
    public void The_other_statement_reuses_the_measure_sql_and_every_parameter_it_needs()
    {
        var ps = new List<(string Name, string Type, object Value)> { ("p0", "String", "x") };
        var dim = Compile(new BinNode("+", Amount, new NumNode(1)), "rowDimensions[0]", "c0", ps);
        var meas = CalcSql.CalcMeasureSql("sum", Compile(Doubled, "measures[0]", "c1", ps), "measures[0]", false, false).Sql;
        const string from = " FROM `db`.`orders` AS t0", where = " WHERE t0.`status` = {p0:String}";
        var ordered = $"SELECT {dim.Sql} AS k0, {meas} AS v0{from}{where} GROUP BY k0 ORDER BY v0 DESC";
        var sql = ClickHouseGateway.OtherSql(dim.Sql, [meas], from, where, ordered, 11, "");
        Assert.Equal(
            $"SELECT uniqExact({dim.Sql}) + max(isNull({dim.Sql})) AS n, {meas} AS v0{from}{where} AND {dim.Sql} NOT IN (SELECT k0 FROM ({ordered} LIMIT 10)) SETTINGS transform_null_in = 1",
            sql);
        Assert.Equal(["p0", "c0p0", "c1p0"], ClickHouseGateway.ParametersUsedBy(sql, ps).Select(p => p.Name));
    }

    // uniqExact skips NULL, so a NULL group past the limit (e.g. a nullIf division key) is counted separately.
    [Fact]
    public void The_other_statement_without_filters_starts_its_own_where() =>
        Assert.Equal("SELECT uniqExact(k) + max(isNull(k)) AS n, m AS v0 FROM t WHERE k NOT IN (SELECT k0 FROM (o LIMIT 4)) SETTINGS transform_null_in = 1, join_use_nulls = 1",
            ClickHouseGateway.OtherSql("k", ["m"], " FROM t", "", "o", 5, ", join_use_nulls = 1"));

    [Fact]
    public void Only_the_parameters_a_statement_uses_are_sent()
    {
        var ps = new List<(string Name, string Type, object Value)> { ("p1", "String", "a"), ("p10", "String", "b"), ("c0p0", "Float64", 2.0) };
        Assert.Equal(["p10"], ClickHouseGateway.ParametersUsedBy("x = {p10:String}", ps).Select(p => p.Name));
    }

    [Fact]
    public void Approximate_mode_reports_distinct_estimates_from_calculations_too()
    {
        Assert.True(CalcSql.UsesDistinctCount([new MeasureRef("db", "orders", "status", "countDistinct")]));
        Assert.True(CalcSql.UsesDistinctCount([new MeasureRef("", "", "n", null!, new AggNode("countd", Status))]));
        Assert.False(CalcSql.UsesDistinctCount([new MeasureRef("", "", "r", null!, Ratio)]));
    }

    // A calculation field must be on a table already in the query; the check runs before any catalog lookup, so a calculation
    // can't make the server describe arbitrary tables, and an existing and an unknown column answer the same way.
    [Theory]
    [InlineData("amount")]
    [InlineData("nope")]
    public async Task A_field_on_a_table_not_in_the_query_is_rejected_before_any_catalog_lookup(string column)
    {
        var lookups = new List<string>();
        var ex = await Assert.ThrowsAsync<UnknownIdentifierException>(() => CalcSql.ResolveCalcRefsAsync(
            [new FieldNode("db", "other", column)],
            (db, table) => table == "orders",
            (db, table) => { lookups.Add($"{db}.{table}"); return Task.FromResult(new Dictionary<string, string> { ["amount"] = ClickHouseType.Numeric }); },
            (db, table, c) => { lookups.Add($"{db}.{table}.{c}"); return Task.FromResult($"t0.`{c}`"); }));
        Assert.Equal("Field references a table not in the query.", ex.Message);
        Assert.Empty(lookups);
    }

    [Fact]
    public async Task Fields_on_tables_in_the_query_resolve_and_an_unknown_column_is_left_for_the_validator()
    {
        var refs = await CalcSql.ResolveCalcRefsAsync(
            [new FieldNode("db", "orders", "amount"), new FieldNode("db", "orders", "amount"), new FieldNode("db", "orders", "nope")],
            (db, table) => table == "orders",
            (db, table) => Task.FromResult(new Dictionary<string, string> { ["amount"] = ClickHouseType.Numeric }),
            (db, table, c) => Task.FromResult($"t0.`{c}`"));
        var only = Assert.Single(refs);
        Assert.Equal(("db", "orders", "amount"), only.Key);
        Assert.Equal(("t0.`amount`", ClickHouseType.Numeric), only.Value);
    }

    private static string Chain(int levels)
    {
        var node = "{\"k\":\"field\",\"db\":\"d\",\"table\":\"t\",\"column\":\"c\"}";
        for (var i = 1; i < levels; i++) node = "{\"k\":\"un\",\"op\":\"-\",\"arg\":" + node + "}";
        return "{\"from\":{\"db\":\"d\",\"table\":\"t\"},\"rowDimensions\":[{\"db\":\"\",\"table\":\"\",\"column\":\"D\",\"calc\":" + node + "}]}";
    }

    [Theory] [InlineData(30)] [InlineData(60)] [InlineData(5000)]
    public async Task A_deeply_nested_calc_is_a_400_with_an_error_body_not_a_500(int levels)
    {
        await using var factory = new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program>();
        var r = await factory.CreateClient().PostAsync("/api/query", new System.Net.Http.StringContent(Chain(levels), System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(System.Net.HttpStatusCode.BadRequest, r.StatusCode);
        var json = System.Text.Json.JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement;
        Assert.True(json.TryGetProperty("error", out var e) && e.GetString()!.Length > 0);
    }
}
