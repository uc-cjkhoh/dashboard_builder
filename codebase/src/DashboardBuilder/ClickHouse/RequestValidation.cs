using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using DashboardBuilder.ClickHouse.Calc;
namespace DashboardBuilder.ClickHouse;
/// <summary>Client input that breaks a rule. Always a 400 with this message and the offending field path.</summary>
public sealed class RequestValidationException(string message, string? field = null) : Exception(message)
{ public string? Field { get; } = field; }
/// <summary>Every input bound — mirrored in Features/Core/validate.js LIMITS. Reject beyond these, never clamp.</summary>
public static class ApiLimits
{
    public const int MaxBodyBytes = 256 * 1024;
    public const int MaxHostLength = 253, MaxUserLength = 64, MaxPasswordLength = 256;
    public const int MaxDimensions = 12, MaxMeasures = 10, MaxJoins = 10, MaxFilters = 20; // user filters (client cap 8) + shared filters (4) + drill path (5) + page + selection + date range
    public const int MaxInValues = 500, MaxFilterValueLength = 1000;
    public const int MaxRowLimit = 5000, MaxBuckets = 100, MaxDistinct = 1000;
    public const int MaxExportRows = 100_000; // CSV export of a whole worksheet result
    public const int DefaultRowsLimit = 100, MaxRowsLimit = 1000; // raw rows of one table (POST /api/rows): default / cap
    public const int MaxRowsCells = 50_000; // rows x columns one row read may return
    public const int MaxRowsColumns = 200, MaxCellLength = 1000;  // columns one row read returns; characters kept per cell
    public const int MaxOffset = 10_000_000;  // how deep a table may page
    public const int MaxCalcDepth = CalcLimits.MaxDepth, MaxCalcNodes = CalcLimits.MaxNodes; // calculation tree; formula length (500) is client-only
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
    private static readonly HashSet<string> Ops = new(StringComparer.OrdinalIgnoreCase)
        { "=", "!=", ">", ">=", "<", "<=", "in", "notin", "between", "contains", "startsWith", "endsWith", "top" }; // P30: text match + top-N
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
            case "in" or "notin":
                if (values is not { Length: > 0 }) throw Bad("Pick at least one value.", field + ".values");
                if (values.Length > ApiLimits.MaxInValues) throw Bad($"A{(op.Equals("notin", StringComparison.OrdinalIgnoreCase) ? " 'not in'" : "n 'in'")} filter can list at most {ApiLimits.MaxInValues} values.", field + ".values");
                break;
            case "between":
                if (values is not { Length: 2 } || values.Any(string.IsNullOrWhiteSpace)) throw Bad("A range filter needs both From and To.", field + ".values");
                break;
            case "contains" or "startswith" or "endswith":
                if (string.IsNullOrWhiteSpace(value)) throw Bad("Enter the text to match.", field + ".value");
                break;
            case "top":
                if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var n) || n < 1 || n > 1000)
                    throw Bad("Top-N must be a whole number from 1 to 1000.", field + ".value");
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

    // Calculated fields (E13). Shape, role, label and size only — the tree is checked against the live catalog in the gateway.
    private static void CheckCalcTree(ExprNode calc, string label, string field)
    {
        if (label is { } l && l.Length > CalcLimits.MaxName)
            throw Bad($"A calculation's name must be at most {CalcLimits.MaxName} characters.", field + ".column");
        try { CalcValidator.CheckLimits(calc); }
        catch (CalcException e) { throw Bad(e.Message, field + ".calc"); }
    }

    private static void CheckCalcDimension(ColumnRef d, string field)
    {
        if (d.Calc is not { } calc) return;
        CheckCalcTree(calc, d.Column, field);
        if (d.DatePart is not null) throw Bad("A calculation can't be grouped by a date part.", field + ".datePart");
        if (CalcValidator.ContainsAggregate(calc)) throw Bad("A dimension can't contain an aggregate. Put it in a measure instead.", field + ".calc");
    }

    private static void CheckCalcMeasure(MeasureRef m, string field)
    {
        if (m.Calc is not { } calc)
        {
            // Agg binds as nullable (an aggregate calculation has none), so a plain measure's is required here.
            if (m.Agg is null) throw Bad($"'{field}.agg' is required.", field + ".agg");
            return;
        }
        CheckCalcTree(calc, m.Column, field);
        if (CalcValidator.ContainsAggregate(calc))
        {
            if (m.Agg is not null) throw Bad("A calculation that already aggregates takes no further aggregation.", field + ".calc");
        }
        else if (string.Equals(m.Agg, "count", StringComparison.OrdinalIgnoreCase))
            throw Bad("Counting rows doesn't use the calculation.", field + ".calc");
        else if (m.Agg is null || !CalcCatalog.RowLevelAggregations.Contains(m.Agg.ToLowerInvariant()))
            throw Bad("Choose how to aggregate this calculation: sum, average, min, max, distinct count or non-null count.", field + ".calc");
    }

    /// <summary>P26 per-dimension date parts: "auto" / "exact", truncations, and discrete parts.</summary>
    public static readonly IReadOnlySet<string> DateParts = new HashSet<string>(StringComparer.Ordinal)
        { "auto", "exact", "year", "quarter", "month", "week", "day", "hour", "quarterOfYear", "monthOfYear", "dayOfWeek", "hourOfDay" };

    public static readonly IReadOnlySet<string> DateBuckets = new HashSet<string>(StringComparer.Ordinal)
        { "auto", "hour", "day", "week", "month", "quarter", "year" };

    public static void ValidateQuery(QueryRequest r) => ValidateQuery(r, ApiLimits.MaxRowLimit);

    /// <summary>A worksheet query; <paramref name="maxLimit"/> is higher for CSV export.</summary>
    public static void ValidateQuery(QueryRequest r, int maxLimit)
    {
        if (r.From is null) throw Bad("'from' is required.", "from");
        NoNulls(r.Joins, "joins"); NoNulls(r.RowDimensions, "rowDimensions"); NoNulls(r.ColumnDimensions, "columnDimensions"); NoNulls(r.Measures, "measures");
        var dims = (r.RowDimensions?.Length ?? 0) + (r.ColumnDimensions?.Length ?? 0);
        if (dims > ApiLimits.MaxDimensions) throw Bad($"A view can group by at most {ApiLimits.MaxDimensions} fields.", "rowDimensions");
        var measures = r.Measures?.Length ?? 0;
        if (measures > ApiLimits.MaxMeasures) throw Bad($"A view can show at most {ApiLimits.MaxMeasures} measures.", "measures");
        if ((r.Joins?.Length ?? 0) > ApiLimits.MaxJoins) throw Bad($"A view can join at most {ApiLimits.MaxJoins} tables.", "joins");
        for (var i = 0; i < (r.Joins?.Length ?? 0); i++)
        {
            if (r.Joins![i].Type is { } jt && jt != "inner" && jt != "left") throw Bad("A join is inner or left.", $"joins[{i}].type");
            if (r.Joins[i].Left?.Calc is not null) throw Bad("Calculations can't be used as a join key.", $"joins[{i}].left.calc");
            if (r.Joins[i].Right?.Calc is not null) throw Bad("Calculations can't be used as a join key.", $"joins[{i}].right.calc");
        }
        for (var i = 0; i < (r.RowDimensions?.Length ?? 0); i++) CheckCalcDimension(r.RowDimensions![i], $"rowDimensions[{i}]");
        for (var i = 0; i < (r.ColumnDimensions?.Length ?? 0); i++) CheckCalcDimension(r.ColumnDimensions![i], $"columnDimensions[{i}]");
        for (var i = 0; i < (r.Measures?.Length ?? 0); i++) CheckCalcMeasure(r.Measures![i], $"measures[{i}]");
        var filters = r.Filters ?? [];
        if (filters.Length > ApiLimits.MaxFilters) throw Bad($"A view can have at most {ApiLimits.MaxFilters} filters.", "filters");
        for (var i = 0; i < filters.Length; i++)
        {
            if (filters[i] is not { } f) throw Bad($"'filters[{i}]' is required.", $"filters[{i}]");
            ValidateFilterShape(f.Op, f.Value, f.Values, $"filters[{i}]");
            if (string.Equals(f.Op, "top", StringComparison.OrdinalIgnoreCase) && f.TopBy is null)
                throw Bad("A top-N filter needs a measure to rank by.", $"filters[{i}].topBy");
            if (f.TopBy is { } by) CheckCalcMeasure(by, $"filters[{i}].topBy");
        }
        ValidateRange(r.Limit, maxLimit, "Limit", "limit");
        if (r.Offset is { } off && (off < 0 || off > ApiLimits.MaxOffset))
            throw Bad($"Offset must be between 0 and {ApiLimits.MaxOffset}.", "offset");
        var dimList = (r.RowDimensions ?? []).Concat(r.ColumnDimensions ?? []).ToArray();
        for (var i = 0; i < dimList.Length; i++)
            if (dimList[i].DatePart is { } part && !DateParts.Contains(part))
                throw Bad("Date part must be auto, exact, year, quarter, month, week, day, hour, quarter of year, month of year, day of week or hour of day.", "datePart");
        if (r.DateBucket is { } b && !DateBuckets.Contains(b))
            throw Bad("Date grouping must be auto, hour, day, week, month, quarter or year.", "dateBucket");
        if (r.Sort is { } s && !ClickHouseGateway.IsValidSortAlias(s.Column, dims, Math.Max(1, measures)))
            throw Bad("Unknown sort column.", "sort.column");
    }
    /// <summary>A raw-row read (POST /api/rows): names present, columns and filters bounded, limit 1..1000 (never clamped).</summary>
    public static void ValidateRows(RowsRequest r)
    {
        if (string.IsNullOrWhiteSpace(r.Db)) throw Bad("'db' is required.", "db");
        if (string.IsNullOrWhiteSpace(r.Table)) throw Bad("'table' is required.", "table");
        var cols = r.Columns ?? [];
        if (cols.Length > ApiLimits.MaxRowsColumns) throw Bad($"A row read can return at most {ApiLimits.MaxRowsColumns} columns.", "columns");
        for (var i = 0; i < cols.Length; i++)
            if (string.IsNullOrWhiteSpace(cols[i])) throw Bad($"'columns[{i}]' is required.", $"columns[{i}]");
        ValidateRange(r.Limit, ApiLimits.MaxRowsLimit, "Limit", "limit");
        if (cols.Length > 0) ValidateRowCells(r.Limit ?? ApiLimits.DefaultRowsLimit, cols.Length, "limit");
        ValidateStatFilters(r.Filters);
    }
    /// <summary>rows x columns must stay within <see cref="ApiLimits.MaxRowsCells"/> — ask for fewer rows or columns.</summary>
    public static void ValidateRowCells(int rows, int columns, string field)
    {
        if ((long)rows * columns > ApiLimits.MaxRowsCells)
            throw Bad($"{columns} columns allow at most {ApiLimits.MaxRowsCells / Math.Max(1, columns)} rows — ask for fewer rows or columns ({ApiLimits.MaxRowsCells:N0} cells in all).", field);
    }
    public static void ValidateHistogram(HistogramRequest r) { ValidateRange(r.Buckets, ApiLimits.MaxBuckets, "Bins", "buckets"); ValidateStatFilters(r.Filters); }
    public static void ValidateBoxPlot(BoxPlotRequest r) { ValidateRange(r.Limit, ApiLimits.MaxRowLimit, "Limit", "limit"); ValidateStatFilters(r.Filters); }
    public static void ValidateDistinctLimit(int? limit) => ValidateRange(limit, ApiLimits.MaxDistinct, "Limit", "limit");
    private static void ValidateStatFilters(StatFilter[]? filters)
    {
        if ((filters?.Length ?? 0) > ApiLimits.MaxFilters) throw Bad($"A view can have at most {ApiLimits.MaxFilters} filters.", "filters");
        for (var i = 0; i < (filters?.Length ?? 0); i++)
        {
            if (filters![i] is not { } f) throw Bad($"'filters[{i}]' is required.", $"filters[{i}]");
            ValidateFilterShape(f.Op, f.Value, f.Values, $"filters[{i}]");
            if (string.Equals(f.Op, "top", StringComparison.OrdinalIgnoreCase))
                throw Bad("Top-N filters apply to the worksheet query, not a histogram, box plot or row read.", $"filters[{i}].op");
        }
    }
}

/// <summary>Converts a filter value to its column's category before it is bound — a value that doesn't fit is a 400, not a ClickHouse 502.</summary>
public static class FilterValues
{
    private static readonly string[] DateFormats = ["yyyy-MM-dd", "yyyy-MM-dd HH:mm", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-ddTHH:mm", "yyyy-MM-ddTHH:mm:ss"];
    // Digits, optional sign, one '.', optional exponent — rejects "1,000", "1 000", "0x10", "NaN", "Infinity".
    private static readonly Regex PlainNumber = new(@"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$", RegexOptions.CultureInvariant);

    public static (string Type, object Value) Coerce(string category, string column, string raw, string field, bool dateOnly = false)
    {
        var v = raw.Trim();
        switch (category)
        {
            case ClickHouseType.Numeric:
                if (PlainNumber.IsMatch(v) && double.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && double.IsFinite(d))
                    return ("Float64", d);
                throw new RequestValidationException($"'{raw}' is not a number for column {column}.", field);
            case ClickHouseType.Temporal:
                if (DateTime.TryParseExact(v, DateFormats, CultureInfo.InvariantCulture, DateTimeStyles.None, out var t))
                {
                    if (dateOnly && v.Length > 10)
                        throw new RequestValidationException($"'{raw}' has a time, but column {column} holds dates only — use YYYY-MM-DD.", field);
                    return ("String", t.ToString(v.Length == 10 ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture));
                }
                throw new RequestValidationException($"'{raw}' is not a date (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS) for column {column}.", field);
            case ClickHouseType.Boolean:
                return v.ToLowerInvariant() switch
                {
                    "true" or "1" => ("UInt8", (byte)1),
                    "false" or "0" => ("UInt8", (byte)0),
                    _ => throw new RequestValidationException($"'{raw}' is not true or false for column {column}.", field),
                };
            case ClickHouseType.Text:
                return ("String", raw);
            default:
                throw new RequestValidationException($"Column {column} can't be filtered — its type can't be compared.", field);
        }
    }
    /// <summary>Order two coerced values; 0 for categories where order isn't checked (text).</summary>
    public static int Compare(string category, object a, object b) => category switch
    {
        ClickHouseType.Numeric => ((double)a).CompareTo((double)b),
        ClickHouseType.Temporal => string.CompareOrdinal((string)a, (string)b),
        _ => 0,
    };
}
