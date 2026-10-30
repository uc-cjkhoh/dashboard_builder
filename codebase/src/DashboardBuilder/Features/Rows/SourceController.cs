using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc;

namespace DashboardBuilder.Features.Rows;

/// <summary>
/// <c>POST /api/source/columns</c>: the columns a union / unpivot source exposes as worksheet fields (name, type, category — the
/// shape of the table columns endpoint), so the Data Source card and the field pane list them. Validates the definition and the
/// catalog; reads no rows. Read-only, identifier-safe (golden rules 1-3).
/// </summary>
public sealed class SourceController : ApiControllerBase
{
    public SourceController(ConnectionRegistry registry, ClickHouseGateway gateway, ILoggerFactory loggers)
        : base(registry, gateway, loggers) { }

    [HttpPost("source/columns")]
    public Task<IResult> Columns([FromBody] QuerySource source, CancellationToken ct)
        => RunAsync(async info =>
        {
            RequestRules.ValidateSource(source);
            var (columns, truncated, lossy) = await Gateway.SourceColumnsAsync(info, source, ct);
            return Results.Ok(new { columns, truncated, lossy });
        });
}
