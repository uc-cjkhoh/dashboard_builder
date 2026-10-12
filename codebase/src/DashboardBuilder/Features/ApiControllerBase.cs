using ClickHouse.Client;
using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc;

namespace DashboardBuilder.Features;

/// <summary>
/// Shared base for the read-only ClickHouse API controllers. Holds the session-scoped connection
/// store and the gateway, plus the two standard failure results. All endpoints are read-only
/// against ClickHouse (CLAUDE.md golden rule 1); the password lives only in the session and is
/// never echoed back (golden rule 4).
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
        => Results.Json(new ApiError("Not connected to a ClickHouse server."), statusCode: StatusCodes.Status409Conflict);

    protected static IResult Invalid(RequestValidationException ex)
        => Results.Json(new ApiError(ex.Message, ex.Field), statusCode: StatusCodes.Status400BadRequest);

    /// <summary>The one action wrapper: 409 when not connected, 400 for rule breaks, <paramref name="unknownIdentifierStatus"/>
    /// for catalog misses, 502/504 for ClickHouse, 500 for our own bugs. Client aborts are left to the framework.</summary>
    protected async Task<IResult> RunAsync(Func<ClickHouseConnectionInfo, Task<IResult>> work, int unknownIdentifierStatus = StatusCodes.Status400BadRequest)
    {
        var info = Registry.Current;
        if (info is null) return NotConnected();
        try { return await work(info); }
        catch (RequestValidationException ex) { return Invalid(ex); }
        catch (UnknownIdentifierException ex) { return Results.Json(new ApiError(ex.Message), statusCode: unknownIdentifierStatus); }
        catch (Exception ex) when (!IsClientAbort(ex)) { return SafeError(ex); }
    }

    /// <summary>
    /// A credential-safe failure: logs the exception <em>type</em> only — messages/URIs can carry host or
    /// credential material — and returns a generic body.
    /// </summary>
    protected IResult SafeError(Exception ex)
    {
        var trace = HttpContext.TraceIdentifier;
        var (status, message) = DescribeFailure(ex, trace);
        var log = _loggers.CreateLogger(GetType().FullName!);
        if (status == 500) log.LogError("Unexpected {ErrorType} (ref {TraceId})", ex.GetType().Name, trace);
        else log.LogWarning("Query failed: {ErrorType}", ex.GetType().Name);
        return Results.Json(new ApiError(message), statusCode: status);
    }

    /// <summary>
    /// The status + client message for a failed action. Never echoes the exception message: a timeout
    /// (ClickHouse code 159, or the HTTP timeout) gets an actionable 504; upstream failures a generic
    /// 502; anything else is our bug — a 500 with a trace reference.
    /// </summary>
    internal static (int Status, string Message) DescribeFailure(Exception ex, string traceId) => ex switch
    {
        ClickHouseServerException { ErrorCode: 159 } => TimedOut(ClickHouseGateway.MaxExecutionSeconds),
        _ when ClickHouseGateway.IsHttpTimeout(ex) => TimedOut(ClickHouseGateway.HttpTimeoutSeconds),
        _ when IsUpstreamFailure(ex) => (StatusCodes.Status502BadGateway, "Query failed against ClickHouse."),
        _ => (StatusCodes.Status500InternalServerError, $"Unexpected error (ref {traceId})."),
    };

    internal static bool IsUpstreamFailure(Exception ex) => ex switch
    {
        ClickHouseServerException or HttpRequestException or IOException or System.Security.Authentication.AuthenticationException => true,
        _ => ex.InnerException is { } inner && IsUpstreamFailure(inner),
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
