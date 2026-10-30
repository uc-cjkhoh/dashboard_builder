using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc;

namespace DashboardBuilder.Features.Rows;

/// <summary>
/// <c>POST /api/unpivot</c>: the first rows of one table with 2..50 same-kind wide columns turned into (Field, Value) rows,
/// beside up to 5 kept columns. Bounded (limit ≤ 1000), identifier-safe, values bound, read-only (golden rules 1-3).
/// </summary>
public sealed class UnpivotController : ApiControllerBase
{
    public UnpivotController(ConnectionRegistry registry, ClickHouseGateway gateway, ILoggerFactory loggers)
        : base(registry, gateway, loggers) { }

    [HttpPost("unpivot")]
    public Task<IResult> Unpivot([FromBody] UnpivotRequest request, CancellationToken ct)
        => RunAsync(async info => { RequestRules.ValidateUnpivot(request); return Results.Ok(await Gateway.UnpivotAsync(info, request, ct)); });
}
