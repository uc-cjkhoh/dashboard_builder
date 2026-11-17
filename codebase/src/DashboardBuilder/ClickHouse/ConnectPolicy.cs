using System.Net;
using System.Net.Sockets;

namespace DashboardBuilder.ClickHouse;

/// <summary>
/// Which hosts the connect form may reach (D135). The app has no login, so whoever can open the page can make the server
/// open a connection to the host and port they type, and the connect messages say which ones answer. An operator closes
/// that with <c>ClickHouse:AllowedHosts</c> (host names or IP addresses, as typed in the form, case-insensitive): any
/// other host is refused before a byte is sent. Unset or empty = any host (local development). Either way a link-local
/// or unspecified address (169.254.x.x, fe80::/10, 0.0.0.0, ::) is refused: no ClickHouse lives there, cloud metadata does.
/// Attempts are also rate-limited per client address (<see cref="RateLimitPolicy"/>, <c>ClickHouse:ConnectPerMinute</c>).
/// </summary>
public sealed class ConnectPolicy
{
    /// <summary>The rate limiter policy on <c>POST /api/connection</c>.</summary>
    public const string RateLimitPolicy = "connect";
    /// <summary>Connect attempts allowed per client address per minute when <c>ClickHouse:ConnectPerMinute</c> is unset.</summary>
    public const int DefaultPerMinute = 20;

    public const string NotAllowedMessage = "This server can't connect to that host. Ask the administrator to add it to the allowed ClickHouse hosts.";
    public const string LinkLocalMessage = "That address can't be a ClickHouse server. Enter the server's host name or IP address.";
    public const string TooManyMessage = "Too many connection attempts. Wait a minute, then try again.";

    private readonly HashSet<string> _allowed;

    public ConnectPolicy(IEnumerable<string>? allowedHosts)
        => _allowed = new HashSet<string>((allowedHosts ?? []).Select(Normalize).Where(h => h.Length > 0), StringComparer.OrdinalIgnoreCase);

    /// <summary>Whether an allowlist is configured (false = any host may be tried).</summary>
    public bool Restricted => _allowed.Count > 0;

    /// <summary>Null when <paramref name="host"/> (already shape-checked by <c>RequestRules.HostError</c>) may be tried, else the reason.</summary>
    public string? HostError(string host)
    {
        var h = Normalize(host);
        if (IPAddress.TryParse(h, out var ip) && Unusable(ip)) return LinkLocalMessage;
        if (Restricted && !_allowed.Contains(h)) return NotAllowedMessage;
        return null;
    }

    private static bool Unusable(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (ip.Equals(IPAddress.Any) || ip.Equals(IPAddress.IPv6Any)) return true;
        if (ip.AddressFamily == AddressFamily.InterNetworkV6) return ip.IsIPv6LinkLocal;
        var b = ip.GetAddressBytes();
        return b[0] == 169 && b[1] == 254;
    }

    // "[::1]" → "::1", "Db.Example.com." → "db.example.com".
    private static string Normalize(string? host)
    {
        var h = (host ?? "").Trim();
        if (h.StartsWith('[') && h.EndsWith(']')) h = h[1..^1];
        return h.TrimEnd('.').ToLowerInvariant();
    }
}
