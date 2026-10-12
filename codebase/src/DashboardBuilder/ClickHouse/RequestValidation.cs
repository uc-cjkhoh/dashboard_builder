using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
namespace DashboardBuilder.ClickHouse;
/// <summary>Client input that breaks a rule. Always a 400 with this message and the offending field path.</summary>
public sealed class RequestValidationException(string message, string? field = null) : Exception(message)
{ public string? Field { get; } = field; }
/// <summary>Every input bound — mirrored in Features/Core/validate.js LIMITS. Reject beyond these, never clamp.</summary>
public static class ApiLimits
{
    public const int MaxBodyBytes = 256 * 1024;
    public const int MaxHostLength = 253, MaxUserLength = 64, MaxPasswordLength = 256;
    public const int MaxDimensions = 12, MaxMeasures = 10, MaxJoins = 10, MaxFilters = 16; // user filters (client cap 8) + drill path + page + selection
    public const int MaxInValues = 500, MaxFilterValueLength = 1000;
    public const int MaxRowLimit = 500, MaxBuckets = 100, MaxDistinct = 1000;
}

/// <summary>Input rules for every API request. Throws <see cref="RequestValidationException"/>; never clamps.</summary>
public static class RequestRules
{
    public const string HostSchemeMessage = "Enter the host name only — no http:// or https://.";
    public const string HostPortMessage = "Enter the host name only — put the port in Port.";
    public const string HostPathMessage = "Enter the host name only — no path.";
    public const string HostInvalidMessage = "Enter a valid host name or IP address.";
    private static readonly Regex HostName = new(
        @"^[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(\.[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*\.?$", RegexOptions.CultureInvariant);
    private static readonly HashSet<string> Ops = new(StringComparer.OrdinalIgnoreCase) { "=", "!=", ">", ">=", "<", "<=", "in", "between" };
    private static RequestValidationException Bad(string message, string field) => new(message, field);

    /// <summary>Null when the host is valid, else the user-facing reason (same text as validate.js).</summary>
    public static string? HostError(string? raw)
    {
        var h = raw?.Trim() ?? "";
        if (h.Length == 0) return "Host is required.";
        if (h.Length > ApiLimits.MaxHostLength) return $"Host must be at most {ApiLimits.MaxHostLength} characters.";
        if (h.Contains("://")) return HostSchemeMessage;
        if (h.Contains('/')) return HostPathMessage;
        if (h.StartsWith('['))
        {
            var close = h.IndexOf(']');
            if (close < 0) return HostInvalidMessage;
            if (close != h.Length - 1) return HostPortMessage;
            return IsIPv6(h[1..close]) ? null : HostInvalidMessage;
        }
        if (h.Count(c => c == ':') >= 2) return IsIPv6(h) ? null : HostInvalidMessage;
        if (h.Contains(':')) return HostPortMessage;
        return HostName.IsMatch(h) ? null : HostInvalidMessage;
    }
    private static bool IsIPv6(string s) => IPAddress.TryParse(s, out var a) && a.AddressFamily == AddressFamily.InterNetworkV6;

    public static void ValidateConnect(string? host, int? port, string? user, string? password)
    {
        if (HostError(host) is { } hostError) throw Bad(hostError, "host");
        if (port is null) throw Bad("Port is required.", "port");
        if (port is < 1 or > 65535) throw Bad("Port must be a whole number from 1 to 65535.", "port");
        if (string.IsNullOrWhiteSpace(user)) throw Bad("User is required.", "user");
        if (user.Trim().Length > ApiLimits.MaxUserLength) throw Bad($"User must be at most {ApiLimits.MaxUserLength} characters.", "user");
        if ((password?.Length ?? 0) > ApiLimits.MaxPasswordLength) throw Bad($"Password must be at most {ApiLimits.MaxPasswordLength} characters.", "password");
    }

    public static void ValidateFilterShape(string? op, string? value, string[]? values, string field)
    {
        if (op is null || !Ops.Contains(op)) throw Bad("Unknown filter operator.", field + ".op");
        switch (op.ToLowerInvariant())
        {
            case "in":
                if (values is not { Length: > 0 }) throw Bad("Pick at least one value.", field + ".values");
                if (values.Length > ApiLimits.MaxInValues) throw Bad($"An 'in' filter can list at most {ApiLimits.MaxInValues} values.", field + ".values");
                break;
            case "between":
                if (values is not { Length: 2 } || values.Any(string.IsNullOrWhiteSpace)) throw Bad("A range filter needs both From and To.", field + ".values");
                break;
            default:
                if (value is null) throw Bad("A filter value is required.", field + ".value");
                break;
        }
        if (values?.Any(v => v is null) == true) throw Bad("A filter value is required.", field + ".values");
        if ((value?.Length ?? 0) > ApiLimits.MaxFilterValueLength || values?.Any(v => v.Length > ApiLimits.MaxFilterValueLength) == true)
            throw Bad($"A filter value must be at most {ApiLimits.MaxFilterValueLength} characters.", field);
    }

    private static void ValidateRange(int? v, int max, string label, string field)
    { if (v is { } n && (n < 1 || n > max)) throw Bad($"{label} must be between 1 and {max}.", field); }
    private static void NoNulls<T>(T?[]? items, string field) where T : class
    { for (var i = 0; i < (items?.Length ?? 0); i++) if (items![i] is null) throw Bad($"'{field}[{i}]' is required.", $"{field}[{i}]"); }

    public static void ValidateQuery(QueryRequest r)
    {
        if (r.From is null) throw Bad("'from' is required.", "from");
        NoNulls(r.Joins, "joins"); NoNulls(r.RowDimensions, "rowDimensions"); NoNulls(r.ColumnDimensions, "columnDimensions"); NoNulls(r.Measures, "measures");
        var dims = (r.RowDimensions?.Length ?? 0) + (r.ColumnDimensions?.Length ?? 0);
        if (dims > ApiLimits.MaxDimensions) throw Bad($"A view can group by at most {ApiLimits.MaxDimensions} fields.", "rowDimensions");
        var measures = r.Measures?.Length ?? 0;
        if (measures > ApiLimits.MaxMeasures) throw Bad($"A view can show at most {ApiLimits.MaxMeasures} measures.", "measures");
        if ((r.Joins?.Length ?? 0) > ApiLimits.MaxJoins) throw Bad($"A view can join at most {ApiLimits.MaxJoins} tables.", "joins");
        var filters = r.Filters ?? [];
        if (filters.Length > ApiLimits.MaxFilters) throw Bad($"A view can have at most {ApiLimits.MaxFilters} filters.", "filters");
        for (var i = 0; i < filters.Length; i++)
        {
            if (filters[i] is not { } f) throw Bad($"'filters[{i}]' is required.", $"filters[{i}]");
            ValidateFilterShape(f.Op, f.Value, f.Values, $"filters[{i}]");
        }
        ValidateRange(r.Limit, ApiLimits.MaxRowLimit, "Limit", "limit");
        if (r.Sort is { } s && !ClickHouseGateway.IsValidSortAlias(s.Column, dims, Math.Max(1, measures)))
            throw Bad("Unknown sort column.", "sort.column");
    }
    public static void ValidateHistogram(HistogramRequest r) { ValidateRange(r.Buckets, ApiLimits.MaxBuckets, "Bins", "buckets"); ValidateStatFilters(r.Filters); }
    public static void ValidateBoxPlot(BoxPlotRequest r) { ValidateRange(r.Limit, ApiLimits.MaxRowLimit, "Limit", "limit"); ValidateStatFilters(r.Filters); }
    public static void ValidateDistinctLimit(int? limit) => ValidateRange(limit, ApiLimits.MaxDistinct, "Limit", "limit");
    private static void ValidateStatFilters(AggregateFilter[]? filters) // Task 3 changes the type to StatFilter[] and passes f.Values
    {
        if ((filters?.Length ?? 0) > ApiLimits.MaxFilters) throw Bad($"A view can have at most {ApiLimits.MaxFilters} filters.", "filters");
        for (var i = 0; i < (filters?.Length ?? 0); i++)
        {
            if (filters![i] is not { } f) throw Bad($"'filters[{i}]' is required.", $"filters[{i}]");
            ValidateFilterShape(f.Op, f.Value, null, $"filters[{i}]");
        }
    }
}
