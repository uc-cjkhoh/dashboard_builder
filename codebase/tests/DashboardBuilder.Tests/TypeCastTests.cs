using System.Text.Json;
using DashboardBuilder.ClickHouse;
using DashboardBuilder.ClickHouse.Calc;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>Type cast: the server whitelist, the SQL it writes, and the 400 shapes.</summary>
public class TypeCastTests
{
    private const string X = "t0.`c`";
    private static string Apply(string? cast, string category) => TypeCast.Apply(cast, X, category, "c", "rowDimensions[0]");

    [Fact] public void No_cast_leaves_the_expression_alone() => Assert.Equal(X, Apply(null, "text"));
    [Theory]
    [InlineData("text", "numeric", "toString(t0.`c`)")]
    [InlineData("text", "temporal", "toString(t0.`c`)")]
    [InlineData("text", "boolean", "toString(t0.`c`)")]
    [InlineData("text", "other", "toString(t0.`c`)")]
    [InlineData("text", "text", "t0.`c`")]
    [InlineData("number", "text", "if(isFinite(toFloat64OrNull(toString(t0.`c`))), toFloat64OrNull(toString(t0.`c`)), NULL)")]
    [InlineData("number", "boolean", "toFloat64(t0.`c`)")]
    [InlineData("number", "numeric", "t0.`c`")]
    [InlineData("date", "text", "if(match(toString(t0.`c`), '^[0-9 ,.+]+$') AND NOT match(toString(t0.`c`), '^ *[0-9]{8} *$'), NULL, parseDateTimeBestEffortOrNull(toString(t0.`c`)))")]
    [InlineData("date", "temporal", "t0.`c`")]
    public void Each_pairing_maps_to_one_safe_expression(string cast, string category, string sql) => Assert.Equal(sql, Apply(cast, category));

    [Theory] [InlineData("number", "temporal")] [InlineData("date", "numeric")] [InlineData("date", "boolean")] [InlineData("number", "other")]
    public void A_pairing_with_no_safe_conversion_is_a_400(string cast, string category)
    {
        var e = Assert.Throws<RequestValidationException>(() => Apply(cast, category));
        Assert.Equal("rowDimensions[0]", e.Field);
    }
    [Theory] [InlineData("Number")] [InlineData("int")] [InlineData("toString(x)")] [InlineData("")]
    public void An_unknown_cast_is_rejected_whatever_the_text(string cast) => Assert.Throws<RequestValidationException>(() => Apply(cast, "text"));

    [Theory] [InlineData("text", "text")] [InlineData("number", "numeric")] [InlineData("date", "temporal")]
    public void A_cast_decides_the_category(string cast, string category) => Assert.Equal(category, TypeCast.TargetCategory(cast));
    [Fact] public void The_effective_category_is_the_columns_own_without_a_cast() => Assert.Equal("text", TypeCast.EffectiveCategory("text", null));
    [Fact] public void A_date_cast_of_a_real_Date_column_stays_date_only() { Assert.True(TypeCast.DateOnly("date", true)); Assert.True(TypeCast.DateOnly(null, true)); }
    [Fact] public void A_date_cast_of_text_is_a_date_time() => Assert.False(TypeCast.DateOnly("date", false));
    [Fact] public void A_text_cast_of_a_Date_column_is_not_date_only() => Assert.False(TypeCast.DateOnly("text", true));

    // --- request rules -----------------------------------------------------------------
    private static QueryRequest Q(ColumnRef[]? rows = null, MeasureRef[]? measures = null, QueryFilter[]? filters = null) =>
        new(new TableRef("db", "t"), null, rows, null, measures, filters, null, null);
    private static string? FieldOf(QueryRequest r) => Assert.Throws<RequestValidationException>(() => RequestRules.ValidateQuery(r)).Field;

    [Theory] [InlineData("text")] [InlineData("number")] [InlineData("date")]
    public void A_known_cast_passes_on_a_dimension_a_measure_and_a_filter(string cast)
    {
        var top = new QueryFilter("db", "t", "c", "top", "5", null, new MeasureRef("db", "t", "c", "sum", null, cast), null, cast);
        RequestRules.ValidateQuery(Q(rows: [new("db", "t", "c", null, null, cast)], measures: [new("db", "t", "c", "min", null, cast)],
            filters: [new("db", "t", "c", "=", "1", null, null, null, cast), top]));
    }
    [Fact] public void An_unknown_dimension_cast_names_its_field() => Assert.Equal("rowDimensions[0].cast", FieldOf(Q(rows: [new("db", "t", "c", null, null, "bogus")])));
    [Fact] public void An_unknown_measure_cast_names_its_field() => Assert.Equal("measures[0].cast", FieldOf(Q(measures: [new("db", "t", "c", "sum", null, "bogus")])));
    [Fact] public void An_unknown_filter_cast_names_its_field() => Assert.Equal("filters[0].cast", FieldOf(Q(filters: [new("db", "t", "c", "=", "1", null, null, null, "bogus")])));
    [Fact] public void An_unknown_ranking_cast_names_its_field() =>
        Assert.Equal("filters[0].topBy.cast", FieldOf(Q(filters: [new("db", "t", "c", "top", "3", null, new MeasureRef("db", "t", "c", "sum", null, "bogus"))])));

    private static readonly ExprNode Calc = new NumNode(1);
    [Fact] public void A_cast_on_a_calculated_dimension_is_a_400() => Assert.Equal("rowDimensions[0].cast", FieldOf(Q(rows: [new("", "", "calc", null, Calc, "number")])));
    [Fact] public void A_cast_on_a_calculated_measure_is_a_400() => Assert.Equal("measures[0].cast", FieldOf(Q(measures: [new("", "", "calc", "sum", Calc, "text")])));

    [Fact] public void The_wire_reads_cast_as_a_string()
    {
        var json = """
            {"from":{"db":"d","table":"t"},"rowDimensions":[{"db":"d","table":"t","column":"c","cast":"date"}],
             "measures":[{"db":"d","table":"t","column":"c","agg":"max","cast":"number"}],
             "filters":[{"db":"d","table":"t","column":"c","op":"=","value":"1","cast":"number"}]}
            """;
        var r = JsonSerializer.Deserialize<QueryRequest>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        Assert.Equal("date", r.RowDimensions![0].Cast);
        Assert.Equal("number", r.Measures![0].Cast);
        Assert.Equal("number", r.Filters![0].Cast);
        RequestRules.ValidateQuery(r);
    }
}
