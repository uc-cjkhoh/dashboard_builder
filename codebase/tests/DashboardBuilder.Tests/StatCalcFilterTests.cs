using DashboardBuilder.ClickHouse;
using DashboardBuilder.ClickHouse.Calc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static DashboardBuilder.Tests.StubClickHouse;

namespace DashboardBuilder.Tests;

/// <summary>A row-level calculated field as a histogram filter: the same tree the worksheet query takes, compiled against the
/// histogram's one table (a field on any other table is refused), its compared values bound, and placed in every WHERE.</summary>
public class StatCalcFilterTests
{
    private static readonly FieldNode Amount = new("db", "orders", "amount");
    private static readonly ExprNode Doubled = new BinNode("*", Amount, new NumNode(2));
    private static readonly ExprNode Total = new AggNode("sum", Amount);

    private static StatFilter F(string op, ExprNode calc, string? value = null, string[]? values = null) => new("Doubled", op, value, values, calc);
    private static HistogramRequest H(params StatFilter[] f) => new("amount", 5, f);
    private static string? FieldOf(Action a) => Assert.Throws<RequestValidationException>(a).Field;

    private static IReadOnlyDictionary<string, ColumnInfo> Cols() => new Dictionary<string, ColumnInfo>
    {
        ["amount"] = new ColumnInfo("amount", "Float64", ClickHouseType.Numeric),
        ["status"] = new ColumnInfo("status", "String", ClickHouseType.Text),
    };

    [Fact] public void A_row_level_calculation_filter_passes_the_histogram_rules() => RequestRules.ValidateHistogram(H(F(">", Doubled, "10")));
    [Fact] public void An_aggregate_calculation_filter_is_a_400_naming_the_calc() =>
        Assert.Equal("filters[0].calc", FieldOf(() => RequestRules.ValidateHistogram(H(F(">", Total, "10")))));
    [Fact] public void A_calculation_filter_can_not_be_a_top_n() =>
        Assert.Equal("filters[0].op", FieldOf(() => RequestRules.ValidateHistogram(H(F("top", Doubled, "5")))));
    [Fact] public void A_too_deep_calculation_is_a_400()
    {
        ExprNode e = Amount; for (var i = 0; i < 13; i++) e = new BinNode("+", e, new NumNode(1));
        Assert.StartsWith("filters[0].calc", FieldOf(() => RequestRules.ValidateHistogram(H(F("=", e, "1")))));
    }
    [Fact] public void The_box_plot_endpoint_validates_a_calculation_filter_the_same_way() =>
        Assert.Equal("filters[0].calc", FieldOf(() => RequestRules.ValidateBoxPlot(new BoxPlotRequest(null, "amount", [F(">", Total, "1")], 10))));

    [Fact] public void A_calculation_becomes_a_where_condition_with_its_values_bound()
    {
        var ps = new List<(string Name, string Type, object Value)>();
        var sql = ClickHouseGateway.BuildSingleTableFilters([F(">", Doubled, "10")], Cols(), ps, "db", "orders");
        Assert.StartsWith(" WHERE ", sql);
        Assert.Contains("`amount`", sql);
        Assert.Contains("{p0:", sql);
        Assert.DoesNotContain("10", sql); // the compared value is bound, never text
        Assert.Contains(ps, p => p.Name == "p0");
    }
    [Fact] public void A_field_on_another_table_is_refused()
    {
        var other = new BinNode("*", new FieldNode("db", "customers", "id"), new NumNode(2));
        Assert.Throws<UnknownIdentifierException>(() => ClickHouseGateway.BuildSingleTableFilters([F(">", other, "1")], Cols(), [], "db", "orders"));
    }
    [Fact] public void An_unknown_column_is_refused_with_its_path()
    {
        var ghost = new BinNode("*", new FieldNode("db", "orders", "ghost"), new NumNode(2));
        Assert.Throws<RequestValidationException>(() => ClickHouseGateway.BuildSingleTableFilters([F(">", ghost, "1")], Cols(), [], "db", "orders"));
    }
    [Fact] public void A_plain_and_a_calculated_filter_share_one_where()
    {
        var sql = ClickHouseGateway.BuildSingleTableFilters([new StatFilter("status", "=", "x"), F(">", Doubled, "10")], Cols(), [], "db", "orders");
        Assert.Contains(" AND ", sql);
        Assert.Contains("`status` = {p0:String}", sql);
    }

    private static Result Answer(string sql)
    {
        if (sql.StartsWith("SHOW DATABASES")) return new([new Col("name", "String")], [["db"]]);
        if (sql.StartsWith("SHOW TABLES")) return new([new Col("name", "String")], [["orders"]]);
        if (sql.StartsWith("DESCRIBE TABLE")) return new([new Col("name", "String"), new Col("type", "String")], [["amount", "Float64"]]);
        return new([new Col("bin", "UInt64"), new Col("x0", "Float64"), new Col("x1", "Float64"), new Col("c", "UInt64")], [[0UL, 0.0, 10.0, 7UL]]);
    }

    [Fact] public async Task The_histogram_applies_the_calculation_in_the_lo_hi_and_bucket_statements_through_the_stub()
    {
        using var stub = new StubClickHouse(Answer);
        var gw = new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance);
        var res = await gw.HistogramAsync(new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false), "db", "orders", H(F(">", Doubled, "10")), default);
        Assert.Equal(7, Assert.Single(res.Bins).Count);
        var st = Assert.Single(stub.Statements, s => s.Sql.Contains("GROUP BY bin"));
        Assert.Equal(3, System.Text.RegularExpressions.Regex.Matches(st.Sql, @"\(toFloat64\(`amount`\) \* \{c0p0:Float64\}\) > \{p0:Float64\}").Count); // min, max and the bucket scan
        Assert.Contains("param_c0p0=2", st.Url); // min, max, and the bucket scan
        Assert.Contains("param_p0=10", st.Url);
    }
}
