using DashboardBuilder.ClickHouse;
using DashboardBuilder.ClickHouse.Calc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static DashboardBuilder.Tests.StubClickHouse;

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

    // ---- through the gateway, against a stub ClickHouse endpoint ----------------------------------------------------------------
    private static Result Answer(string sql)
    {
        if (sql.StartsWith("SHOW DATABASES")) return new([new Col("name", "String")], [["db"]]);
        if (sql.StartsWith("SHOW TABLES")) return new([new Col("name", "String")], [["orders"], ["customers"]]);
        if (sql.StartsWith("DESCRIBE TABLE"))
            return sql.Contains("`customers`")
                ? new([new Col("name", "String"), new Col("type", "String")], [["id", "UInt64"], ["country", "String"]])
                : new([new Col("name", "String"), new Col("type", "String")], [["amount", "Float64"], ["cid", "UInt64"], ["status", "String"]]);
        if (sql.Contains("minIf(")) return new([new Col("__bx_label", "String"), new Col("wlo", "Float64"), new Col("whi", "Float64")], [["DE", 2.0, 9.0]]);
        if (sql.Contains("AS label, d.__bx_v AS v")) return new([new Col("label", "String"), new Col("v", "Float64")], [["DE", 99.0]]);
        return new([new Col("__bx_label", "String"), new Col("lo", "Float64"), new Col("q1", "Float64"), new Col("med", "Float64"), new Col("q3", "Float64"), new Col("hi", "Float64")],
            [["DE", 1.0, 3.0, 5.0, 7.0, 99.0]]);
    }

    private static readonly JoinRef Orders = new(new ColumnRef("db", "orders", "cid"), new ColumnRef("db", "customers", "id"));
    private static readonly ColumnRef Country = new("db", "customers", "country");

    private static async Task<(StubClickHouse Stub, BoxPlotResult Result)> Run(QueryRequest req)
    {
        var stub = new StubClickHouse(Answer);
        var gw = new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance);
        var result = await gw.BoxPlotAsync(new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false), req, default);
        return (stub, result);
    }
    private static List<Seen> BoxStatements(StubClickHouse s) => s.Statements.Where(x => x.Sql.Contains("__bx_")).ToList();
    private static QueryRequest Joined(ColumnRef value, JoinRef? join = null, QueryFilter[]? filters = null) =>
        new(new TableRef("db", "orders"), [join ?? Orders], [value], [Country], null, filters, 10, null);

    [Fact] public async Task A_two_table_box_plot_reads_the_joined_FROM_in_all_three_statements_and_returns_the_boxes()
    {
        var req = Joined(Value, filters: [new QueryFilter("db", "customers", "country", "=", "DE")]);
        var (stub, result) = await Run(req);
        using var _ = stub;
        var sts = BoxStatements(stub);
        Assert.Equal(3, sts.Count); // summary, whiskers, outliers
        foreach (var st in sts)
        {
            Assert.Contains("FROM `db`.`orders` AS t0 INNER JOIN `db`.`customers` AS t1 ON t0.`cid` = t1.`id` WHERE t1.`country` = {p0:String}", st.Sql);
            Assert.Contains("param_p0=DE", st.Url);
            Assert.DoesNotContain("join_use_nulls", st.Sql);
            Assert.DoesNotContain("DE'", st.Sql); // the value is bound, never text
        }
        Assert.StartsWith("SELECT t1.`country` AS __bx_label, min(t0.`amount`)", sts[0].Sql);
        Assert.EndsWith(" LIMIT 11", sts[0].Sql);
        Assert.Contains("LIMIT 501", sts[2].Sql);
        var g = Assert.Single(result.Groups);
        Assert.Equal(("DE", 3.0, 5.0, 7.0, 2.0, 9.0), (g.Label, g.Q1, g.Median, g.Q3, g.LowerWhisker, g.UpperWhisker));
        Assert.Equal(99.0, Assert.Single(result.Outliers!).Value);
    }

    [Fact] public async Task A_left_join_asks_for_nulls_once_per_statement()
    {
        var (stub, _) = await Run(Joined(Value, Orders with { Type = "left" }));
        using var _ = stub;
        var sts = BoxStatements(stub);
        Assert.Equal(3, sts.Count);
        foreach (var st in sts)
        {
            Assert.Contains(" LEFT JOIN `db`.`customers` AS t1", st.Sql);
            Assert.Single(System.Text.RegularExpressions.Regex.Matches(st.Sql, "join_use_nulls = 1"));
            Assert.EndsWith(" SETTINGS join_use_nulls = 1", st.Sql);
        }
    }

    [Fact] public async Task A_calculated_value_is_compiled_into_each_statement_with_its_literals_bound()
    {
        var calc = new ColumnRef("", "", "Doubled", Calc: new BinNode("*", new FieldNode("db", "orders", "amount"), new NumNode(2)));
        var (stub, _) = await Run(Joined(calc));
        using var _ = stub;
        var sts = BoxStatements(stub);
        Assert.Equal(3, sts.Count);
        foreach (var st in sts)
        {
            Assert.Contains("t0.`amount`", st.Sql);
            Assert.Matches(@"\{c0[^}]*\}", st.Sql); // the literal 2 is a bound parameter
            Assert.Contains("param_c0", st.Url);
        }
        Assert.DoesNotContain("* 2", sts[0].Sql);
    }

    [Fact] public async Task An_aggregate_calculation_value_is_refused_naming_its_field()
    {
        var agg = new ColumnRef("", "", "Total", Calc: new AggNode("sum", new FieldNode("db", "orders", "amount")));
        var stub = new StubClickHouse(Answer);
        using var _ = stub;
        var gw = new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance);
        var e = await Assert.ThrowsAsync<RequestValidationException>(() => gw.BoxPlotAsync(new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false), Joined(agg), default));
        Assert.Equal("rowDimensions[0].calc", e.Field);
        Assert.Empty(BoxStatements(stub));
    }

    [Fact] public async Task A_non_numeric_value_is_refused_before_any_box_statement()
    {
        var text = new ColumnRef("db", "orders", "status");
        var stub = new StubClickHouse(Answer);
        using var _ = stub;
        var gw = new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance);
        var e = await Assert.ThrowsAsync<RequestValidationException>(() => gw.BoxPlotAsync(new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false), Joined(text), default));
        Assert.Equal("rowDimensions[0]", e.Field);
        Assert.Contains("numeric", e.Message);
        Assert.Empty(BoxStatements(stub));
    }
}
