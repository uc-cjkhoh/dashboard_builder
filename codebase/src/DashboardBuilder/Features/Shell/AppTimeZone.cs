namespace DashboardBuilder.Features.Shell;

/// <summary>
/// The time zone the UI shows clock times in and takes "today" from (Updated hh:mm:ss, performance timings, the
/// date range presets, print headers). It is the configured <c>Display:TimeZone</c> when valid, else the zone of the
/// machine hosting the app, else Malaysia time (<see cref="Fallback"/>, UTC+8). A host that reports plain UTC is
/// treated as "unset" (a container default, not a choice), so the fallback applies; set <c>Display:TimeZone</c> to
/// <c>UTC</c> to really show UTC. The page carries the id in <c>&lt;meta name="app-timezone"&gt;</c>.
/// </summary>
public static class AppTimeZone
{
    public const string Fallback = "Asia/Kuala_Lumpur";

    private static readonly HashSet<string> UtcIds = new(StringComparer.OrdinalIgnoreCase)
        { "UTC", "Etc/UTC", "Etc/UCT", "UCT", "Universal", "Etc/Universal", "Zulu", "Etc/Zulu", "GMT", "Etc/GMT", "Greenwich", "Etc/Greenwich" };

    public static string Resolve(string? configured, string? hostId)
    {
        if (IsValid(configured)) return configured!.Trim();
        if (IsValid(hostId) && !UtcIds.Contains(hostId!.Trim())) return hostId!.Trim();
        return Fallback;
    }

    private static bool IsValid(string? id)
        => !string.IsNullOrWhiteSpace(id) && TimeZoneInfo.TryFindSystemTimeZoneById(id.Trim(), out _);
}
