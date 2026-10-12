using ClickHouse.Client;
using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc;

namespace DashboardBuilder.Features;

/// <summary>
/// Shared base for the read-only ClickHouse API controllers. Holds the session-scoped connection
/// store and the gateway, plus the two standard failure results. All endpoints are read-only
/// against ClickHouse (CLAUDE.md golden rule 1); the password lives only in the session and is
/// never echoed back (golden rule 3).
/// </summary>
[ApiController]
[Route("api")]
public abstract class ApiControllerBase : ControllerBase
{
    protected readonly ConnectionRegistry Registry;
    protected readonly ClickHouseGateway Gateway;
    private readonly ILoggerFactory _loggers;

    protected ApiControllerBase(ConnectionRegistry registry, ClickHouseGateway gateway, ILoggerFactory loggers)
    {
        Registry = registry;
        Gateway = gateway;
        _loggers = loggers;
    }

    /// <summary>409 when there is no session connection to run a query against.</summary>
    protected static IResult NotConnected()
        => Results.Json(new { error = "Not connected to a ClickHouse server." },
                        statusCode: StatusCodes.Status409Conflict);

    /// <summary>
    /// A credential-safe 502: logs the exception <em>type</em> only — messages/URIs can carry host or
    /// credential material — and returns a generic body.
    /// </summary>
    protected IResult SafeError(Exception ex, string category)
    {
        _loggers.CreateLogger(category).LogWarning("Query failed: {ErrorType}", ex.GetType().Name);
        var (status, message) = DescribeFailure(ex);
        return Results.Json(new { error = message }, statusCode: status);
    }

    /// <summary>
    /// The status + client message for a failed query. Never echoes the exception message (it can
    /// carry host or credential material): a timeout — server-side (ClickHouse code 159, from the
    /// gateway's <c>max_execution_time</c>) or, on a connection without that limit, the HTTP
    /// timeout — gets an actionable 504; everything else a generic 502.
    /// </summary>
    internal static (int Status, string Message) DescribeFailure(Exception ex) => ex switch
    {
        ClickHouseServerException { ErrorCode: 159 } => TimedOut(ClickHouseGateway.MaxExecutionSeconds),
        _ when ClickHouseGateway.IsHttpTimeout(ex) => TimedOut(ClickHouseGateway.HttpTimeoutSeconds),
        _ => (StatusCodes.Status502BadGateway, "Query failed against ClickHouse."),
    };

    private static (int Status, string Message) TimedOut(int seconds) => (StatusCodes.Status504GatewayTimeout,
        $"The query ran longer than {seconds} seconds and was stopped. " +
        "Add a filter, lower Top-N, or use fewer fields.");

    /// <summary>
    /// True when the request was cancelled because the client went away (aborted fetch, closed tab) —
    /// left to the framework, nothing to report. An HTTP timeout to ClickHouse is also an
    /// <see cref="OperationCanceledException"/> but is a failure the user must see.
    /// </summary>
    internal static bool IsClientAbort(Exception ex)
        => ex is OperationCanceledException && !ClickHouseGateway.IsHttpTimeout(ex);
}
