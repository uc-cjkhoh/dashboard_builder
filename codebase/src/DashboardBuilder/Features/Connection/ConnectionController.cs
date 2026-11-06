using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc;

namespace DashboardBuilder.Features.Connection;

/// <summary>
/// The session connection endpoints. All read-only against ClickHouse: connecting only
/// validates with <c>SELECT 1</c>. The password is accepted in the request body, stored in the
/// session, and never echoed back (CLAUDE.md golden rule 4).
/// </summary>
public sealed class ConnectionController : ApiControllerBase
{
    public ConnectionController(ConnectionRegistry registry, ClickHouseGateway gateway, ILoggerFactory loggers)
        : base(registry, gateway, loggers) { }

    /// <summary>Connection request from the sidebar form. Port is required; Secure defaults to true.</summary>
    public sealed record ConnectRequest(
        string? Host, int? Port, string? User, string? Password, bool? Secure, bool? AllowInvalidCert);

    [HttpGet("connection")]
    public IResult GetStatus()
        => Results.Ok(Registry.Current?.ToClientView() ?? ConnectionView.Disconnected);

    /// <summary>
    /// Liveness probe for the sidebar's status dot. <c>connected:false</c> = the session no longer holds a connection
    /// (idle timeout, restart); <c>reachable</c> says whether <c>SELECT 1</c> still succeeds. Read-only, credential-free.
    /// </summary>
    [HttpGet("connection/ping")]
    public async Task<IResult> Ping(CancellationToken ct)
    {
        var info = Registry.Current;
        if (info is null) return Results.Ok(ConnectionView.Disconnected);
        var (error, _) = await Gateway.ValidateAsync(info, ct);
        return Results.Ok(new { connected = true, reachable = error is null });
    }

    [HttpPost("connection")]
    public async Task<IResult> Connect([FromBody] ConnectRequest req, CancellationToken ct)
    {
        try { RequestRules.ValidateConnect(req.Host, req.Port, req.User, req.Password); }
        catch (RequestValidationException ex) { return Invalid(ex); }

        var secure = req.Secure ?? true;
        var port = req.Port!.Value;

        var info = new ClickHouseConnectionInfo(
            Host: req.Host!.Trim(),
            Port: port,
            User: req.User!.Trim(),
            Password: req.Password ?? string.Empty,
            Secure: secure,
            // Safe by default (decision D11): a TLS connection validates the
            // server certificate against the host's trust store. Internal ClickHouse servers
            // often present a self-signed cert; the user can opt in per-connection with
            // allowInvalidCert:true — an explicit, informed choice, never the silent default.
            AllowInvalidCertificate: (req.AllowInvalidCert ?? false) && secure);

        // Validation may step the guard settings down (the server refused one), so store what it
        // returns.
        var (error, validated) = await Gateway.ValidateAsync(info, ct);
        if (error is not null)
            return Results.Json(new ApiError(error), statusCode: StatusCodes.Status502BadGateway);

        Registry.Save(validated);
        return Results.Ok(validated.ToClientView()); // password-free view
    }

    // The reverse proxy (Apache) forbids the DELETE method (403 before it reaches the app), so the
    // sidebar's Disconnect button calls the POST alias instead. Same handler, proxy-safe method.
    [HttpDelete("connection")]
    [HttpPost("connection/disconnect")]
    public IResult Disconnect()
    {
        Registry.Clear();
        return Results.Ok(ConnectionView.Disconnected);
    }
}
