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
    public const int MaxDimensions = 12, MaxMeasures = 10, MaxJoins = 10, MaxJoinPairs = 4 /* key pairs of one join, the first included */, MaxFilters = 20, MaxHaving = 10 /* conditions on aggregated measures, ANDed; the client sends at most one per measure */; // user filters (client cap 8) + shared filters (4) + drill path (5) + page + selection + date range
    public const int MaxInValues = 500, MaxFilterValueLength = 1000;
    public const int MaxBoxOutliers = 500; // outlier points one box plot returns
    public const int MaxRowLimit = 5000, MaxBuckets = 100, MaxDistinct = 1000;
    public const int MaxExportRows = 100_000; // CSV export of a whole worksheet result
    public const int DefaultRowsLimit = 100, MaxRowsLimit = 1000; // raw rows of one table (POST /api/rows): default / cap
    public const int MaxUnpivotColumns = 50, MaxUnpivotKeep = 5;  // wide columns one unpivot turns into rows / columns it keeps (POST /api/unpivot)
    public const int MaxCustomSqlChars = 10_000; // characters in a card's custom SQL (D105)
    public const int MaxSourceName = 200;  // characters in a union / unpivot source's name (the table name its fields carry)
    public const int MaxUnionTables = 5;  // tables one union stacks (POST /api/union)
    public const int MaxRowsCells = 50_000; // rows x columns one row read may return
    public const int MaxRowsColumns = 200, MaxCellLength = 1000;  // columns one row read returns; characters kept per cell
    public const int ProfileSampleRows = 1_000_000;  // a column profile scans the first N rows of the table
    public const int DefaultProfileTop = 10, MaxProfileTop = 50, ProfileValueLength = 100, MaxColumnName = 1000; // top values; characters kept per value
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
        { "=", "!=", ">", ">=", "<", "<=", "in", "notin", "between", "contains", "startsWith", "endsWith", "top" }; // text match + top-N
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

    // Calculated fields. Shape, role, label and size only — the tree is checked against the live catalog in the gateway.
    private static void CheckCalcTree(ExprNode calc, string label, string field)
    {
        if (label is { } l && l.Length > CalcLimits.MaxName)
            throw Bad($"A calculation's name must be at most {CalcLimits.MaxName} characters.", field + ".column");
        try { CalcValidator.CheckLimits(calc); }
        catch (CalcException e) { throw Bad(e.Message, field + ".calc"); }
    }

    // A cast is a whitelisted word, and a calculation (which has its own type) takes none.
    private static void CheckCast(string? cast, bool isCalc, string field)
    {
        if (cast is null) return;
        if (!TypeCast.Casts.Contains(cast)) throw Bad(TypeCast.UnknownMessage, field + ".cast");
        if (isCalc) throw Bad(TypeCast.CalcMessage, field + ".cast");
    }

    private static void CheckCalcDimension(ColumnRef d, string field)
    {
        CheckCast(d.Cast, d.Calc is not null, field);
        if (d.Calc is not { } calc) return;
        CheckCalcTree(calc, d.Column, field);
        if (d.DatePart is not null) throw Bad("A calculation can't be grouped by a date part.", field + ".datePart");
        if (CalcValidator.ContainsAggregate(calc)) throw Bad("A dimension can't contain an aggregate. Put it in a measure instead.", field + ".calc");
    }

    /// <summary>The percentile fraction rule (finite, 0..1) — never clamped.</summary>
    public const string PercentileMessage = "Percentile must be between 0 and 100 percent.";

    private static void CheckCalcMeasure(MeasureRef m, string field)
    {
        CheckCast(m.Cast, m.Calc is not null, field);
        if (m.Calc is not { } calc)
        {
            // Agg binds as nullable (an aggregate calculation has none), so a plain measure's is required here.
            if (m.Agg is null) throw Bad($"'{field}.agg' is required.", field + ".agg");
            if (string.Equals(m.Agg, "percentile", StringComparison.OrdinalIgnoreCase))
            {
                if (m.P is not { } p) throw Bad($"'{field}.p' is required for a percentile.", field + ".p");
                if (!double.IsFinite(p) || p < 0 || p > 1) throw Bad(PercentileMessage, field + ".p");
            }
            else if (m.P is not null) throw Bad("Only a percentile takes a fraction.", field + ".p");
            return;
        }
        if (m.P is not null) throw Bad("A calculation takes no percentile fraction.", field + ".p");
        CheckCalcTree(calc, m.Column, field);
        if (CalcValidator.ContainsAggregate(calc))
        {
            if (m.Agg is not null) throw Bad("A calculation that already aggregates takes no further aggregation.", field + ".calc");
        }
        else if (string.Equals(m.Agg, "count", StringComparison.OrdinalIgnoreCase))
            throw Bad("Counting rows doesn't use the calculation.", field + ".calc");
        else if (m.Agg is null || !CalcCatalog.RowLevelAggregations.Contains(m.Agg.ToLowerInvariant()))
            throw Bad(CalcCatalog.RowLevelHint, field + ".calc");
    }

    /// <summary>Per-dimension date parts: "auto" / "exact", truncations, and discrete parts.</summary>
    public static readonly IReadOnlySet<string> DateParts = new HashSet<string>(StringComparer.Ordinal)
        { "auto", "exact", "year", "quarter", "month", "week", "day", "hour", "quarterOfYear", "monthOfYear", "dayOfWeek", "hourOfDay" };

    public static readonly IReadOnlySet<string> DateBuckets = new HashSet<string>(StringComparer.Ordinal)
        { "auto", "hour", "day", "week", "month", "quarter", "year" };

    /// <summary>Aggregating each table to the key before the join (<see cref="AggregateJoin"/>) is built for a plain two-table view: no calculations, no top-N, and only
    /// aggregates that recombine (sum, count, min, max, average).</summary>
    private static void CheckAggregateFirst(QueryRequest r)
    {
        if (r.Joins!.Length != 1)
            throw Bad("Aggregating before the join works on a view of exactly two tables — this one joins more. Turn it off on the relationship, or use fields of two tables only.", "joins");
        for (var i = 0; i < (r.Measures?.Length ?? 0); i++)
        {
            var m = r.Measures![i];
            if (m.Calc is not null) throw Bad("A calculated measure can't be combined before the join — turn off aggregating before the join on the relationship.", $"measures[{i}]");
            if (m.Agg is { Length: 0 }) throw Bad("A measure needs an aggregation.", $"measures[{i}]");
            var agg = (m.Agg ?? "count").ToLowerInvariant();
            if (!AggregateJoin.Combinable.Contains(agg))
                throw Bad($"{char.ToUpperInvariant(agg[0])}{agg[1..]} can't be combined before the join — use Sum, Count, Min, Max or Average, or turn off aggregating before the join.", $"measures[{i}]");
        }
        foreach (var (d, field) in (r.RowDimensions ?? []).Select((d, i) => (d, $"rowDimensions[{i}]")).Concat((r.ColumnDimensions ?? []).Select((d, i) => (d, $"columnDimensions[{i}]"))))
            if (d.Calc is not null) throw Bad("A calculated field can't group a view that aggregates before the join — turn it off on the relationship.", field);
        for (var i = 0; i < (r.Filters?.Length ?? 0); i++)
        {
            var f = r.Filters![i];
            if (f is null) continue;
            if (f.Calc is not null) throw Bad("A calculated field can't filter a view that aggregates before the join — turn it off on the relationship.", $"filters[{i}]");
            if (string.Equals(f.Op, "top", StringComparison.OrdinalIgnoreCase)) throw Bad("A top-N filter can't be combined with aggregating before the join — turn it off on the relationship.", $"filters[{i}]");
        }
    }

    public static void ValidateQuery(QueryRequest r) => ValidateQuery(r, ApiLimits.MaxRowLimit);

    /// <summary>A worksheet query; <paramref name="maxLimit"/> is higher for CSV export.</summary>
    public static void ValidateQuery(QueryRequest r, int maxLimit)
    {
        if (r.From is null) throw Bad("'from' is required.", "from");
        ValidateSources(r);
        if (r.Source is { } src)
        {
            ValidateSource(src);
            if (r.From.Db != src.Db || r.From.Table != src.Name) throw Bad("A union or unpivot is read as its own table — 'from' must name it.", "from");
            if ((r.Joins?.Length ?? 0) > 0) throw Bad("A union or unpivot can't be joined to other tables yet — build the view from it alone.", "joins");
        }
        NoNulls(r.Joins, "joins"); NoNulls(r.RowDimensions, "rowDimensions"); NoNulls(r.ColumnDimensions, "columnDimensions"); NoNulls(r.Measures, "measures");
        var dims = (r.RowDimensions?.Length ?? 0) + (r.ColumnDimensions?.Length ?? 0);
        if (dims > ApiLimits.MaxDimensions) throw Bad($"A view can group by at most {ApiLimits.MaxDimensions} fields.", "rowDimensions");
        var measures = r.Measures?.Length ?? 0;
        if (measures > ApiLimits.MaxMeasures) throw Bad($"A view can show at most {ApiLimits.MaxMeasures} measures.", "measures");
        if ((r.Joins?.Length ?? 0) > ApiLimits.MaxJoins) throw Bad($"A view can join at most {ApiLimits.MaxJoins} tables.", "joins");
        for (var i = 0; i < (r.Joins?.Length ?? 0); i++)
        {
            if (r.Joins![i].Type is { } jt && jt is not ("inner" or "left" or "right" or "full")) throw Bad("A join is inner, left, right or full.", $"joins[{i}].type");
            JoinPairRules.Check(r.Joins[i].Pairs, $"joins[{i}].pairs");
            if (r.Joins[i].FilterDirection is { } fd && fd is not ("both" or "single")) throw Bad("A filter direction is both or single.", $"joins[{i}].filterDirection");
            if (r.Joins[i].Left?.Calc is not null) throw Bad("Calculations can't be used as a join key.", $"joins[{i}].left.calc");
            if (r.Joins[i].Right?.Calc is not null) throw Bad("Calculations can't be used as a join key.", $"joins[{i}].right.calc");
        }
        for (var i = 0; i < (r.RowDimensions?.Length ?? 0); i++) CheckCalcDimension(r.RowDimensions![i], $"rowDimensions[{i}]");
        for (var i = 0; i < (r.ColumnDimensions?.Length ?? 0); i++) CheckCalcDimension(r.ColumnDimensions![i], $"columnDimensions[{i}]");
        for (var i = 0; i < (r.Measures?.Length ?? 0); i++) CheckCalcMeasure(r.Measures![i], $"measures[{i}]");
        if ((r.Joins ?? []).Any(j => j.Aggregate == true)) CheckAggregateFirst(r);
        var filters = r.Filters ?? [];
        var rightOrFull = (r.Joins ?? []).Any(j => j.Type is "right" or "full");
        if (filters.Length > ApiLimits.MaxFilters) throw Bad($"A view can have at most {ApiLimits.MaxFilters} filters.", "filters");
        for (var i = 0; i < filters.Length; i++)
        {
            if (filters[i] is not { } f) throw Bad($"'filters[{i}]' is required.", $"filters[{i}]");
            ValidateFilterShape(f.Op, f.Value, f.Values, $"filters[{i}]");
            CheckCast(f.Cast, f.Calc is not null, $"filters[{i}]");
            if (f.Calc is { } fc)
            {
                CheckCalcTree(fc, f.Column, $"filters[{i}]");
                if (string.Equals(f.Op, "top", StringComparison.OrdinalIgnoreCase)) throw Bad("A top-N filter ranks a plain field's members — it can't use a calculated field.", $"filters[{i}].calc");
                if (CalcValidator.ContainsAggregate(fc)) throw Bad("A filter can't contain an aggregate — it is applied to each row before the view is grouped.", $"filters[{i}].calc");
            }
            if (rightOrFull && string.Equals(f.Op, "top", StringComparison.OrdinalIgnoreCase))
                throw Bad("A top-N filter can't be combined with a right or full join — unmatched rows have no key to rank.", $"filters[{i}]");
            if (string.Equals(f.Op, "top", StringComparison.OrdinalIgnoreCase) && f.TopBy is null)
                throw Bad("A top-N filter needs a measure to rank by.", $"filters[{i}].topBy");
            if (f.TopBy is { } by) CheckCalcMeasure(by, $"filters[{i}].topBy");
        }
        ValidateHaving(r.Having, Math.Max(1, measures));
        if (r.Having is { Length: > 0 } && r.OtherBucket == true) throw Bad("An Other bucket can't be combined with a filter on a measure.", "otherBucket");
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
    /// <summary>Operators a filter on an aggregated measure (HAVING) may use — a subset of the row filter's, numbers only.</summary>
    public static readonly IReadOnlySet<string> HavingOps = new HashSet<string>(StringComparer.Ordinal) { "=", "!=", ">", ">=", "<", "<=", "between" };

    /// <summary>The measure-filter rules (mirrored by Core/validate.js and Dashboard/having-model.js): at most <see cref="ApiLimits.MaxHaving"/>,
    /// each on a measure of the view, a whitelisted operator, and plain finite numbers (a range has From &lt;= To). Rejected, never clamped.</summary>
    public static void ValidateHaving(HavingFilter[]? having, int measureSlots)
    {
        if (having is null) return;
        if (having.Length > ApiLimits.MaxHaving) throw Bad($"A view can filter on at most {ApiLimits.MaxHaving} measures.", "having");
        for (var i = 0; i < having.Length; i++)
        {
            if (having[i] is not { } h) throw Bad($"'having[{i}]' is required.", $"having[{i}]");
            var field = $"having[{i}]";
            if (h.Measure < 0 || h.Measure >= measureSlots) throw Bad("A measure filter must name one of the view's measures.", field + ".measure");
            if (h.Op is null || !HavingOps.Contains(h.Op)) throw Bad("A measure filter is =, !=, >, >=, <, <= or between.", field + ".op");
            if (h.Op == "between")
            {
                if (h.Values is not { Length: 2 } || h.Values.Any(string.IsNullOrWhiteSpace)) throw Bad("A range filter needs both From and To.", field + ".values");
                var (lo, hi) = (FilterValues.Coerce(ClickHouseType.Numeric, "measure", h.Values[0], field + ".values"), FilterValues.Coerce(ClickHouseType.Numeric, "measure", h.Values[1], field + ".values"));
                if ((double)lo.Value > (double)hi.Value) throw Bad("From must be less than or equal to To for column measure.", field + ".values");
            }
            else
            {
                if (string.IsNullOrWhiteSpace(h.Value)) throw Bad("A filter value is required.", field + ".value");
                FilterValues.Coerce(ClickHouseType.Numeric, "measure", h.Value, field + ".value");
            }
        }
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
        ValidateSqlSource(r.Source, r.Db, r.Table);
    }
    /// <summary>The optional custom SQL a single-table read (rows, profile, histogram, join preview end) reads instead of the catalog table: kind
    /// <c>sql</c> only, a query the guard accepts, and it must stand for the very table the request names (<paramref name="db"/>.<paramref name="table"/>).
    /// <paramref name="prefix"/> (e.g. <c>"from."</c>) is put before the field path of whatever is refused.</summary>
    public static void ValidateSqlSource(QuerySource? s, string? db, string? table, string prefix = "")
    {
        if (s is null) return;
        try
        {
            if (s.Kind != SourceSql.Sql) throw Bad("Only a custom SQL source can stand in for a table here.", "source.kind");
            ValidateSource(s);
            if (!string.Equals(s.Db, db, StringComparison.Ordinal) || !string.Equals(s.Name, table, StringComparison.Ordinal))
                throw Bad("The custom SQL must be the one of the table being read.", "source.name");
        }
        catch (RequestValidationException ex) { throw Bad(ex.Message, prefix + ex.Field); }
    }
    /// <summary>A union / unpivot used as a query source (QueryRequest.Source, POST /api/source/columns): a whitelisted kind, named tables and
    /// columns within the preview's limits (2..5 tables; 2..50 unpivoted, up to 5 kept), a bounded name. Never clamped. Field paths start "source.".</summary>
    /// <summary>The custom SQL cards of a query (<see cref="QueryRequest.Sources"/>): custom SQL only, at most one per table, never beside a union / unpivot.</summary>
    private static void ValidateSources(QueryRequest r)
    {
        var list = r.Sources ?? [];
        if (list.Length == 0) return;
        if (list.Length > ApiLimits.MaxJoins + 1) throw Bad($"A view can read at most {ApiLimits.MaxJoins + 1} tables with custom SQL.", "sources");
        if (r.Source is not null) throw Bad("A union or unpivot can't be combined with a custom SQL table.", "sources");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < list.Length; i++)
        {
            if (list[i] is not { } s) throw Bad($"'sources[{i}]' is required.", $"sources[{i}]");
            if (s.Kind != SourceSql.Sql) throw Bad("Only a custom SQL table can be listed in 'sources'.", $"sources[{i}].kind");
            try { ValidateSource(s); }
            catch (RequestValidationException ex) { throw Bad(ex.Message, $"sources[{i}]." + (ex.Field ?? "").Replace("source.", "", StringComparison.Ordinal)); }
            if (!seen.Add($"{s.Db}\0{s.Name}")) throw Bad($"'{s.Db}.{s.Name}' is listed twice.", $"sources[{i}].name");
        }
    }

    public static void ValidateSource(QuerySource s)
    {
        if (s.Kind is not (SourceSql.Union or SourceSql.Unpivot or SourceSql.Sql)) throw Bad("A source is a union, an unpivot or a custom SQL query.", "source.kind");
        if (string.IsNullOrWhiteSpace(s.Db)) throw Bad("'source.db' is required.", "source.db");
        if (string.IsNullOrWhiteSpace(s.Name)) throw Bad("'source.name' is required.", "source.name");
        if (s.Name.Length > ApiLimits.MaxSourceName) throw Bad($"A source's name must be at most {ApiLimits.MaxSourceName} characters.", "source.name");
        var cols = s.Columns ?? [];
        var seen = new HashSet<string>(StringComparer.Ordinal);
        if (s.Kind == SourceSql.Sql)
        {
            if (s.Tables is not null || s.Table is not null || s.Columns is not null || s.Keep is not null) throw Bad("A custom SQL source takes only 'sql'.", "source.sql");
            CustomSql.Clean(s.Sql); // throws a 400 naming source.sql
            return;
        }
        if (s.Sql is not null) throw Bad("Only a custom SQL source takes 'sql'.", "source.sql");
        if (s.Kind == SourceSql.Union)
        {
            var tables = s.Tables ?? [];
            if (tables.Length < 2 || tables.Length > ApiLimits.MaxUnionTables) throw Bad($"A union needs between 2 and {ApiLimits.MaxUnionTables} tables.", "source.tables");
            for (var i = 0; i < tables.Length; i++)
            {
                if (string.IsNullOrWhiteSpace(tables[i])) throw Bad($"'source.tables[{i}]' is required.", $"source.tables[{i}]");
                if (!seen.Add(tables[i])) throw Bad($"'{tables[i]}' is listed twice.", $"source.tables[{i}]");
            }
            if (s.Table is not null) throw Bad("A union takes 'tables', not 'table'.", "source.table");
            if (s.Keep is not null) throw Bad("A union keeps no columns of its own — leave 'keep' out.", "source.keep");
            if (cols.Length > ApiLimits.MaxRowsColumns) throw Bad($"A union can return at most {ApiLimits.MaxRowsColumns} columns.", "source.columns");
            seen.Clear();
            for (var i = 0; i < cols.Length; i++)
            {
                if (string.IsNullOrWhiteSpace(cols[i])) throw Bad($"'source.columns[{i}]' is required.", $"source.columns[{i}]");
                if (!seen.Add(cols[i])) throw Bad($"'{cols[i]}' is listed twice.", $"source.columns[{i}]");
            }
            return;
        }
        if (string.IsNullOrWhiteSpace(s.Table)) throw Bad("'source.table' is required.", "source.table");
        if (s.Tables is not null) throw Bad("An unpivot takes 'table', not 'tables'.", "source.tables");
        if (cols.Length < 2 || cols.Length > ApiLimits.MaxUnpivotColumns) throw Bad($"An unpivot needs between 2 and {ApiLimits.MaxUnpivotColumns} columns.", "source.columns");
        for (var i = 0; i < cols.Length; i++)
        {
            if (string.IsNullOrWhiteSpace(cols[i])) throw Bad($"'source.columns[{i}]' is required.", $"source.columns[{i}]");
            if (!seen.Add(cols[i])) throw Bad($"'{cols[i]}' is listed twice.", $"source.columns[{i}]");
        }
        var keep = s.Keep ?? [];
        if (keep.Length > ApiLimits.MaxUnpivotKeep) throw Bad($"An unpivot can keep at most {ApiLimits.MaxUnpivotKeep} columns.", "source.keep");
        for (var i = 0; i < keep.Length; i++)
        {
            if (string.IsNullOrWhiteSpace(keep[i])) throw Bad($"'source.keep[{i}]' is required.", $"source.keep[{i}]");
            if (!seen.Add(keep[i])) throw Bad($"'{keep[i]}' is already used.", $"source.keep[{i}]");
        }
    }
    /// <summary>A union (POST /api/union): a database, 2..5 named tables, bounded columns, limit 1..1000 (never clamped).</summary>
    public static void ValidateUnion(UnionRequest r)
    {
        if (string.IsNullOrWhiteSpace(r.Db)) throw Bad("'db' is required.", "db");
        var tables = r.Tables ?? [];
        if (tables.Length < 2 || tables.Length > ApiLimits.MaxUnionTables) throw Bad($"A union needs between 2 and {ApiLimits.MaxUnionTables} tables.", "tables");
        for (var i = 0; i < tables.Length; i++)
            if (string.IsNullOrWhiteSpace(tables[i])) throw Bad($"'tables[{i}]' is required.", $"tables[{i}]");
        var cols = r.Columns ?? [];
        if (cols.Length > ApiLimits.MaxRowsColumns) throw Bad($"A union can return at most {ApiLimits.MaxRowsColumns} columns.", "columns");
        for (var i = 0; i < cols.Length; i++)
            if (string.IsNullOrWhiteSpace(cols[i])) throw Bad($"'columns[{i}]' is required.", $"columns[{i}]");
        ValidateRange(r.Limit, ApiLimits.MaxRowsLimit, "Limit", "limit");
        if (cols.Length > 0) ValidateRowCells(r.Limit ?? ApiLimits.DefaultRowsLimit, cols.Length + 1, "limit");
    }
    /// <summary>An unpivot (POST /api/unpivot): a database and table, 2..50 distinct columns to unpivot, up to 5 distinct others to keep, limit 1..1000 (never clamped).</summary>
    public static void ValidateUnpivot(UnpivotRequest r)
    {
        if (string.IsNullOrWhiteSpace(r.Db)) throw Bad("'db' is required.", "db");
        if (string.IsNullOrWhiteSpace(r.Table)) throw Bad("'table' is required.", "table");
        var cols = r.Columns ?? [];
        if (cols.Length < 2 || cols.Length > ApiLimits.MaxUnpivotColumns) throw Bad($"An unpivot needs between 2 and {ApiLimits.MaxUnpivotColumns} columns.", "columns");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < cols.Length; i++)
        {
            if (string.IsNullOrWhiteSpace(cols[i])) throw Bad($"'columns[{i}]' is required.", $"columns[{i}]");
            if (!seen.Add(cols[i])) throw Bad($"'{cols[i]}' is listed twice.", $"columns[{i}]");
        }
        var keep = r.Keep ?? [];
        if (keep.Length > ApiLimits.MaxUnpivotKeep) throw Bad($"An unpivot can keep at most {ApiLimits.MaxUnpivotKeep} columns.", "keep");
        for (var i = 0; i < keep.Length; i++)
        {
            if (string.IsNullOrWhiteSpace(keep[i])) throw Bad($"'keep[{i}]' is required.", $"keep[{i}]");
            if (!seen.Add(keep[i])) throw Bad($"'{keep[i]}' is already used.", $"keep[{i}]");
        }
        ValidateRange(r.Limit, ApiLimits.MaxRowsLimit, "Limit", "limit");
        ValidateRowCells(r.Limit ?? ApiLimits.DefaultRowsLimit, keep.Length + 2, "limit");
    }
    /// <summary>rows x columns must stay within <see cref="ApiLimits.MaxRowsCells"/> — ask for fewer rows or columns.</summary>
    public static void ValidateRowCells(int rows, int columns, string field)
    {
        if ((long)rows * columns > ApiLimits.MaxRowsCells)
            throw Bad($"{columns} columns allow at most {ApiLimits.MaxRowsCells / Math.Max(1, columns)} rows — ask for fewer rows or columns ({ApiLimits.MaxRowsCells:N0} cells in all).", field);
    }
    /// <summary>A column profile: a column name, and 1..50 top values when given (never clamped).</summary>
    public static void ValidateProfile(ProfileRequest r)
    {
        if (string.IsNullOrWhiteSpace(r.Column)) throw Bad("'column' is required.", "column");
        if (r.Column.Length > ApiLimits.MaxColumnName) throw Bad($"'column' must be at most {ApiLimits.MaxColumnName} characters.", "column");
        ValidateRange(r.Limit, ApiLimits.MaxProfileTop, "Top values", "limit");
    }
    /// <summary>A column profile of the table <paramref name="db"/>.<paramref name="table"/> (from the URL): the request rules, and its custom SQL (if any) must be that table's.</summary>
    public static void ValidateProfile(ProfileRequest r, string db, string table) { ValidateProfile(r); ValidateSqlSource(r.Source, db, table); }
    public static void ValidateHistogram(HistogramRequest r) { ValidateRange(r.Buckets, ApiLimits.MaxBuckets, "Bins", "buckets"); ValidateStatFilters(r.Filters); }
    /// <summary>A histogram of the table <paramref name="db"/>.<paramref name="table"/> (from the URL): the request rules, and its custom SQL (if any) must be that table's.</summary>
    public static void ValidateHistogram(HistogramRequest r, string db, string table) { ValidateHistogram(r); ValidateSqlSource(r.Source, db, table); }
    /// <summary>A joined / calculated box plot: a worksheet-shaped request where the one row dimension is the value and the optional
    /// one column dimension is the group — no measures, no measure filter. Everything else is the worksheet query's rules.</summary>
    public static void ValidateBoxQuery(QueryRequest r)
    {
        ValidateQuery(r);
        if (r.RowDimensions?.Length != 1) throw Bad("A box plot needs exactly one value field.", "rowDimensions");
        if ((r.ColumnDimensions?.Length ?? 0) > 1) throw Bad("A box plot groups by at most one field.", "columnDimensions");
        if ((r.Measures?.Length ?? 0) > 0) throw Bad("A box plot takes its value as a field, not a measure.", "measures");
        if ((r.Having?.Length ?? 0) > 0) throw Bad("Measure filters don't apply to a box plot.", "having");
        if ((r.Joins ?? []).Any(j => j.Aggregate == true)) throw Bad("A box plot reads every row, so it can't total each table before joining — turn that option off for this relationship.", "joins");
    }

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
            if (f.Calc is { } fc)
            {
                CheckCalcTree(fc, f.Column, $"filters[{i}]");
                if (CalcValidator.ContainsAggregate(fc)) throw Bad("A filter can't contain an aggregate — it is applied to each row before the view is grouped.", $"filters[{i}].calc");
            }
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

/// <summary>Limits on a compound join key (extra pairs beyond the first). Rejects, never clamps.</summary>
public static class JoinPairRules
{
    public static void Check(JoinColumnPair[]? pairs, string field)
    {
        if (pairs is null) return;
        if (pairs.Length > ApiLimits.MaxJoinPairs - 1)
            throw new RequestValidationException($"A join matches on at most {ApiLimits.MaxJoinPairs} column pairs.", field);
        for (var i = 0; i < pairs.Length; i++)
        {
            if (pairs[i] is null) throw new RequestValidationException("A key pair can't be null.", field);
            if (string.IsNullOrWhiteSpace(pairs[i].Left)) throw new RequestValidationException("A key pair needs a left column.", $"{field}[{i}].left");
            if (string.IsNullOrWhiteSpace(pairs[i].Right)) throw new RequestValidationException("A key pair needs a right column.", $"{field}[{i}].right");
        }
    }
}
