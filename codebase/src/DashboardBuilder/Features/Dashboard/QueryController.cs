using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc;

namespace DashboardBuilder.Features.Dashboard;

/// <summary>
/// The worksheet query endpoints that back the Dashboard feature: single-table aggregate/histogram/
/// box-plot chart data, the cross-table joined <c>/api/query</c>, and its CSV export. All bounded and
/// identifier-safe (validated + backtick-quoted in <see cref="ClickHouseGateway"/>); read-only —
/// there is no DDL/DML endpoint (CLAUDE.md golden rule 1).
/// </summary>
public sealed class QueryController : ApiControllerBase
{
    private const string LogCategory = "DashboardBuilder.Features.Query";

    public QueryController(ConnectionRegistry registry, ClickHouseGateway gateway, ILoggerFactory loggers)
        : base(registry, gateway, loggers) { }

    [HttpPost("databases/{db}/tables/{table}/aggregate")]
    public async Task<IResult> Aggregate(string db, string table, [FromBody] AggregateRequest request, CancellationToken ct)
    {
        var info = Registry.Current;
        if (info is null) return NotConnected();
        try
        {
            return Results.Ok(await Gateway.AggregateAsync(info, db, table, request, ct));
        }
        catch (UnknownIdentifierException ex)
        {
            return Results.BadRequest(new { error = ex.Message });
        }
        catch (Exception ex) when (!IsClientAbort(ex))
        {
            return SafeError(ex, LogCategory);
        }
    }

    [HttpPost("databases/{db}/tables/{table}/histogram")]
    public async Task<IResult> Histogram(string db, string table, [FromBody] HistogramRequest request, CancellationToken ct)
    {
        var info = Registry.Current;
        if (info is null) return NotConnected();
        try
        {
            return Results.Ok(await Gateway.HistogramAsync(info, db, table, request, ct));
        }
        catch (UnknownIdentifierException ex)
        {
            return Results.BadRequest(new { error = ex.Message });
        }
        catch (Exception ex) when (!IsClientAbort(ex))
        {
            return SafeError(ex, LogCategory);
        }
    }

    [HttpPost("databases/{db}/tables/{table}/boxplot")]
    public async Task<IResult> BoxPlot(string db, string table, [FromBody] BoxPlotRequest request, CancellationToken ct)
    {
        var info = Registry.Current;
        if (info is null) return NotConnected();
        try
        {
            return Results.Ok(await Gateway.BoxPlotAsync(info, db, table, request, ct));
        }
        catch (UnknownIdentifierException ex)
        {
            return Results.BadRequest(new { error = ex.Message });
        }
        catch (Exception ex) when (!IsClientAbort(ex))
        {
            return SafeError(ex, LogCategory);
        }
    }

    [HttpPost("query")]
    public async Task<IResult> Query([FromBody] QueryRequest request, CancellationToken ct)
    {
        var info = Registry.Current;
        if (info is null) return NotConnected();
        try
        {
            return Results.Ok(await Gateway.QueryAsync(info, request, ct));
        }
        catch (UnknownIdentifierException ex)
        {
            return Results.BadRequest(new { error = ex.Message });
        }
        catch (Exception ex) when (!IsClientAbort(ex))
        {
            return SafeError(ex, LogCategory);
        }
    }

    [HttpPost("query/export.csv")]
    public async Task<IResult> ExportCsv([FromBody] QueryRequest request, CancellationToken ct)
    {
        var info = Registry.Current;
        if (info is null) return NotConnected();
        try
        {
            // Same bounded, identifier-safe worksheet query as /api/query — just serialised to CSV.
            var result = await Gateway.QueryAsync(info, request, ct);
            var csv = CsvUtil.FromQueryResult(result);
            return Results.Text(csv, "text/csv", System.Text.Encoding.UTF8);
        }
        catch (UnknownIdentifierException ex)
        {
            return Results.BadRequest(new { error = ex.Message });
        }
        catch (Exception ex) when (!IsClientAbort(ex))
        {
            return SafeError(ex, LogCategory);
        }
    }
}
