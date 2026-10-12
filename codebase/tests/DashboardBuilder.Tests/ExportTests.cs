using System.Net;
using System.Net.Http.Json;
using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>
/// P13 export. The CSV serialiser is unit tested (RFC-4180 quoting + formula-injection guard); the
/// export endpoint's without-connection 409 confirms the gate (the happy path runs live).
/// </summary>
public class ExportTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public ExportTests(WebApplicationFactory<Program> factory) => _factory = factory;

    [Fact]
    public void Plain_value_is_unquoted() => Assert.Equal("amy", CsvUtil.Escape("amy"));

    [Fact]
    public void Comma_and_quote_are_rfc4180_quoted()
    {
        Assert.Equal("\"a,b\"", CsvUtil.Escape("a,b"));
        Assert.Equal("\"she said \"\"hi\"\"\"", CsvUtil.Escape("she said \"hi\""));
    }

    [Fact]
    public void Newline_forces_quoting()
        => Assert.Equal("\"line1\nline2\"", CsvUtil.Escape("line1\nline2"));

    [Theory]
    [InlineData("=1+1")]
    [InlineData("+ping")]
    [InlineData("-2")]
    [InlineData("@cmd")]
    public void Formula_leading_char_is_neutralised(string dangerous)
    {
        var escaped = CsvUtil.Escape(dangerous);
        // Prefixed with a single quote so a spreadsheet treats it as text, not a formula.
        Assert.StartsWith("'", escaped.TrimStart('"'));
    }

    [Fact]
    public void Null_becomes_empty()
        => Assert.Equal(string.Empty, CsvUtil.Escape(null));

    [Fact]
    public void FromQueryResult_writes_header_and_rows()
    {
        var result = new QueryResult(
            RowDimensions: ["t.country"],
            ColumnDimensions: [],
            Measures: ["sum amt"],
            Rows: [
                new QueryResultRow(["US"], [10d]),
                new QueryResultRow([null], [5d]),
            ]);
        var csv = CsvUtil.FromQueryResult(result);
        var lines = csv.Replace("\r\n", "\n").TrimEnd('\n').Split('\n');
        Assert.Equal("t.country,sum amt", lines[0]);
        Assert.Equal("US,10", lines[1]);
        Assert.Equal(",5", lines[2]); // null key → empty cell
    }

    [Fact]
    public async Task Export_without_a_connection_returns_409()
    {
        var client = _factory.CreateClient();
        var resp = await client.PostAsJsonAsync("/api/query/export.csv",
            new { from = new { db = "default", table = "t" } });
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }
}
