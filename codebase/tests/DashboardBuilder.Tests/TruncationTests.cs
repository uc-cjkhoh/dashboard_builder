using System.Text.Json;
using DashboardBuilder.ClickHouse;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>
/// Truncation notice (roadmap item 3): a bounded query fetches one probe row past its limit, so the
/// server can tell the client "there is more" instead of silently cutting the result off.
/// </summary>
public class TruncationTests
{
    [Theory]
    [InlineData(null, 51)]   // default limit 50 + probe row
    [InlineData(10, 11)]
    [InlineData(0, 2)]       // clamped up to 1
    [InlineData(100000, 501)] // clamped down to 500
    public void The_sql_limit_is_the_clamped_limit_plus_one_probe_row(int? requested, int expected)
        => Assert.Equal(expected, ClickHouseGateway.ProbeLimit(requested));

    [Fact]
    public void A_result_that_filled_the_probe_row_is_trimmed_and_flagged()
    {
        var rows = Enumerable.Range(0, 51).ToList();
        Assert.True(ClickHouseGateway.TrimProbeRow(rows, probeLimit: 51));
        Assert.Equal(50, rows.Count);
    }

    [Fact]
    public void A_result_within_the_limit_is_left_alone()
    {
        var rows = Enumerable.Range(0, 50).ToList();
        Assert.False(ClickHouseGateway.TrimProbeRow(rows, probeLimit: 51));
        Assert.Equal(50, rows.Count);
    }

    [Fact]
    public void The_query_result_tells_the_client_it_was_truncated()
    {
        var result = new QueryResult([], [], ["count"], [], Truncated: true);
        var json = JsonSerializer.Serialize(result, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Contains("\"truncated\":true", json);
    }

    [Fact]
    public void The_box_plot_result_tells_the_client_it_was_truncated()
    {
        var json = JsonSerializer.Serialize(new BoxPlotResult([], Truncated: true),
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Contains("\"truncated\":true", json);
    }
}
