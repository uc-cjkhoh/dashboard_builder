using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc;

namespace DashboardBuilder.Features.Relations;

/// <summary>
/// <c>POST /api/relationships/preview</c>: the relationship dialog's "Check this join" — bounded, read-only match and
/// duplicate counts for a key pair (see <see cref="ClickHouseGateway.JoinPreviewAsync"/>). A relationship stays a logical
/// declaration (golden rule 5); this only tells the user what the data looks like.
/// </summary>
public sealed class RelationsController : ApiControllerBase
{
    public RelationsController(ConnectionRegistry registry, ClickHouseGateway gateway, ILoggerFactory loggers)
        : base(registry, gateway, loggers) { }

    [HttpPost("relationships/preview")]
    public Task<IResult> Preview([FromBody] JoinPreviewRequest request, CancellationToken ct)
        => RunAsync(async info => { JoinPreviewRules.Validate(request); return Results.Ok(await Gateway.JoinPreviewAsync(info, request, ct)); });
}
