namespace DashboardBuilder.ClickHouse;

/// <summary>
/// A ClickHouse connection as the user declared it. Held server-side in the session only.
/// <para>
/// The <see cref="Password"/> is a secret: it is never serialized to the client, never
/// logged, and never placed in a URL or query string (CLAUDE.md golden rule 3). Use
/// <see cref="ToClientView"/> to produce the safe, password-free shape for API responses.
/// </para>
/// </summary>
public sealed record ClickHouseConnectionInfo(
    string Host,
    int Port,
    string User,
    string Password,
    bool Secure,
    bool AllowInvalidCertificate,
    // Which database-level guard settings this server accepts; settled once, at connect.
    QueryGuards Guards = QueryGuards.Full)
{
    /// <summary>Non-secret projection safe to return to the browser.</summary>
    public ConnectionView ToClientView() => new(true, Host, Port, User, Secure, AllowInvalidCertificate);
}

/// <summary>
/// The database-level guard settings sent with every query. A connection starts at
/// <see cref="Full"/> and steps down only when the server refuses a setting at connect time.
/// </summary>
public enum QueryGuards
{
    /// <summary><c>readonly=2</c>, the time limit, and cancel-on-disconnect.</summary>
    Full,
    /// <summary>A settings constraint refused the time limit (code 452): read-only and cancel-on-disconnect only.</summary>
    NoTimeLimit,
    /// <summary>A second settings constraint (code 452) refused more: <c>readonly=2</c> only. A refusal of that too fails the connect —
    /// an account that may write never runs without it.</summary>
    ReadOnly,
    /// <summary>The account is already read-only on the server (code 164): no settings — the server itself refuses writes.</summary>
    None,
}

/// <summary>Password-free connection status returned to the client. <see cref="AllowInvalidCertificate"/>
/// lets the UI show (and warn about) a connection whose TLS certificate validation was bypassed.</summary>
public sealed record ConnectionView(
    bool Connected,
    string? Host,
    int? Port,
    string? User,
    bool? Secure,
    bool? AllowInvalidCertificate = null)
{
    public static readonly ConnectionView Disconnected = new(false, null, null, null, null);
}

/// <summary>Why a connect failed: the HTTP status to answer with, a plain-words message (never the password), and the form field it belongs to.</summary>
public sealed record ConnectFailure(int Status, string Message, string? Field = null);
