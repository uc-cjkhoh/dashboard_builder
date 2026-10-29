using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc;

namespace DashboardBuilder.Features.Rows;

/// <summary>
/// <c>POST /api/union</c>: the first rows of 2..5 tables of one database stacked with UNION ALL over their shared
/// columns, the source table first. Bounded (limit ≤ 1000), identifier-safe, values bound, read-only (golden rules 1-3).
/// </summary>
public sealed class UnionController : ApiControllerBase
{
    public UnionController(ConnectionRegistry registry, ClickHouseGateway gateway, ILoggerFactory loggers)
        : base(registry, gateway, loggers) { }

    [HttpPost("union")]
    public Task<IResult> Union([FromBody] UnionRequest request, CancellationToken ct)
        => RunAsync(async info => { RequestRules.ValidateUnion(request); return Results.Ok(await Gateway.UnionAsync(info, request, ct)); });
}
