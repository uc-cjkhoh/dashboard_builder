using System.Text.Json;

namespace DashboardBuilder.ClickHouse;

/// <summary>
/// Session-scoped store for the active ClickHouse connection. Backed by <see cref="ISession"/>,
/// so the data lives server-side in the session cache; the browser only ever holds the
/// session-id cookie. A fresh session starts with no connection (CLAUDE.md golden rule 3).
/// <para>
/// We persist the <see cref="ClickHouseConnectionInfo"/> (including the password) rather than a
/// live <c>DbConnection</c>: the server is a stateless-per-request proxy, so each ClickHouse
/// operation opens a short-lived connection from this info (ARCHITECTURE.md).
/// </para>
/// </summary>
public sealed class ConnectionRegistry
{
    private const string SessionKey = "clickhouse.connection";

    private readonly IHttpContextAccessor _http;

    public ConnectionRegistry(IHttpContextAccessor http) => _http = http;

    private ISession Session =>
        _http.HttpContext?.Session
        ?? throw new InvalidOperationException("No active session; UseSession must run first.");

    /// <summary>The current connection for this session, or <c>null</c> if not connected.</summary>
    public ClickHouseConnectionInfo? Current =>
        Session.TryGetValue(SessionKey, out var bytes) && bytes is { Length: > 0 }
            ? JsonSerializer.Deserialize<ClickHouseConnectionInfo>(bytes)
            : null;

    /// <summary>Store (or replace) the session's connection.</summary>
    public void Save(ClickHouseConnectionInfo info) =>
        Session.Set(SessionKey, JsonSerializer.SerializeToUtf8Bytes(info));

    /// <summary>Drop the session's connection.</summary>
    public void Clear() => Session.Remove(SessionKey);
}
