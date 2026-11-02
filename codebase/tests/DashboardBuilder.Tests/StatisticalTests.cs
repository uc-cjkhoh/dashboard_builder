using System.Net;
using System.Net.Http.Json;
using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>
/// Statistical charts. The pure helpers (bucket clamp, single-table filter builder) are unit
/// tested here — the safety-critical bits that don't need a live server; the histogram/box-plot
/// endpoints are exercised for their without-connection 409 (the happy path runs live).
/// </summary>
public class StatisticalTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public StatisticalTests(WebApplicationFactory<Program> factory) => _factory = factory;

    // --- ClampBuckets --------------------------------------------------------
    [Theory]
    [InlineData(null, 20)]   // default
    [InlineData(0, 1)]       // floor
    [InlineData(-5, 1)]
    [InlineData(7, 7)]
    [InlineData(100, 100)]
    [InlineData(1000, 100)]  // ceiling — a bucketing query can't explode
    public void ClampBuckets_bounds_the_bin_count(int? input, int expected)
        => Assert.Equal(expected, ClickHouseGateway.ClampBuckets(input));

    // --- BuildSingleTableFilters --------------------------------------------
    private static IReadOnlyDictionary<string, ColumnInfo> Cols() => new Dictionary<string, ColumnInfo>
    {
        ["age"] = new ColumnInfo("age", "UInt32", ClickHouseType.Numeric),
        ["name"] = new ColumnInfo("name", "String", ClickHouseType.Text),
    };

    [Fact]
    public void No_filters_yields_no_clause()
    {
        var p = new List<(string, string, object)>();
        Assert.Equal(string.Empty, ClickHouseGateway.BuildSingleTableFilters([], Cols(), p));
        Assert.Empty(p);
    }

    [Fact]
    public void Numeric_column_binds_float64_and_quotes_identifier()
    {
        var p = new List<(string Name, string Type, object Value)>();
        var sql = ClickHouseGateway.BuildSingleTableFilters(
            [new StatFilter("age", ">=", "18")], Cols(), p);
        Assert.Equal(" WHERE `age` >= {p0:Float64}", sql);
        Assert.Single(p);
        Assert.Equal("Float64", p[0].Type);
        Assert.Equal(18d, p[0].Value);
    }

    [Fact]
    public void Text_column_binds_string()
    {
        var p = new List<(string Name, string Type, object Value)>();
        var sql = ClickHouseGateway.BuildSingleTableFilters(
            [new StatFilter("name", "=", "amy")], Cols(), p);
        Assert.Equal(" WHERE `name` = {p0:String}", sql);
        Assert.Equal("String", p[0].Type);
        Assert.Equal("amy", p[0].Value);
    }

    [Fact]
    public void Unknown_column_is_rejected()
    {
        var p = new List<(string, string, object)>();
        Assert.Throws<UnknownIdentifierException>(() =>
            ClickHouseGateway.BuildSingleTableFilters([new StatFilter("nope", "=", "x")], Cols(), p));
    }

    [Fact]
    public void Injection_in_column_name_is_rejected_not_interpolated()
    {
        var p = new List<(string, string, object)>();
        // A hostile column name is not in the live catalog → rejected before it can reach SQL.
        Assert.Throws<UnknownIdentifierException>(() =>
            ClickHouseGateway.BuildSingleTableFilters(
                [new StatFilter("age`) OR 1=1 --", "=", "x")], Cols(), p));
    }

    [Fact]
    public void Unknown_operator_is_rejected()
    {
        var p = new List<(string, string, object)>();
        Assert.Throws<UnknownIdentifierException>(() =>
            ClickHouseGateway.BuildSingleTableFilters([new StatFilter("age", "LIKE", "x")], Cols(), p));
    }

    // --- endpoints without a connection → 409 -------------------------------
    [Fact]
    public async Task Histogram_without_a_connection_returns_409()
    {
        var client = _factory.CreateClient();
        var resp = await client.PostAsJsonAsync("/api/databases/default/tables/t/histogram",
            new { column = "x", buckets = 10, filters = Array.Empty<object>() });
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }

    [Fact]
    public async Task Boxplot_without_a_connection_returns_409()
    {
        var client = _factory.CreateClient();
        var resp = await client.PostAsJsonAsync("/api/databases/default/tables/t/boxplot",
            new { dimension = (string?)null, measure = "x", filters = Array.Empty<object>() });
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }
}
