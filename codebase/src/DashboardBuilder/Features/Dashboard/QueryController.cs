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
    public QueryController(ConnectionRegistry registry, ClickHouseGateway gateway, ILoggerFactory loggers)
        : base(registry, gateway, loggers) { }

    [HttpPost("databases/{db}/tables/{table}/aggregate")]
    public Task<IResult> Aggregate(string db, string table, [FromBody] AggregateRequest request, CancellationToken ct)
        => RunAsync(async info => Results.Ok(await Gateway.AggregateAsync(info, db, table, request, ct)));

    [HttpPost("databases/{db}/tables/{table}/histogram")]
    public Task<IResult> Histogram(string db, string table, [FromBody] HistogramRequest request, CancellationToken ct)
        => RunAsync(async info => Results.Ok(await Gateway.HistogramAsync(info, db, table, request, ct)));

    [HttpPost("databases/{db}/tables/{table}/boxplot")]
    public Task<IResult> BoxPlot(string db, string table, [FromBody] BoxPlotRequest request, CancellationToken ct)
        => RunAsync(async info => Results.Ok(await Gateway.BoxPlotAsync(info, db, table, request, ct)));

    [HttpPost("query")]
    public Task<IResult> Query([FromBody] QueryRequest request, CancellationToken ct)
        => RunAsync(async info => Results.Ok(await Gateway.QueryAsync(info, request, ct)));

    [HttpPost("query/export.csv")]
    public Task<IResult> ExportCsv([FromBody] QueryRequest request, CancellationToken ct)
        => RunAsync(async info =>
        {
            // Same bounded, identifier-safe worksheet query as /api/query — just serialised to CSV.
            var result = await Gateway.QueryAsync(info, request, ct);
            var csv = CsvUtil.FromQueryResult(result);
            return Results.Text(csv, "text/csv", System.Text.Encoding.UTF8);
        });
}
