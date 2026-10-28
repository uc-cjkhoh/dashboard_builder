using System.Globalization;
using System.Net;
using System.Text;
using ClickHouse.Client;
using ClickHouse.Client.ADO;
using ClickHouse.Client.Utility; // AddParameter extension
using DashboardBuilder.ClickHouse.Calc;
using Microsoft.Extensions.Caching.Memory;

namespace DashboardBuilder.ClickHouse;

/// <summary>
/// The one place SQL is run against ClickHouse. Everything here is <strong>read-only</strong>
/// (validate / introspect / bounded aggregate and join queries) — there is deliberately no DDL/DML path
/// (CLAUDE.md golden rule 1). Covers connection validation, schema introspection, distinct values and
/// the worksheet's aggregate queries.
/// </summary>
public sealed class ClickHouseGateway
{
    private readonly ILogger<ClickHouseGateway> _logger;

    private readonly IMemoryCache? _cache;
    public ClickHouseGateway(ILogger<ClickHouseGateway> logger, IMemoryCache? cache = null) { _logger = logger; _cache = cache; }

    /// <summary>P33: how long a worksheet result is reused for the same server + user + request.</summary>
    internal static readonly TimeSpan CacheTtl = TimeSpan.FromSeconds(60);
    internal const double SampleFraction = 0.1;

    /// <summary>The cache key: server identity (never the password) + the request (minus Fresh) + the row cap.</summary>
    internal static string CacheKey(ClickHouseConnectionInfo info, QueryRequest req, int maxLimit) =>
        $"q|{info.Host}|{info.Port}|{info.User}|{info.Secure}|{maxLimit}|" + System.Text.Json.JsonSerializer.Serialize(req with { Fresh = null });

    /// <summary>
    /// Build the ADO.NET connection string. Contains the password, so the result is a secret:
    /// never log it or return it. TLS is selected with the HTTPS protocol (secure port 8443 —
    /// decision D10).
    /// </summary>
    internal static string BuildConnectionString(ClickHouseConnectionInfo info)
    {
        var builder = new ClickHouseConnectionStringBuilder
        {
            Host = info.Host,
            Port = (ushort)info.Port,
            Username = info.User,
            Password = info.Password,
            Protocol = info.Secure ? "https" : "http",
        };
        var connectionString = builder.ToString();
        // Database-level guards, sent with every query (`set_` keys become ClickHouse settings):
        //  readonly=2 — the server itself refuses DDL/DML, so golden rule 1 doesn't rest on our SQL
        //    builders alone (2, not 1, so the driver's own settings such as compression still apply);
        //  max_execution_time — a runaway query is stopped server-side before the HTTP timeout;
        //  cancel_http_readonly_queries_on_client_close — a superseded/aborted request kills its query.
        // A server that refuses a setting gets fewer (see NextGuards).
        return info.Guards switch
        {
            QueryGuards.Full => connectionString
                + ";set_readonly=2"
                + $";set_max_execution_time={MaxExecutionSeconds}"
                + ";set_cancel_http_readonly_queries_on_client_close=1",
            QueryGuards.NoTimeLimit => connectionString
                + ";set_readonly=2"
                + ";set_cancel_http_readonly_queries_on_client_close=1",
            _ => connectionString,
        };
    }

    /// <summary>Server-side limit for any one query, in seconds. Shorter than
    /// <see cref="HttpTimeoutSeconds"/> so ClickHouse stops the query (with a clean error) first.</summary>
    public const int MaxExecutionSeconds = 12;

    /// <summary>How long the HTTP client waits for ClickHouse before giving up.</summary>
    public const int HttpTimeoutSeconds = 15;

    /// <summary>The HTTP client gave up waiting (<see cref="HttpTimeoutSeconds"/>) — as opposed to
    /// the caller cancelling, which surfaces as a bare <see cref="OperationCanceledException"/>.</summary>
    internal static bool IsHttpTimeout(Exception ex) => ex is TaskCanceledException { InnerException: TimeoutException };

    /// <summary>
    /// The guard level to retry with after the server refused <paramref name="current"/>, or
    /// <c>null</c> when <paramref name="ex"/> isn't a settings refusal (or nothing is left to drop).
    /// Code 164 (READONLY): the account is already read-only, so <c>readonly=2</c> itself is refused —
    /// send nothing. Code 452 (SETTING_CONSTRAINT_VIOLATION): a profile constraint, almost always on
    /// <c>max_execution_time</c> — drop the time limit first, then everything.
    /// </summary>
    internal static QueryGuards? NextGuards(QueryGuards current, Exception ex) =>
        (current, ex) switch
        {
            (QueryGuards.Full, ClickHouseServerException { ErrorCode: 164 }) => QueryGuards.None,
            (QueryGuards.Full, ClickHouseServerException { ErrorCode: 452 }) => QueryGuards.NoTimeLimit,
            (QueryGuards.NoTimeLimit, ClickHouseServerException { ErrorCode: 164 or 452 }) => QueryGuards.None,
            _ => null,
        };

    /// <summary>
    /// Whether this connection bypasses TLS certificate validation. Safe by default (P8
    /// hardening / decision D11): only true when the connection is <em>both</em> secure and the
    /// user explicitly opted in to trusting an invalid/self-signed certificate. A plain (non-TLS)
    /// connection can never bypass validation, since there is no certificate to validate.
    /// </summary>
    public static bool BypassesCertificateValidation(ClickHouseConnectionInfo info)
        => info.Secure && info.AllowInvalidCertificate;

    /// <summary>
    /// The HttpClient ClickHouse.Client uses for the HTTP(S) interface. By default a secure
    /// connection validates the server certificate against the host's trust store; only when the
    /// user explicitly opted in (<see cref="BypassesCertificateValidation"/>) is the certificate
    /// accepted without validation — the escape hatch for internal servers presenting a
    /// self-signed cert (decision D11). The proper fix remains trusting the server's CA.
    /// </summary>
    private static HttpClient CreateHttpClient(ClickHouseConnectionInfo info)
    {
        // ClickHouse.Client requests compressed responses, so a hand-supplied HttpClient must
        // decompress them itself (its built-in handler does this for us otherwise).
        var handler = new HttpClientHandler { AutomaticDecompression = DecompressionMethods.All };
        if (BypassesCertificateValidation(info))
            handler.ServerCertificateCustomValidationCallback =
                HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;

        // Bound the wait so an unresponsive host fails cleanly instead of hanging.
        return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(HttpTimeoutSeconds) };
    }

    /// <summary>
    /// Validate a connection by opening it and running <c>SELECT 1</c>. If the server refuses a guard
    /// setting (code 164 or 452), the connection steps down to fewer settings (<see cref="NextGuards"/>)
    /// and is re-validated, so a locked-down account can still connect.
    /// </summary>
    /// <returns>A safe, credential-free error message (or <c>null</c> on success) and the connection
    /// info to store — carrying the guard level the server accepted.</returns>
    public async Task<(string? Error, ClickHouseConnectionInfo Info)> ValidateAsync(
        ClickHouseConnectionInfo info, CancellationToken ct)
    {
        try
        {
            while (true)
            {
                try
                {
                    return (await SelectOneAsync(info, ct), info);
                }
                catch (Exception ex) when (NextGuards(info.Guards, ex) is { } next)
                {
                    _logger.LogInformation("ClickHouse refused guard settings {Guards}; retrying with {Next}", info.Guards, next);
                    info = info with { Guards = next };
                }
            }
        }
        catch (OperationCanceledException ex) when (!IsHttpTimeout(ex))
        {
            throw;
        }
        catch (Exception ex)
        {
            // Log the failure TYPE only. Exception messages/URIs can carry host or credential
            // material, so neither the message nor the connection string is ever logged.
            _logger.LogWarning("ClickHouse connection validation failed: {ErrorType}", ex.GetType().Name);
            return ("Could not connect to ClickHouse. Check the host, port, user, password, and TLS (secure) setting.", info);
        }
    }

    private static async Task<string?> SelectOneAsync(ClickHouseConnectionInfo info, CancellationToken ct)
    {
        using var httpClient = CreateHttpClient(info);
        await using var conn = new ClickHouseConnection(BuildConnectionString(info), httpClient);
        await conn.OpenAsync(ct);

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT 1";
        var scalar = await cmd.ExecuteScalarAsync(ct);

        return Convert.ToInt64(scalar) == 1
            ? null
            : "Connected, but the server returned an unexpected response.";
    }

    /// <summary>List databases: <c>SHOW DATABASES</c>.</summary>
    public Task<IReadOnlyList<string>> ListDatabasesAsync(ClickHouseConnectionInfo info, CancellationToken ct)
        => QueryStringColumnAsync(info, "SHOW DATABASES", ct);

    /// <summary>
    /// List tables in a database: <c>SHOW TABLES FROM `db`</c>. The database name is interpolated
    /// (identifiers can't be bound as parameters), so it is first confirmed to exist in the live
    /// catalog and then backtick-quoted (CLAUDE.md golden rule 2 / decision D6).
    /// </summary>
    /// <exception cref="UnknownIdentifierException">No such database for this connection.</exception>
    public async Task<IReadOnlyList<string>> ListTablesAsync(
        ClickHouseConnectionInfo info, string database, CancellationToken ct)
    {
        var databases = await ListDatabasesAsync(info, ct);
        if (!databases.Contains(database, StringComparer.Ordinal))
            throw new UnknownIdentifierException("Unknown database.");

        var sql = $"SHOW TABLES FROM {Identifier.Quote(database)}";
        return await QueryStringColumnAsync(info, sql, ct);
    }

    /// <summary>
    /// Column names + types for a table: <c>DESCRIBE TABLE `db`.`table`</c>, each type reduced to a
    /// display category. Both identifiers are catalog-validated and quoted (rule 2 / D6).
    /// </summary>
    /// <exception cref="UnknownIdentifierException">No such database or table for this connection.</exception>
    public async Task<IReadOnlyList<ColumnInfo>> DescribeColumnsAsync(
        ClickHouseConnectionInfo info, string database, string table, CancellationToken ct)
    {
        await EnsureTableExistsAsync(info, database, table, ct);
        var sql = $"DESCRIBE TABLE {Identifier.QualifiedName(database, table)}";

        using var httpClient = CreateHttpClient(info);
        await using var conn = new ClickHouseConnection(BuildConnectionString(info), httpClient);
        await conn.OpenAsync(ct);

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        var columns = new List<ColumnInfo>();
        while (await reader.ReadAsync(ct))
        {
            var name = reader.GetValue(0)?.ToString() ?? string.Empty; // DESCRIBE col 0 = name
            var type = reader.GetValue(1)?.ToString() ?? string.Empty; // col 1 = type
            columns.Add(new ColumnInfo(name, type, ClickHouseType.Categorize(type)));
        }
        return columns;
    }

    /// <summary>
    /// Distinct values of one column, for a filter dropdown (P14): <c>SELECT DISTINCT col FROM db.table
    /// ORDER BY col LIMIT n</c>. The column is catalog-validated and quoted; the row count is clamped
    /// (<see cref="ClampDistinct"/>) so a high-cardinality column can't flood the client. Read-only.
    /// </summary>
    /// <exception cref="UnknownIdentifierException">No such database/table/column for this connection.</exception>
    public async Task<IReadOnlyList<string?>> DistinctValuesAsync(
        ClickHouseConnectionInfo info, string database, string table, string column, int? limit, CancellationToken ct)
    {
        var columns = await DescribeColumnsAsync(info, database, table, ct); // validates db + table
        if (!columns.Any(c => string.Equals(c.Name, column, StringComparison.Ordinal)))
            throw new UnknownIdentifierException("Unknown column.");

        var n = ClampDistinct(limit);
        var sql = $"SELECT DISTINCT {Identifier.Quote(column)} AS v FROM {Identifier.QualifiedName(database, table)} " +
                  $"WHERE v IS NOT NULL ORDER BY v LIMIT {n}";

        using var httpClient = CreateHttpClient(info);
        await using var conn = new ClickHouseConnection(BuildConnectionString(info), httpClient);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        var values = new List<string?>();
        while (await reader.ReadAsync(ct))
            values.Add(reader.IsDBNull(0) ? null : FormatKey(reader.GetValue(0)));
        return values;
    }

    /// <summary>The result column of a plain measure (lower-case aggregate name): <c>count</c>, <c>sum amount</c>,
    /// <c>distinct region</c>, <c>non-null status</c> — the labels the client shows, so JSON, CSV and compare agree.</summary>
    internal static string MeasureName(string agg, string column) => agg switch
    {
        "count" => "count",
        "countdistinct" => $"distinct {column}",
        "countnonnull" => $"non-null {column}",
        _ => $"{agg} {column}",
    };

    /// <summary>
    /// The one place an aggregate call is written. <paramref name="agg"/> is a lowercase whitelisted name
    /// (<c>sum|avg|min|max|count|countnonnull|countdistinct</c>); <paramref name="expr"/> is already validated
    /// and quoted SQL. <c>count</c> counts all rows (no argument); <c>countnonnull</c> counts non-NULL values.
    /// When <paramref name="sampled"/> (P33), counts and sums are scaled back by <c>t0._sample_factor</c>;
    /// <paramref name="approximate"/> estimates distinct counts with <c>uniq</c>.
    /// </summary>
    internal static string AggregateSql(string agg, string expr, bool sampled, bool approximate) => agg switch
    {
        "sum" => sampled ? $"sum({expr} * t0._sample_factor)" : $"sum({expr})",
        "count" => sampled ? "sum(t0._sample_factor)" : "count()",
        "countnonnull" => sampled ? $"sum(if(isNotNull({expr}), t0._sample_factor, 0))" : $"count({expr})",
        "avg" or "min" or "max" => $"{agg}({expr})",
        "countdistinct" => approximate ? $"uniq({expr})" : $"uniqExact({expr})",
        _ => throw new InvalidOperationException($"Unknown aggregate '{agg}'."),
    };

    // "countdistinct" counts unique values — mapped to ClickHouse uniqExact() in the SELECT builders.
    // "countnonnull" (E11) counts non-NULL values of the column; "count" counts rows.
    internal static readonly HashSet<string> Aggregations =
        new(StringComparer.OrdinalIgnoreCase) { "count", "sum", "avg", "min", "max", "countdistinct", "countnonnull" };

    /// <summary>A plain Top-N rank aggregate over an already-quoted column (lowercase whitelisted <paramref name="agg"/>,
    /// not <c>count</c>). Exact and unscaled: only the order matters.</summary>
    internal static string PlainRankSql(string agg, string expr) => agg switch
    {
        "countdistinct" => $"uniqExact({expr})",
        "countnonnull" => $"count({expr})",
        _ => $"{agg}({expr})",
    };

    /// <summary>The parameters whose <c>{name:</c> placeholder appears in <paramref name="sql"/> — for a statement
    /// that reuses only part of the request (the auto date-grain probe), so it never carries parameters it lacks.</summary>
    internal static List<(string Name, string Type, object Value)> ParametersUsedBy(
        string sql, List<(string Name, string Type, object Value)> parameters) =>
        parameters.Where(p => sql.Contains("{" + p.Name + ":", StringComparison.Ordinal)).ToList();

    /// <summary>P30 top-N condition: <paramref name="expr"/>'s members ranked by <paramref name="rank"/> under the other filters.</summary>
    private static string TopCondition(string expr, string from, string others, string rank, QueryFilter f)
    {
        var n = int.Parse(f.Value!, CultureInfo.InvariantCulture);
        return $"{expr} IN (SELECT {expr}{from}{others} GROUP BY {expr} ORDER BY {rank} {(f.Bottom == true ? "ASC" : "DESC")} LIMIT {n})";
    }

    /// <summary>The "Other" statement: group count + each measure (the same SQL as the main query, so the same
    /// parameters) over everything past the shown groups. <paramref name="limit"/> is the probe limit. The group
    /// count adds one for a NULL group (uniqExact skips NULL — e.g. a calculation's <c>nullIf</c> division key).</summary>
    internal static string OtherSql(string dimExpr, IReadOnlyList<string> measExprs, string from, string where,
        string ordered, int limit, string extraSettings)
    {
        var shown = $"SELECT k0 FROM ({ordered} LIMIT {limit - 1})";
        return $"SELECT uniqExact({dimExpr}) + max(isNull({dimExpr})) AS n, "
            + string.Join(", ", measExprs.Select((m, i) => $"{m} AS v{i}")) + from
            + (where.Length > 0 ? where + " AND " : " WHERE ") + $"{dimExpr} NOT IN ({shown})"
            + " SETTINGS transform_null_in = 1" + extraSettings;
    }

    // A sort target must be one of the SELECT aliases we generate: k{n} (dimension, n < dimCount) or
    // v{n} (measure, n < measureCount). Anything else is ignored (never interpolated blindly).
    internal static bool IsValidSortAlias(string? alias, int dimCount, int measureCount)
    {
        if (string.IsNullOrEmpty(alias) || (alias[0] != 'k' && alias[0] != 'v')) return false;
        if (!int.TryParse(alias.AsSpan(1), out var idx) || idx < 0) return false;
        return alias[0] == 'k' ? idx < dimCount : idx < measureCount;
    }
    private static readonly Dictionary<string, string> Operators = new()
    {
        ["="] = "=", ["!="] = "!=", [">"] = ">", [">="] = ">=", ["<"] = "<", ["<="] = "<=",
    };

    /// <summary>How many histogram bins to allow — clamped so a bucketing query can never explode
    /// into an unbounded number of groups (P12). Default 20 when unset.</summary>
    internal static int ClampBuckets(int? buckets) => Math.Clamp(buckets ?? 20, 1, ApiLimits.MaxBuckets);

    /// <summary>How many distinct values a filter dropdown may pull (P14) — bounded so it can never
    /// stream a high-cardinality column into the browser. Default 200 when unset.</summary>
    internal static int ClampDistinct(int? limit) => Math.Clamp(limit ?? 200, 1, ApiLimits.MaxDistinct);

    /// <summary>The SQL <c>LIMIT</c> for a bounded grouped query: the requested limit (default 50,
    /// clamped 1..ApiLimits.MaxRowLimit) plus one probe row, so the server can tell whether more rows exist.</summary>
    internal static int ProbeLimit(int? requested, int max = ApiLimits.MaxRowLimit) => Math.Clamp(requested ?? 50, 1, max) + 1;

    /// <summary>The most buckets "auto" date grouping aims for (and the distinct-value count below which
    /// it leaves the dimension exact).</summary>
    internal const int AutoBucketTarget = 400;

    /// <summary>The whitelisted truncation for a calendar grain over an already-quoted expression.</summary>
    /// <summary>P26: the whitelisted expression for a dimension's date part, or null for auto / exact.
    /// Truncations reuse <see cref="BucketExpression"/>; discrete parts return a number.</summary>
    internal static string? DatePartExpression(string? part, string expr, bool dateOnly) => part switch
    {
        null or "auto" or "exact" => null,
        "hour" when dateOnly => BucketExpression("day", expr),
        "year" or "quarter" or "month" or "week" or "day" or "hour" => BucketExpression(part, expr),
        "quarterOfYear" => $"toQuarter({expr})",
        "monthOfYear" => $"toMonth({expr})",
        "dayOfWeek" => $"toDayOfWeek({expr})",
        "hourOfDay" => dateOnly ? throw new RequestValidationException("Hour of day needs a date-time column.", "datePart") : $"toHour({expr})",
        _ => throw new RequestValidationException("Unknown date part.", "datePart"),
    };

    internal static string BucketExpression(string grain, string expr) => grain switch
    {
        "hour" => $"toStartOfHour({expr})",
        "day" => $"toDate({expr})",
        "week" => $"toMonday({expr})",
        "month" => $"toStartOfMonth({expr})",
        "quarter" => $"toStartOfQuarter({expr})",
        "year" => $"toStartOfYear({expr})",
        _ => throw new RequestValidationException("Unknown date grouping.", "dateBucket"),
    };

    /// <summary>The finest grain that keeps a span within <see cref="AutoBucketTarget"/> buckets, or null
    /// (stay exact) when the values are already few.</summary>
    internal static string? PickGrain(long distinct, DateTime min, DateTime max, bool dateOnly)
    {
        if (distinct <= AutoBucketTarget) return null;
        var span = max - min;
        if (!dateOnly && span.TotalHours <= AutoBucketTarget) return "hour";
        if (span.TotalDays <= AutoBucketTarget) return "day";
        if (span.TotalDays / 7 <= AutoBucketTarget) return "week";
        if (span.TotalDays / 30.44 <= AutoBucketTarget) return "month";
        if (span.TotalDays / 91.31 <= AutoBucketTarget) return "quarter";
        return "year";
    }

    /// <summary>Drop the probe row if the result reached it. Returns whether the result was truncated.</summary>
    internal static bool TrimProbeRow<T>(List<T> rows, int probeLimit)
    {
        if (rows.Count < probeLimit) return false;
        rows.RemoveRange(probeLimit - 1, rows.Count - (probeLimit - 1));
        return true;
    }


    /// <summary>
    /// Build one filter condition for an already-qualified, quoted <paramref name="expr"/>, appending
    /// bound parameters (P14). Pure + testable. Handles the scalar operators plus <c>in</c> (binds an
    /// <c>Array(String|Float64)</c>) and <c>between</c> (binds two bounds). Values are always bound as
    /// parameters — never interpolated. Values are coerced to the column's category; a value that
    /// doesn't fit, an empty <c>in</c>, or a half/inverted <c>between</c> throws <see cref="RequestValidationException"/>.
    /// </summary>
    internal static string BuildCondition(
        string? op, string paramBase, string expr, string category, string column, string field,
        string? value, IReadOnlyList<string>? values, List<(string Name, string Type, object Value)> parameters,
        bool dateOnly = false)
    {
        switch ((op ?? string.Empty).ToLowerInvariant())
        {
            // P30 text match: case-insensitive, the text bound as a String — no LIKE pattern to escape.
            case "contains" or "startswith" or "endswith":
            {
                if (category != ClickHouseType.Text)
                    throw new RequestValidationException($"Text matching needs a text column — {column} isn't one.", field);
                parameters.Add((paramBase, "String", value ?? ""));
                return (op ?? "").ToLowerInvariant() switch
                {
                    "contains" => $"positionCaseInsensitiveUTF8({expr}, {{{paramBase}:String}}) > 0",
                    "startswith" => $"startsWith(lowerUTF8({expr}), lowerUTF8({{{paramBase}:String}}))",
                    _ => $"endsWith(lowerUTF8({expr}), lowerUTF8({{{paramBase}:String}}))",
                };
            }
            case "top":
                throw new RequestValidationException("Top-N filters apply to the worksheet query only.", field);
            case "in" or "notin":
            {
                var negate = string.Equals(op, "notin", StringComparison.OrdinalIgnoreCase);
                var typed = (values ?? []).Select(v => FilterValues.Coerce(category, column, v ?? "", field, dateOnly)).ToList();
                if (typed.Count == 0) throw new RequestValidationException("Pick at least one value.", field);
                var type = typed[0].Type;
                object arr = type switch
                {
                    "Float64" => typed.Select(t => (double)t.Value).ToArray(),
                    "UInt8" => typed.Select(t => (byte)t.Value).ToArray(),
                    _ => typed.Select(t => (string)t.Value).ToArray(),
                };
                parameters.Add((paramBase, $"Array({type})", arr));
                // Exclude keeps NULL rows: a bare NOT IN is NULL (so dropped) for them in SQL three-valued logic.
                return negate ? $"({expr} NOT IN {{{paramBase}:Array({type})}} OR isNull({expr}))" : $"{expr} IN {{{paramBase}:Array({type})}}";
            }
            case "between":
            {
                if (values is not { Count: 2 }) throw new RequestValidationException("A range filter needs both From and To.", field);
                var lo = FilterValues.Coerce(category, column, values[0] ?? "", field, dateOnly);
                var hi = FilterValues.Coerce(category, column, values[1] ?? "", field, dateOnly);
                if (FilterValues.Compare(category, lo.Value, hi.Value) > 0)
                    throw new RequestValidationException($"From must be less than or equal to To for column {column}.", field);
                var (na, nb) = ($"{paramBase}a", $"{paramBase}b");
                parameters.Add((na, lo.Type, lo.Value));
                parameters.Add((nb, hi.Type, hi.Value));
                return $"{expr} >= {{{na}:{lo.Type}}} AND {expr} <= {{{nb}:{hi.Type}}}";
            }
            default:
            {
                if (!Operators.TryGetValue(op ?? string.Empty, out var sqlOp)) throw new UnknownIdentifierException("Unknown operator.");
                var (type, typedValue) = FilterValues.Coerce(category, column, value ?? "", field, dateOnly);
                parameters.Add((paramBase, type, typedValue));
                return $"{expr} {sqlOp} {{{paramBase}:{type}}}";
            }
        }
    }

    /// <summary>
    /// Build a bound-parameter WHERE clause for a <em>single</em> table (no join alias) from a filter
    /// list, appending typed parameters to <paramref name="parameters"/>. Pure + testable: each column
    /// is looked up in <paramref name="byName"/> (unknown → 400), each operator whitelisted, and each
    /// value bound (numeric columns as Float64 when the value parses, else String) — never interpolated.
    /// Returns the clause **including** a leading <c>" WHERE "</c>, or an empty string when there are no
    /// conditions. The filter count is validated upstream by <see cref="RequestRules"/>.
    /// </summary>
    internal static string BuildSingleTableFilters(
        IReadOnlyList<StatFilter> filters,
        IReadOnlyDictionary<string, ColumnInfo> byName,
        List<(string Name, string Type, object Value)> parameters)
    {
        var conditions = new List<string>();
        for (var i = 0; i < filters.Count; i++)
        {
            var f = filters[i];
            if (string.IsNullOrEmpty(f.Column) || !byName.TryGetValue(f.Column, out var ci)) throw new UnknownIdentifierException("Unknown column.");
            conditions.Add(BuildCondition(f.Op, $"p{i}", Identifier.Quote(f.Column), ci.Category, f.Column, $"filters[{i}]", f.Value, f.Values, parameters, ClickHouseType.IsDateOnly(ci.Type)));
        }
        return conditions.Count > 0 ? " WHERE " + string.Join(" AND ", conditions) : string.Empty;
    }

    /// <summary>One more than the row limit (default 100): the probe row that tells the client more exist.</summary>
    internal static int RowsProbeLimit(int? requested) => (requested ?? ApiLimits.DefaultRowsLimit) + 1;

    /// <summary>The columns a row read returns: the requested ones (each must be in the catalog; order kept), else the
    /// table's first <see cref="ApiLimits.MaxRowsColumns"/>. The flag says the default set was cut.</summary>
    internal static (IReadOnlyList<ColumnInfo> Columns, bool Truncated) PickRowColumns(IReadOnlyList<ColumnInfo> all, string[]? requested)
    {
        if (requested is { Length: > 0 })
        {
            var byName = all.ToDictionary(c => c.Name, c => c, StringComparer.Ordinal);
            return (requested.Select(n => byName.TryGetValue(n, out var c) ? c : throw new UnknownIdentifierException("Unknown column.")).ToList(), false);
        }
        return (all.Take(ApiLimits.MaxRowsColumns).ToList(), all.Count > ApiLimits.MaxRowsColumns);
    }

    /// <summary>The row-read statement. Every name is quoted; <paramref name="where"/> is empty or " WHERE …" with bound
    /// parameters; there is no ORDER BY (the first rows in storage order) and a hard LIMIT.</summary>
    internal static string BuildRowsSql(string database, string table, IReadOnlyList<string> columns, string where, int probeLimit)
        => $"SELECT {string.Join(", ", columns.Select(RowSelectExpr))} FROM {Identifier.QualifiedName(database, table)}{where} LIMIT {probeLimit}";

    /// <summary>One selected column, cut INSIDE ClickHouse so a huge value never leaves it: NULL stays NULL, anything
    /// else is its text (<c>toString</c>: arrays, tuples, maps, dates render as ClickHouse prints them) cut to
    /// <see cref="ApiLimits.MaxCellLength"/> + 1 characters (the extra one tells <see cref="RowCell"/> it was cut).</summary>
    internal static string RowSelectExpr(string column)
    {
        var q = Identifier.Quote(column);
        return $"if(isNull({q}), NULL, left(toString({q}), {ApiLimits.MaxCellLength + 1}))";
    }

    /// <summary>A cell as JSON: null for SQL NULL, else display text cut at <see cref="ApiLimits.MaxCellLength"/> characters.</summary>
    internal static string? RowCell(object? raw)
    {
        if (raw is null or DBNull) return null;
        var text = FormatCell(raw);
        return text.Length > ApiLimits.MaxCellLength ? string.Concat(text.AsSpan(0, ApiLimits.MaxCellLength), "…") : text;
    }

    /// <summary>
    /// The first rows of one table (raw-record preview / "view data"): <c>SELECT cols FROM db.table [WHERE …] LIMIT n+1</c>.
    /// Database, table, columns and filter columns are catalog-validated and quoted; filter values are bound with the
    /// worksheet's typed rules; the limit is validated upstream and a probe row flags truncation. Read-only.
    /// </summary>
    /// <exception cref="UnknownIdentifierException">Unknown database, table, column or filter column.</exception>
    public async Task<RowsResult> RowsAsync(ClickHouseConnectionInfo info, RowsRequest req, CancellationToken ct)
    {
        var all = await DescribeColumnsAsync(info, req.Db, req.Table, ct); // validates db + table
        var (columns, colsTruncated) = PickRowColumns(all, req.Columns);
        var byName = all.ToDictionary(c => c.Name, c => c, StringComparer.Ordinal);
        var parameters = new List<(string Name, string Type, object Value)>();
        var where = BuildSingleTableFilters(req.Filters ?? [], byName, parameters);
        var limit = req.Limit ?? ApiLimits.DefaultRowsLimit;
        RequestRules.ValidateRowCells(limit, columns.Count, "limit");
        var probe = RowsProbeLimit(req.Limit);
        var sql = BuildRowsSql(req.Db, req.Table, columns.Select(c => c.Name).ToList(), where, probe);

        using var httpClient = CreateHttpClient(info);
        await using var conn = new ClickHouseConnection(BuildConnectionString(info), httpClient);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, type, value) in parameters) cmd.AddParameter(name, type, value);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        var rows = new List<IReadOnlyList<string?>>();
        while (await reader.ReadAsync(ct))
        {
            var row = new string?[columns.Count];
            for (var i = 0; i < row.Length; i++) row[i] = reader.IsDBNull(i) ? null : RowCell(reader.GetValue(i));
            rows.Add(row);
        }
        var truncated = TrimProbeRow(rows, probe);
        return new RowsResult(columns.Select(c => new RowColumn(c.Name, c.Type)).ToList(), rows, truncated, limit, colsTruncated);
    }

    /// <summary>
    /// A histogram (P12): bucket a single numeric column into equal-width bins over its live [min,max]
    /// and count rows per bin — <c>SELECT floor((col-lo)/w) AS bin, count() … GROUP BY bin</c>, with
    /// <c>lo</c>/<c>hi</c>/width computed from scalar subqueries so it is a single bounded statement.
    /// The column is catalog-validated, quoted, and must be numeric; the bucket count is clamped;
    /// filter values are bound (and reused by name across the subqueries).
    /// </summary>
    /// <exception cref="UnknownIdentifierException">Unknown/non-numeric column, or unknown filter column/op.</exception>
    public async Task<HistogramResult> HistogramAsync(
        ClickHouseConnectionInfo info, string database, string table, HistogramRequest req, CancellationToken ct)
    {
        var columns = await DescribeColumnsAsync(info, database, table, ct); // validates db + table
        var byName = columns.ToDictionary(c => c.Name, c => c, StringComparer.Ordinal);
        if (string.IsNullOrEmpty(req.Column) || !byName.TryGetValue(req.Column, out var col))
            throw new UnknownIdentifierException("Unknown column.");
        if (col.Category != ClickHouseType.Numeric)
            throw new UnknownIdentifierException("Histogram needs a numeric column.");

        var bins = ClampBuckets(req.Buckets);
        var qname = Identifier.Quote(req.Column);
        var qualified = Identifier.QualifiedName(database, table);

        var parameters = new List<(string Name, string Type, object Value)>();
        var where = BuildSingleTableFilters(req.Filters ?? [], byName, parameters);

        // lo/hi from the same filtered set; width guards against a zero span (all-equal column).
        // `bin` is clamped to the last bucket so the maximum value lands inside, not in an extra bin.
        var sql = BuildHistogramSql(qname, qualified, where, bins);

        using var httpClient = CreateHttpClient(info);
        await using var conn = new ClickHouseConnection(BuildConnectionString(info), httpClient);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, type, value) in parameters) cmd.AddParameter(name, type, value);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        var doub = (int i) => reader.IsDBNull(i) ? double.NaN : Convert.ToDouble(reader.GetValue(i), CultureInfo.InvariantCulture);
        var binsOut = new List<HistogramBin>();
        while (await reader.ReadAsync(ct))
        {
            double x0 = doub(1), x1 = doub(2);
            if (!double.IsFinite(x0) || !double.IsFinite(x1)) continue; // defensive: JSON can't carry NaN/∞
            binsOut.Add(new HistogramBin(x0, x1,
                reader.IsDBNull(3) ? 0L : Convert.ToInt64(reader.GetValue(3), CultureInfo.InvariantCulture)));
        }
        return new HistogramResult(binsOut);
    }

    /// <summary>The bucketing query. NULLs are excluded (a NULL value has no bin); <paramref name="where"/> is
    /// empty or " WHERE …" from the user filters, which the guard is combined with.</summary>
    internal static string BuildHistogramSql(string qname, string qualified, string where, int bins)
    {
        var w = where.Length == 0 ? $" WHERE {qname} IS NOT NULL" : $"{where} AND {qname} IS NOT NULL";
        return
            $"WITH (SELECT min({qname}) FROM {qualified}{w}) AS lo, " +
            $"(SELECT max({qname}) FROM {qualified}{w}) AS hi, " +
            $"if(hi > lo, (hi - lo) / {bins}, 1) AS width " +
            $"SELECT least(toUInt32(floor(({qname} - lo) / width)), {bins - 1}) AS bin, " +
            $"lo + bin * width AS x0, lo + (bin + 1) * width AS x1, count() AS c " +
            $"FROM {qualified}{w} GROUP BY bin, x0, x1 ORDER BY bin";
    }

    /// <summary>
    /// A box plot (P12): the five-number summary (min, Q1, median, Q3, max) of a numeric measure,
    /// optionally grouped by a dimension — <c>SELECT dim, min(m), quantile(0.25)(m), … GROUP BY dim</c>.
    /// The measure must be numeric; identifiers are validated + quoted; the group count is bounded.
    /// </summary>
    /// <exception cref="UnknownIdentifierException">Unknown/non-numeric measure, unknown dimension, or unknown filter column/op.</exception>
    public async Task<BoxPlotResult> BoxPlotAsync(
        ClickHouseConnectionInfo info, string database, string table, BoxPlotRequest req, CancellationToken ct)
    {
        var columns = await DescribeColumnsAsync(info, database, table, ct); // validates db + table
        var byName = columns.ToDictionary(c => c.Name, c => c, StringComparer.Ordinal);
        if (string.IsNullOrEmpty(req.Measure) || !byName.TryGetValue(req.Measure, out var measure))
            throw new UnknownIdentifierException("Unknown column.");
        if (measure.Category != ClickHouseType.Numeric)
            throw new UnknownIdentifierException("Box plot needs a numeric measure.");

        var hasDim = !string.IsNullOrEmpty(req.Dimension);
        if (hasDim && !byName.ContainsKey(req.Dimension!)) throw new UnknownIdentifierException("Unknown column.");

        var qm = Identifier.Quote(req.Measure);
        var sql = new StringBuilder("SELECT ");
        if (hasDim) sql.Append($"{Identifier.Quote(req.Dimension!)} AS label, ");
        sql.Append($"min({qm}) AS lo, quantile(0.25)({qm}) AS q1, quantile(0.5)({qm}) AS med, ")
           .Append($"quantile(0.75)({qm}) AS q3, max({qm}) AS hi FROM ")
           .Append(Identifier.QualifiedName(database, table));

        var parameters = new List<(string Name, string Type, object Value)>();
        sql.Append(BuildSingleTableFilters(req.Filters ?? [], byName, parameters));
        if (hasDim) sql.Append(" GROUP BY label ORDER BY label ASC");
        var limit = ProbeLimit(req.Limit);
        sql.Append(" LIMIT ").Append(limit);

        using var httpClient = CreateHttpClient(info);
        await using var conn = new ClickHouseConnection(BuildConnectionString(info), httpClient);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql.ToString();
        foreach (var (name, type, value) in parameters) cmd.AddParameter(name, type, value);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        var b = hasDim ? 1 : 0; // column offset for the stats when a label column is present
        var doub = (int i) => reader.IsDBNull(i) ? double.NaN : Convert.ToDouble(reader.GetValue(i), CultureInfo.InvariantCulture);
        var groups = new List<BoxPlotGroup?>(); // null = a no-row group (nan stats); dropped after the truncation probe
        while (await reader.ReadAsync(ct))
        {
            var label = hasDim ? (reader.IsDBNull(0) ? null : FormatKey(reader.GetValue(0))) : null;
            double lo = doub(b), q1 = doub(b + 1), med = doub(b + 2), q3 = doub(b + 3), hi = doub(b + 4);
            groups.Add(new[] { lo, q1, med, q3, hi }.All(double.IsFinite) ? new BoxPlotGroup(label, lo, q1, med, q3, hi) : null);
        }
        var truncated = TrimProbeRow(groups, limit);
        return new BoxPlotResult(groups.OfType<BoxPlotGroup>().ToList(), truncated);
    }

    /// <summary>
    /// Run a worksheet query that may join several related tables (the Tableau-style shelves). The
    /// FROM chains the base table + each join edge (INNER JOIN on the relationship's keys, aliased
    /// t0, t1, …). Dimensions arrive split by shelf — <see cref="QueryRequest.RowDimensions"/> then
    /// <see cref="QueryRequest.ColumnDimensions"/> — and are grouped in that order, so each row's keys
    /// are <c>[rowDim…, colDim…]</c> (selected k0, k1, …); measures are aggregated as v0, v1, …. When
    /// no measures are given an implicit <c>count()</c> is added. When there are column dimensions the
    /// result is ordered by the dimension keys (stable crosstab layout); otherwise by the first
    /// measure (descending), preserving the chart/flat-table behaviour. All identifiers are catalog-
    /// validated and quoted, aggregations/operators whitelisted, and filter values bound.
    /// </summary>
    /// <exception cref="UnknownIdentifierException">An identifier/agg/op is unknown or references a table not in the query.</exception>
    public async Task<QueryResult> QueryAsync(ClickHouseConnectionInfo info, QueryRequest req, CancellationToken ct, int maxLimit = ApiLimits.MaxRowLimit)
    {
        // P33 result cache: the same request on the same server + user within a minute is answered from
        // memory (logged); Fresh (Refresh) skips the lookup and replaces the entry.
        var key = _cache is null ? null : CacheKey(info, req, maxLimit);
        if (key is not null && req.Fresh != true && _cache!.TryGetValue(key, out QueryResult? hit) && hit is not null)
        {
            _logger.LogInformation("Worksheet query served from the result cache.");
            return hit with { Cached = true };
        }
        QueryResult result;
        try { result = await QueryCoreAsync(info, req, ct, maxLimit, sample: req.Approximate == true); }
        catch (ClickHouseServerException ex) when (req.Approximate == true && ex.ErrorCode != 159)
        {
            // A sampled query the server refuses (e.g. SAMPLE syntax / key) runs once more unsampled.
            _logger.LogWarning("Sampled query failed ({Code}); running it without the sample.", ex.ErrorCode);
            result = await QueryCoreAsync(info, req, ct, maxLimit, sample: false);
        }
        if (key is not null)
            _cache!.Set(key, result, new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = CacheTtl, Size = 1 + result.Rows.Count / 500 });
        return result;
    }

    private async Task<QueryResult> QueryCoreAsync(ClickHouseConnectionInfo info, QueryRequest req, CancellationToken ct, int maxLimit, bool sample)
    {
        var aliases = new Dictionary<string, string>();                 // "db\0table" -> alias
        var categories = new Dictionary<string, Dictionary<string, string>>(); // "db\0table" -> col -> category
        var rawTypes = new Dictionary<string, Dictionary<string, string>>();   // same shape, raw ClickHouse type
        static string Key(string db, string table) => $"{db}\0{table}";

        async Task<Dictionary<string, string>> ColumnsOf(string db, string table)
        {
            var key = Key(db, table);
            if (!categories.TryGetValue(key, out var map))
            {
                var cols = await DescribeColumnsAsync(info, db, table, ct); // validates db + table
                map = cols.ToDictionary(c => c.Name, c => c.Category, StringComparer.Ordinal);
                categories[key] = map;
                rawTypes[key] = cols.ToDictionary(c => c.Name, c => c.Type, StringComparer.Ordinal);
            }
            return map;
        }
        async Task<string> QualifyAsync(string db, string table, string column)
        {
            var cols = await ColumnsOf(db, table);
            if (!cols.ContainsKey(column)) throw new UnknownIdentifierException("Unknown column.");
            if (!aliases.TryGetValue(Key(db, table), out var alias))
                throw new UnknownIdentifierException("Field references a table not in the query.");
            return $"{alias}.{Identifier.Quote(column)}";
        }

        // T02-34: a cast column's expression and the category/date-only it then has (the column's own with no cast).
        async Task<string> CastedAsync(string db, string table, string column, string? cast, string field)
        {
            var expr = await QualifyAsync(db, table, column);
            return TypeCast.Apply(cast, expr, categories[Key(db, table)][column], column, field);
        }
        string CategoryOfRef(string db, string table, string column, string? cast) =>
            TypeCast.EffectiveCategory(categories[Key(db, table)][column], cast);
        bool DateOnlyOfRef(string db, string table, string column, string? cast) =>
            TypeCast.DateOnly(cast, ClickHouseType.IsDateOnly(rawTypes[Key(db, table)][column]));

        // Base table = t0.
        await ColumnsOf(req.From.Db, req.From.Table);
        aliases[Key(req.From.Db, req.From.Table)] = "t0";
        var from = new StringBuilder(" FROM ")
            .Append(Identifier.QualifiedName(req.From.Db, req.From.Table)).Append(" AS t0");
        // P33: in approximate mode a base table with a sampling key is read as a 10% sample; counts and sums
        // are scaled back by its _sample_factor below.
        var sampled = sample && await HasSamplingKeyAsync(info, req.From.Db, req.From.Table, ct);
        if (sampled) from.Append(" SAMPLE ").Append(SampleFraction.ToString(CultureInfo.InvariantCulture));

        var next = 1;
        var anyLeft = false; // P31
        foreach (var j in req.Joins ?? [])
        {
            if (!aliases.ContainsKey(Key(j.Left.Db, j.Left.Table)))
                throw new UnknownIdentifierException("Join references a table not yet in the query.");
            var leftExpr = await QualifyAsync(j.Left.Db, j.Left.Table, j.Left.Column);

            var rightKey = Key(j.Right.Db, j.Right.Table);
            await ColumnsOf(j.Right.Db, j.Right.Table);
            var rightCols = categories[rightKey];
            if (!rightCols.ContainsKey(j.Right.Column)) throw new UnknownIdentifierException("Unknown column.");
            if (!aliases.TryGetValue(rightKey, out var rightAlias))
            {
                rightAlias = $"t{next++}";
                aliases[rightKey] = rightAlias;
                if (j.Type == "left") anyLeft = true;
                from.Append(j.Type == "left" ? " LEFT JOIN " : " INNER JOIN ").Append(Identifier.QualifiedName(j.Right.Db, j.Right.Table))
                    .Append(" AS ").Append(rightAlias)
                    .Append(" ON ").Append(leftExpr).Append(" = ")
                    .Append(rightAlias).Append('.').Append(Identifier.Quote(j.Right.Column));
            }
        }

        // Dimensions → group-by columns, selected k0, k1, …, ordered row dimensions first (left stub
        // of the crosstab) then column dimensions (top header). Each row's keys follow this order.
        var dimExprs = new List<string>();
        var rowDimNames = new List<string>();
        var colDimNames = new List<string>();
        var dimRefs = new List<ColumnRef>();
        // Every bound value of the request — filter values and calculation literals — goes in this one list, which every
        // statement below (page, total, Other) is sent with; each calculation is compiled ONCE with its own prefix c{n}.
        var parameters = new List<(string Name, string Type, object Value)>();
        var approximate = req.Approximate == true;
        var calcCount = 0;
        async Task<CompiledCalc> CompileCalcAsync(ExprNode calc, string field)
        {
            // Each field goes through QualifyAsync (catalog check + quote; a table not in the query is the usual error).
            // A column the catalog doesn't know is left out, so the validator names it with its path.
            var refs = await CalcSql.ResolveCalcRefsAsync(CalcSql.CalcFields(calc), (db, table) => aliases.ContainsKey(Key(db, table)), ColumnsOf, QualifyAsync);
            return CalcSql.CompileCalc(calc, field, refs, parameters, $"c{calcCount++}", sampled, approximate);
        }
        var rowIndex = 0;
        foreach (var d in req.RowDimensions ?? [])
        {
            var field = $"rowDimensions[{rowIndex++}]";
            dimExprs.Add(d.Calc is { } calc ? CalcSql.CalcDimensionSql(await CompileCalcAsync(calc, field), field) : await CastedAsync(d.Db, d.Table, d.Column, d.Cast, field));
            rowDimNames.Add(d.Calc is null ? $"{d.Table}.{d.Column}" : CalcSql.CalcLabel(d.Column));
            dimRefs.Add(d);
        }
        var colIndex = 0;
        foreach (var d in req.ColumnDimensions ?? [])
        {
            var field = $"columnDimensions[{colIndex++}]";
            dimExprs.Add(d.Calc is { } calc ? CalcSql.CalcDimensionSql(await CompileCalcAsync(calc, field), field) : await CastedAsync(d.Db, d.Table, d.Column, d.Cast, field));
            colDimNames.Add(d.Calc is null ? $"{d.Table}.{d.Column}" : CalcSql.CalcLabel(d.Column));
            dimRefs.Add(d);
        }

        // Measures → aggregated columns, selected as v0, v1, … (in request order). No measures →
        // an implicit count() so every view (bar/line/KPI) has a value to plot.
        var measExprs = new List<string>();
        var measNames = new List<string>();
        var measNumeric = new List<bool>();
        var measIndex = 0;
        foreach (var m in req.Measures ?? [])
        {
            var mIdx = measIndex++;
            if (m.Calc is { } mCalc)
            {
                // E4: an aggregate tree as is; a row-level tree aggregated by the pill. No "count" default here.
                var (calcSql, calcNumeric) = CalcSql.CalcMeasureSql(m.Agg, await CompileCalcAsync(mCalc, $"measures[{mIdx}]"), $"measures[{mIdx}]", sampled, approximate);
                measExprs.Add(calcSql);
                measNames.Add(CalcSql.CalcLabel(m.Column));
                measNumeric.Add(calcNumeric);
                continue;
            }
            var mAgg = (m.Agg ?? "count").ToLowerInvariant();
            if (!Aggregations.Contains(mAgg)) throw new UnknownIdentifierException("Unknown aggregation.");
            if (mAgg != "count" && !(await ColumnsOf(m.Db, m.Table)).ContainsKey(m.Column))
                throw new UnknownIdentifierException("Unknown column.");
            var category = mAgg == "count" ? ClickHouseType.Numeric : TypeCast.EffectiveCategory((await ColumnsOf(m.Db, m.Table)).GetValueOrDefault(m.Column, ClickHouseType.Other), m.Cast);
            if (mAgg is "sum" or "avg" && category != ClickHouseType.Numeric)
                throw new RequestValidationException($"{char.ToUpperInvariant(mAgg[0])}{mAgg[1..]} needs a numeric column — {m.Column} is {category}.", $"measures[{mIdx}]");
            measNumeric.Add(mAgg is "count" or "countdistinct" or "countnonnull" or "sum" or "avg" || category == ClickHouseType.Numeric);
            // E10: one aggregate writer for plain and calculated measures. P33: sampled sums/counts are scaled back,
            // approximate mode estimates distinct counts (uniq).
            measExprs.Add(AggregateSql(mAgg, mAgg == "count" ? "" : await CastedAsync(m.Db, m.Table, m.Column, m.Cast, $"measures[{mIdx}]"), sampled, approximate));
            measNames.Add(MeasureName(mAgg, m.Column));
        }
        if (measExprs.Count == 0)
        {
            measExprs.Add(AggregateSql("count", "", sampled, approximate));
            measNames.Add("count");
            measNumeric.Add(true);
        }

        var conditions = new List<string>();
        var filters = req.Filters ?? [];
        var tops = new List<(QueryFilter F, int Index)>();
        for (var i = 0; i < filters.Length; i++)
        {
            var f = filters[i];
            if (string.Equals(f.Op, "top", StringComparison.OrdinalIgnoreCase)) { tops.Add((f, i)); continue; } // after the others
            var expr = await CastedAsync(f.Db, f.Table, f.Column, f.Cast, $"filters[{i}]"); // validates + quotes the column; T02-34 cast
            conditions.Add(BuildCondition(f.Op, $"p{i}", expr, CategoryOfRef(f.Db, f.Table, f.Column, f.Cast), f.Column, $"filters[{i}]", f.Value, f.Values, parameters,
                DateOnlyOfRef(f.Db, f.Table, f.Column, f.Cast)));
        }
        // P30 top-N filters: the column's members ranked by an aggregate over the same joins and the other
        // filters — `col IN (SELECT col … GROUP BY col ORDER BY agg DESC LIMIT n)`. Column and measure are
        // catalog-validated, the aggregation whitelisted, n a validated integer.
        var others = conditions.Count > 0 ? " WHERE " + string.Join(" AND ", conditions) : "";
        foreach (var (f, i) in tops)
        {
            var expr = await CastedAsync(f.Db, f.Table, f.Column, f.Cast, $"filters[{i}]");
            var by = f.TopBy!;
            string rank;
            if (by.Calc is { } byCalc)
            {
                // Compiled once; its literals join `parameters`, which the page and total statements carry.
                rank = CalcSql.CalcMeasureSql(by.Agg, await CompileCalcAsync(byCalc, $"filters[{i}].topBy"), $"filters[{i}].topBy", sampled, approximate).Sql;
                conditions.Add(TopCondition(expr, from.ToString(), others, rank, f));
                continue;
            }
            var agg = (by.Agg ?? "sum").ToLowerInvariant();
            if (!Aggregations.Contains(agg)) throw new UnknownIdentifierException("Unknown aggregation.");
            if (agg == "count") rank = "count()";
            else
            {
                var byCols = await ColumnsOf(by.Db, by.Table);
                if (!byCols.TryGetValue(by.Column, out var byCat)) throw new UnknownIdentifierException("Unknown column.");
                byCat = TypeCast.EffectiveCategory(byCat, by.Cast);
                if (agg is "sum" or "avg" && byCat != ClickHouseType.Numeric)
                    throw new RequestValidationException($"Top-N can't rank by {agg} of {by.Column} — it isn't numeric.", $"filters[{i}].topBy");
                var byExpr = await CastedAsync(by.Db, by.Table, by.Column, by.Cast, $"filters[{i}].topBy");
                rank = PlainRankSql(agg, byExpr);
            }
            conditions.Add(TopCondition(expr, from.ToString(), others, rank, f));
        }
        var where = conditions.Count > 0 ? " WHERE " + string.Join(" AND ", conditions) : "";

        // Date grouping: the first date/time dimension is truncated to a calendar grain (whitelisted
        // function over the already-quoted column), so a long time axis returns months, not millions
        // of timestamps. "auto" asks ClickHouse for the range first.
        // P26: a dimension's own date part comes first (whitelisted function); only a date dimension left on
        // "auto" (or unset) takes part in the chart-wide grouping below.
        for (var i = 0; i < dimRefs.Count; i++)
        {
            var d = dimRefs[i];
            if (d.Calc is not null || d.DatePart is null or "auto" or "exact") continue; // E12: a calculation is never date-grouped
            if (CategoryOfRef(d.Db, d.Table, d.Column, d.Cast) != ClickHouseType.Temporal)
                throw new RequestValidationException($"A date part needs a date column — {d.Column} isn't one.", "datePart");
            dimExprs[i] = DatePartExpression(d.DatePart, dimExprs[i], DateOnlyOfRef(d.Db, d.Table, d.Column, d.Cast))!;
        }

        DateBucketApplied? bucket = null;
        if (req.DateBucket is { } wanted)
        {
            var bi = dimRefs.FindIndex(d => d.Calc is null && d.DatePart is null or "auto" && CategoryOfRef(d.Db, d.Table, d.Column, d.Cast) == ClickHouseType.Temporal);
            if (bi >= 0)
            {
                var dateOnly = DateOnlyOfRef(dimRefs[bi].Db, dimRefs[bi].Table, dimRefs[bi].Column, dimRefs[bi].Cast);
                var grain = wanted == "auto"
                    ? await AutoGrainAsync(info, dimExprs[bi], from.ToString(), where + Settings(anyLeft, info),
                        ParametersUsedBy(dimExprs[bi] + where, parameters), dateOnly, ct)
                    : wanted;
                if (grain == "hour" && dateOnly) grain = "day";
                if (grain is not null)
                {
                    dimExprs[bi] = BucketExpression(grain, dimExprs[bi]);
                    bucket = new DateBucketApplied(bi, grain);
                }
            }
        }

        var selects = new List<string>();
        for (var i = 0; i < dimExprs.Count; i++) selects.Add($"{dimExprs[i]} AS k{i}");
        for (var i = 0; i < measExprs.Count; i++) selects.Add($"{measExprs[i]} AS v{i}");
        var groupBy = dimExprs.Count > 0
            ? " GROUP BY " + string.Join(", ", Enumerable.Range(0, dimExprs.Count).Select(i => $"k{i}"))
            : "";
        var grouped = "SELECT " + string.Join(", ", selects) + from + where + groupBy;

        // ORDER BY: the requested sort column (a generated k{n}/v{n} alias, validated against the
        // dimension/measure counts) in the chosen direction, defaulting to ascending by the first
        // dimension (or first measure if there are none). The remaining dimension keys are always
        // appended ascending so the crosstab's nested layout stays stable regardless of the sort —
        // and so paging with OFFSET is deterministic (group keys are unique).
        var sortCol = dimExprs.Count > 0 ? "k0" : "v0";
        var sortDesc = false;
        if (req.Sort is { } srt && IsValidSortAlias(srt.Column, dimExprs.Count, measExprs.Count))
        {
            sortCol = srt.Column;
            sortDesc = srt.Desc;
        }
        var orderParts = new List<string> { $"{sortCol} {(sortDesc ? "DESC" : "ASC")}" };
        for (var i = 0; i < dimExprs.Count; i++)
        {
            var a = $"k{i}";
            if (a != sortCol) orderParts.Add($"{a} ASC");
        }
        var ordered = grouped + " ORDER BY " + string.Join(", ", orderParts);
        var limit = ProbeLimit(req.Limit, maxLimit);
        var offset = req.Offset is > 0 ? $" OFFSET {req.Offset.Value}" : "";

        // The group count runs alongside the page (its own connection), only when asked.
        var totalTask = req.WithTotal == true
            ? (dimExprs.Count == 0 ? Task.FromResult<long?>(1) : CountGroupsAsync(info, grouped, parameters, ct, Settings(anyLeft, info)))
            : Task.FromResult<long?>(null);

        var rows = new List<QueryResultRow>();
        await using (var conn = await OpenAsync(info, ct))
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = ordered + $" LIMIT {limit}" + offset + Settings(anyLeft, info);
            foreach (var (name, type, value) in parameters) cmd.AddParameter(name, type, value);

            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                var keys = new string?[dimExprs.Count];
                for (var i = 0; i < dimExprs.Count; i++)
                    keys[i] = reader.IsDBNull(i) ? null : FormatKey(reader.GetValue(i));
                var values = new object?[measExprs.Count];
                for (var i = 0; i < measExprs.Count; i++)
                {
                    var idx = dimExprs.Count + i;
                    values[i] = reader.IsDBNull(idx) ? null : ToResultValue(reader.GetValue(idx), measNumeric[i]);
                }
                rows.Add(new QueryResultRow(keys, values));
            }
        }
        var truncated = TrimProbeRow(rows, limit);

        // "Other": everything past this page's groups, aggregated by the same measures. Only for one
        // dimension (a single category axis) — the shown keys are the same ordered query, so the two
        // agree exactly. NULL keys match in IN (transform_null_in) so a shown NULL group isn't recounted.
        OtherGroup? other = null;
        if (req.OtherBucket == true && truncated && dimExprs.Count == 1 && req.Offset is null or 0)
        {
            // Reuses the compiled dimension and measure SQL, so it is sent with the same `parameters` as the page.
            var otherSql = OtherSql(dimExprs[0], measExprs, from.ToString(), where, ordered, limit,
                anyLeft && info.Guards != QueryGuards.None ? ", join_use_nulls = 1" : "");
            try { other = await OtherAsync(info, otherSql, parameters, measNumeric, ct); }
            catch (ClickHouseServerException ex)
            {
                // A server that refuses the setting (e.g. a readonly=1 profile) still gets its chart — just
                // without the "Other" bar. The main result above is unaffected.
                _logger.LogWarning("Other-bucket query failed ({Code}); returning the chart without it.", ex.ErrorCode);
            }
        }

        var approx = req.Approximate == true
            ? new ApproxApplied(CalcSql.UsesDistinctCount(req.Measures ?? []), sampled ? SampleFraction : null)
            : null;
        return new QueryResult(rowDimNames, colDimNames, measNames, rows, truncated, await totalTask, other, bucket, false, approx);
    }

    /// <summary>An open connection that also disposes the HttpClient it was built on.</summary>
    private sealed class OpenConnection(ClickHouseConnection conn, HttpClient http) : IAsyncDisposable
    {
        public ClickHouseCommand CreateCommand() => conn.CreateCommand();
        public async ValueTask DisposeAsync() { await conn.DisposeAsync(); http.Dispose(); }
    }

    private async Task<OpenConnection> OpenAsync(ClickHouseConnectionInfo info, CancellationToken ct)
    {
        var http = CreateHttpClient(info);
        var conn = new ClickHouseConnection(BuildConnectionString(info), http);
        try { await conn.OpenAsync(ct); }
        catch { await conn.DisposeAsync(); http.Dispose(); throw; }
        return new OpenConnection(conn, http);
    }

    /// <summary>P31: a left join's unmatched side reads as NULL (ClickHouse's default is the type's zero / ""),
    /// unless the server refuses settings (then the defaults show).</summary>
    internal static string Settings(bool anyLeft, ClickHouseConnectionInfo info) =>
        anyLeft && info.Guards != QueryGuards.None ? " SETTINGS join_use_nulls = 1" : "";

    /// <summary>P33: whether a table declares a sampling key (only then can it be read with SAMPLE).</summary>
    private async Task<bool> HasSamplingKeyAsync(ClickHouseConnectionInfo info, string db, string table, CancellationToken ct)
    {
        await using var conn = await OpenAsync(info, ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT sampling_key FROM system.tables WHERE database = {db:String} AND name = {t:String}";
        cmd.AddParameter("db", "String", db);
        cmd.AddParameter("t", "String", table);
        var v = await cmd.ExecuteScalarAsync(ct);
        return v is string key && key.Length > 0;
    }

    /// <summary>The "Other" row: group count + each measure over everything past the shown groups.</summary>
    private async Task<OtherGroup?> OtherAsync(ClickHouseConnectionInfo info, string sql,
        List<(string Name, string Type, object Value)> parameters, List<bool> measNumeric, CancellationToken ct)
    {
        await using var conn = await OpenAsync(info, ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, type, value) in parameters) cmd.AddParameter(name, type, value);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        var n = reader.IsDBNull(0) ? 0L : Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture);
        var values = new object?[measNumeric.Count];
        for (var i = 0; i < measNumeric.Count; i++)
            values[i] = reader.IsDBNull(i + 1) ? null : ToResultValue(reader.GetValue(i + 1), measNumeric[i]);
        return n > 0 ? new OtherGroup(n, values) : null;
    }

    /// <summary>How many groups a grouped query returns (the table's "of N rows").</summary>
    private async Task<long?> CountGroupsAsync(ClickHouseConnectionInfo info, string grouped,
        List<(string Name, string Type, object Value)> parameters, CancellationToken ct, string settings = "")
    {
        await using var conn = await OpenAsync(info, ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT count() FROM ({grouped}){settings}";
        foreach (var (name, type, value) in parameters) cmd.AddParameter(name, type, value);
        var n = await cmd.ExecuteScalarAsync(ct);
        return n is null or DBNull ? 0 : Convert.ToInt64(n, CultureInfo.InvariantCulture);
    }

    /// <summary>"auto" date grouping: read the dimension's distinct count and range under the view's
    /// filters, then <see cref="PickGrain"/>.</summary>
    private async Task<string?> AutoGrainAsync(ClickHouseConnectionInfo info, string expr, string from, string where,
        List<(string Name, string Type, object Value)> parameters, bool dateOnly, CancellationToken ct)
    {
        await using var conn = await OpenAsync(info, ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT uniq({expr}), min({expr}), max({expr}){from}{where}";
        foreach (var (name, type, value) in parameters) cmd.AddParameter(name, type, value);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct) || reader.IsDBNull(1) || reader.IsDBNull(2)) return null;
        var distinct = Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture);
        static DateTime AsDate(object v) => v switch { DateTimeOffset o => o.UtcDateTime, DateTime d => d, _ => Convert.ToDateTime(v, CultureInfo.InvariantCulture) };
        return PickGrain(distinct, AsDate(reader.GetValue(1)), AsDate(reader.GetValue(2)), dateOnly);
    }

    /// <summary>A measure cell for JSON: finite double, display string for non-numeric min/max, or null
    /// (SQL NULL, or NaN/∞ from an aggregate over no rows — System.Text.Json can't write those).</summary>
    internal static object? ToResultValue(object? raw, bool numeric)
    {
        if (raw is null or DBNull) return null;
        if (!numeric) return FormatCell(raw);
        var d = Convert.ToDouble(raw, CultureInfo.InvariantCulture);
        return double.IsFinite(d) ? d : null;
    }

    /// <summary>Confirm a table exists in a database for this connection (validates the db too).</summary>
    private async Task EnsureTableExistsAsync(
        ClickHouseConnectionInfo info, string database, string table, CancellationToken ct)
    {
        var tables = await ListTablesAsync(info, database, ct); // throws for an unknown database
        if (!tables.Contains(table, StringComparer.Ordinal))
            throw new UnknownIdentifierException("Unknown table.");
    }

    /// <summary>A group-key / distinct-value label: dates render as ISO (so they round-trip as filter values), everything else as before.</summary>
    internal static string? FormatKey(object? value) => value switch
    {
        null => null,
        DateTime or DateTimeOffset => FormatCell(value),
        _ => value.ToString(),
    };

    // Reduce a cell value to a display string. Numbers use the invariant culture; arrays/tuples/maps
    // render compactly; byte blobs become hex. Nulls are handled by the caller (kept as JSON null).
    internal static string FormatCell(object value) => value switch
    {
        string s => s,
        bool b => b ? "true" : "false",
        byte[] bytes => Convert.ToHexString(bytes),
        System.Collections.IEnumerable items and not string =>
            "[" + string.Join(", ", items.Cast<object?>().Select(x => x?.ToString() ?? "NULL")) + "]",
        DateTime dt => dt.ToString(dt.TimeOfDay == TimeSpan.Zero ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture),
        DateTimeOffset dto => dto.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture),
        IFormattable f => f.ToString(null, System.Globalization.CultureInfo.InvariantCulture),
        _ => value.ToString() ?? string.Empty,
    };

    /// <summary>Open a short-lived connection, run a read-only query, and collect its first column.</summary>
    private async Task<IReadOnlyList<string>> QueryStringColumnAsync(
        ClickHouseConnectionInfo info, string sql, CancellationToken ct)
    {
        using var httpClient = CreateHttpClient(info);
        await using var conn = new ClickHouseConnection(BuildConnectionString(info), httpClient);
        await conn.OpenAsync(ct);

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        var values = new List<string>();
        while (await reader.ReadAsync(ct))
            values.Add(reader.IsDBNull(0) ? string.Empty : reader.GetValue(0)?.ToString() ?? string.Empty);
        return values;
    }
}

/// <summary>Thrown when a client-supplied identifier isn't present in the live catalog.</summary>
public sealed class UnknownIdentifierException(string message) : Exception(message);
