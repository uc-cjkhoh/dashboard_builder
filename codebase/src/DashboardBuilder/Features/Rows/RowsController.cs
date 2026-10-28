using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc;

namespace DashboardBuilder.Features.Rows;

/// <summary>
/// The one row-level endpoint: <c>POST /api/rows</c> returns the first rows of a single table (names, types, a
/// bounded page of cells) for the schema browser's preview and the worksheet's "View data". Bounded (limit ≤ 1000),
/// identifier-safe (validated + quoted in <see cref="ClickHouseGateway"/>), values bound, read-only (golden rules 1-3).
/// </summary>
public sealed class RowsController : ApiControllerBase
{
    public RowsController(ConnectionRegistry registry, ClickHouseGateway gateway, ILoggerFactory loggers)
        : base(registry, gateway, loggers) { }

    [HttpPost("rows")]
    public Task<IResult> Rows([FromBody] RowsRequest request, CancellationToken ct)
        => RunAsync(async info => { RequestRules.ValidateRows(request); return Results.Ok(await Gateway.RowsAsync(info, request, ct)); });
}
