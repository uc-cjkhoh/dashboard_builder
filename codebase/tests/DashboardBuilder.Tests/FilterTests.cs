using System.Net;
using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>
/// P14 dashboard filters. The filter-condition builder (scalar ops + <c>in</c> + <c>between</c>) and
/// the distinct-values clamp are unit tested here; the distinct endpoint's without-connection 409
/// confirms the gate (the happy path runs live).
/// </summary>
public class FilterTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public FilterTests(WebApplicationFactory<Program> factory) => _factory = factory;

    private static List<(string Name, string Type, object Value)> Bag() => new();

    // --- ClampDistinct -------------------------------------------------------
    [Theory]
    [InlineData(null, 200)]
    [InlineData(0, 1)]
    [InlineData(50, 50)]
    [InlineData(9999, 1000)]
    public void ClampDistinct_bounds_the_list(int? input, int expected)
        => Assert.Equal(expected, ClickHouseGateway.ClampDistinct(input));

    // --- scalar ops ----------------------------------------------------------
    [Fact]
    public void Scalar_numeric_binds_float64()
    {
        var p = Bag();
        var sql = ClickHouseGateway.BuildCondition(">=", "p0", "`age`", ClickHouseType.Numeric, "age", "filters[0]", "18", null, p);
        Assert.Equal("`age` >= {p0:Float64}", sql);
        Assert.Equal("Float64", p[0].Type);
        Assert.Equal(18d, p[0].Value);
    }

    [Fact]
    public void Scalar_text_binds_string()
    {
        var p = Bag();
        var sql = ClickHouseGateway.BuildCondition("=", "p0", "`name`", ClickHouseType.Text, "name", "filters[0]", "amy", null, p);
        Assert.Equal("`name` = {p0:String}", sql);
        Assert.Equal("String", p[0].Type);
    }

    [Fact]
    public void Unknown_operator_throws()
    {
        var p = Bag();
        Assert.Throws<UnknownIdentifierException>(() =>
            ClickHouseGateway.BuildCondition("DROP", "p0", "`x`", ClickHouseType.Text, "x", "filters[0]", "1", null, p));
    }

    // --- in ------------------------------------------------------------------
    [Fact]
    public void In_binds_a_string_array()
    {
        var p = Bag();
        var sql = ClickHouseGateway.BuildCondition("in", "p0", "`city`", ClickHouseType.Text, "city", "filters[0]", null, ["NY", "LA"], p);
        Assert.Equal("`city` IN {p0:Array(String)}", sql);
        Assert.Equal("Array(String)", p[0].Type);
        Assert.Equal(new[] { "NY", "LA" }, (string[])p[0].Value);
    }

    [Fact]
    public void In_with_all_numeric_values_binds_a_float_array()
    {
        var p = Bag();
        var sql = ClickHouseGateway.BuildCondition("in", "p0", "`age`", ClickHouseType.Numeric, "age", "filters[0]", null, ["18", "21"], p);
        Assert.Equal("`age` IN {p0:Array(Float64)}", sql);
        Assert.Equal(new[] { 18d, 21d }, (double[])p[0].Value);
    }

    [Fact]
    public void Empty_in_is_rejected()
    {
        var p = Bag();
        Assert.Throws<RequestValidationException>(() =>
            ClickHouseGateway.BuildCondition("in", "p0", "`city`", ClickHouseType.Text, "city", "filters[0]", null, [], p));
        Assert.Empty(p);
    }

    // --- notin (Exclude): NULL rows are kept, not dropped by three-valued logic ---
    [Fact]
    public void Notin_binds_a_string_array_and_keeps_null_rows()
    {
        var p = Bag();
        var sql = ClickHouseGateway.BuildCondition("notin", "p0", "`city`", ClickHouseType.Text, "city", "filters[0]", null, ["NY", "LA"], p);
        Assert.Equal("(`city` NOT IN {p0:Array(String)} OR isNull(`city`))", sql);
        Assert.Equal("Array(String)", p[0].Type);
        Assert.Equal(new[] { "NY", "LA" }, (string[])p[0].Value);
    }

    [Fact]
    public void Notin_with_numeric_values_binds_a_float_array()
    {
        var p = Bag();
        var sql = ClickHouseGateway.BuildCondition("NotIn", "p0", "`age`", ClickHouseType.Numeric, "age", "filters[0]", null, ["18", "21"], p);
        Assert.Equal("(`age` NOT IN {p0:Array(Float64)} OR isNull(`age`))", sql);
        Assert.Equal(new[] { 18d, 21d }, (double[])p[0].Value);
    }

    [Fact]
    public void Notin_rejects_empty_and_a_value_that_does_not_fit_the_column()
    {
        var p = Bag();
        Assert.Throws<RequestValidationException>(() =>
            ClickHouseGateway.BuildCondition("notin", "p0", "`city`", ClickHouseType.Text, "city", "filters[0]", null, [], p));
        Assert.Throws<RequestValidationException>(() =>
            ClickHouseGateway.BuildCondition("notin", "p0", "`age`", ClickHouseType.Numeric, "age", "filters[0]", null, ["x"], p));
    }

    // --- between -------------------------------------------------------------
    [Fact]
    public void Between_numeric_binds_two_bounds()
    {
        var p = Bag();
        var sql = ClickHouseGateway.BuildCondition("between", "p0", "`age`", ClickHouseType.Numeric, "age", "filters[0]", null, ["18", "65"], p);
        Assert.Equal("`age` >= {p0a:Float64} AND `age` <= {p0b:Float64}", sql);
        Assert.Equal(2, p.Count);
        Assert.Equal(18d, p[0].Value);
        Assert.Equal(65d, p[1].Value);
    }

    [Fact]
    public void Between_missing_bound_is_rejected()
    {
        var p = Bag();
        Assert.Throws<RequestValidationException>(() =>
            ClickHouseGateway.BuildCondition("between", "p0", "`age`", ClickHouseType.Numeric, "age", "filters[0]", null, ["18"], p));
        Assert.Empty(p);
    }

    // --- endpoint gate -------------------------------------------------------
    [Fact]
    public async Task Distinct_without_a_connection_returns_409()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetAsync("/api/databases/default/tables/t/columns/city/distinct?limit=50");
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }
}
