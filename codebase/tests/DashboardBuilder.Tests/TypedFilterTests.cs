using DashboardBuilder.ClickHouse; using Xunit;
namespace DashboardBuilder.Tests;
public class TypedFilterTests
{
    private static (string, object) C(string cat, string raw) => FilterValues.Coerce(cat, "amount", raw, "filters[0]");
    [Theory] [InlineData("12.5", 12.5)] [InlineData(" -3 ", -3.0)] [InlineData("1e3", 1000.0)] [InlineData(".5", 0.5)]
    public void Plain_numbers_bind_as_float(string raw, double expected) => Assert.Equal(("Float64", (object)expected), C(ClickHouseType.Numeric, raw));
    [Theory] [InlineData("1,5")] [InlineData("1,000")] [InlineData("1 000")] [InlineData("0x10")] [InlineData("abc")] [InlineData("NaN")] [InlineData("Infinity")] [InlineData("")]
    public void Anything_else_on_a_number_column_is_rejected_naming_the_column(string raw)
        => Assert.Contains("amount", Assert.Throws<RequestValidationException>(() => C(ClickHouseType.Numeric, raw)).Message);
    [Theory] [InlineData("2024-01-31", "2024-01-31")] [InlineData("2024-01-31T10:20", "2024-01-31 10:20:00")] [InlineData("2024-01-31 10:20:30", "2024-01-31 10:20:30")]
    public void Iso_dates_normalise(string raw, string bound) => Assert.Equal(("String", (object)bound), C(ClickHouseType.Temporal, raw));
    [Theory] [InlineData("31/01/2024")] [InlineData("2024-13-01")] [InlineData("yesterday")]
    public void Other_dates_are_rejected(string raw) => Assert.Throws<RequestValidationException>(() => C(ClickHouseType.Temporal, raw));
    [Fact] public void Booleans_accept_true_false_1_0() => Assert.Equal(("UInt8", (object)(byte)1), C(ClickHouseType.Boolean, "TRUE"));
    [Fact] public void Yes_is_not_a_boolean() => Assert.Throws<RequestValidationException>(() => C(ClickHouseType.Boolean, "yes"));
    [Fact] public void Compound_columns_cannot_be_filtered() => Assert.Throws<RequestValidationException>(() => C(ClickHouseType.Compound, "x"));
    [Fact] public void An_inverted_numeric_range_is_rejected()
        => Assert.Throws<RequestValidationException>(() => ClickHouseGateway.BuildCondition("between", "p0", "c", ClickHouseType.Numeric, "c", "filters[0]", null, ["9", "1"], []));
    [Fact] public void A_numeric_in_list_binds_a_float_array()
    {
        var p = new List<(string, string, object)>();
        Assert.Equal("c IN {p0:Array(Float64)}", ClickHouseGateway.BuildCondition("in", "p0", "c", ClickHouseType.Numeric, "c", "f", null, ["1", "2"], p));
        Assert.Equal("Array(Float64)", p[0].Item2);
    }
    [Fact] public void Not_a_number_results_become_null() => Assert.Null(ClickHouseGateway.ToResultValue(double.NaN, true));
    [Fact] public void Infinite_results_become_null() => Assert.Null(ClickHouseGateway.ToResultValue(double.PositiveInfinity, true));
    [Fact] public void Integers_become_doubles() => Assert.Equal(5.0, ClickHouseGateway.ToResultValue(5L, true));
    [Fact] public void Date_min_max_read_as_iso_text() => Assert.Equal("2024-01-02", ClickHouseGateway.ToResultValue(new DateTime(2024, 1, 2), false));
    [Fact] public void Csv_writes_null_as_empty_and_text_as_is()
        => Assert.Contains("a,,2024-01-02", CsvUtil.FromQueryResult(new QueryResult(["k"], [], ["min x", "max d"], [new QueryResultRow(["a"], [null, "2024-01-02"])])));
    [Theory] [InlineData("Date", true)] [InlineData("Date32", true)] [InlineData("Nullable(Date)", true)] [InlineData("LowCardinality(Nullable(Date32))", true)]
    [InlineData("DateTime", false)] [InlineData("DateTime64(3)", false)] [InlineData(null, false)]
    public void IsDateOnly_matches_date_columns_only(string? type, bool expected) => Assert.Equal(expected, ClickHouseType.IsDateOnly(type));
    [Fact] public void Date_only_columns_reject_a_time_part()
        => Assert.Contains("dates only", Assert.Throws<RequestValidationException>(() => FilterValues.Coerce(ClickHouseType.Temporal, "d", "2024-01-31 10:20", "f", dateOnly: true)).Message);
    [Fact] public void Date_only_columns_accept_a_plain_date()
        => Assert.Equal(("String", (object)"2024-01-31"), FilterValues.Coerce(ClickHouseType.Temporal, "d", "2024-01-31", "f", dateOnly: true));
    [Fact] public void BuildCondition_threads_dateOnly()
        => Assert.Throws<RequestValidationException>(() => ClickHouseGateway.BuildCondition("=", "p0", "c", ClickHouseType.Temporal, "c", "f", "2024-01-31T10:20", null, [], dateOnly: true));
    [Fact] public void Date_keys_format_as_iso_and_other_values_are_unchanged()
    {
        Assert.Equal("2024-01-31", ClickHouseGateway.FormatKey(new DateTime(2024, 1, 31)));
        Assert.Equal("2024-01-31 10:20:30", ClickHouseGateway.FormatKey(new DateTime(2024, 1, 31, 10, 20, 30)));
        Assert.Equal("abc", ClickHouseGateway.FormatKey("abc"));
        Assert.Equal("true", ClickHouseGateway.FormatKey(true));
        Assert.Equal("false", ClickHouseGateway.FormatKey(false));
        Assert.Equal("42", ClickHouseGateway.FormatKey(42L));
        Assert.Equal("1.5", ClickHouseGateway.FormatKey(1.5));
        Assert.Null(ClickHouseGateway.FormatKey(null));
    }
    [Fact] public void Histogram_sql_excludes_nulls_without_filters()
    {
        var sql = ClickHouseGateway.BuildHistogramSql("`x`", "`d`.`t`", "", 10);
        Assert.Equal(3, System.Text.RegularExpressions.Regex.Matches(sql, @"FROM `d`\.`t` WHERE `x` IS NOT NULL").Count);
    }
    [Fact] public void Histogram_sql_combines_the_null_guard_with_filters()
    {
        var sql = ClickHouseGateway.BuildHistogramSql("`x`", "`d`.`t`", " WHERE `y` = {p0:String}", 10);
        Assert.Equal(3, System.Text.RegularExpressions.Regex.Matches(sql, @"WHERE `y` = \{p0:String\} AND `x` IS NOT NULL").Count);
    }
}
