using System.Globalization;
using System.Net;
using System.Text;
using ClickHouse.Client;
using ClickHouse.Client.ADO;
using ClickHouse.Client.Utility; // AddParameter extension

namespace DashboardBuilder.ClickHouse;

/// <summary>
/// The one place SQL is run against ClickHouse. Everything here is <strong>read-only</strong>
/// (validate / introspect / bounded preview) — there is deliberately no DDL/DML path
/// (CLAUDE.md golden rule 1). Covers connection validation (P1) and schema browsing (P3);
/// columns/preview land in P4.
/// </summary>
public sealed class ClickHouseGateway
{
    private readonly ILogger<ClickHouseGateway> _logger;

    public ClickHouseGateway(ILogger<ClickHouseGateway> logger) => _logger = logger;

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

    /// <summary>The largest number of rows a single preview may pull — a preview must never try
    /// to stream a huge table into the browser (CLAUDE.md gotcha).</summary>
    public const int MaxPreviewRows = 500;

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
    /// A bounded row preview: <c>SELECT * FROM `db`.`table` LIMIT n</c>. Identifiers are
    /// catalog-validated and quoted; <c>n</c> is a validated integer clamped to
    /// <see cref="MaxPreviewRows"/> — never a huge or client-controlled scan.
    /// </summary>
    /// <exception cref="UnknownIdentifierException">No such database or table for this connection.</exception>
    public async Task<PreviewResult> PreviewAsync(
        ClickHouseConnectionInfo info, string database, string table, int limit, CancellationToken ct)
    {
        await EnsureTableExistsAsync(info, database, table, ct);
        var n = Math.Clamp(limit, 1, MaxPreviewRows);
        var sql = $"SELECT * FROM {Identifier.QualifiedName(database, table)} LIMIT {n}";

        using var httpClient = CreateHttpClient(info);
        await using var conn = new ClickHouseConnection(BuildConnectionString(info), httpClient);
        await conn.OpenAsync(ct);

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        var names = new string[reader.FieldCount];
        for (var i = 0; i < reader.FieldCount; i++) names[i] = reader.GetName(i);

        var rows = new List<object?[]>();
        while (await reader.ReadAsync(ct))
        {
            var row = new object?[reader.FieldCount];
            for (var i = 0; i < reader.FieldCount; i++)
                row[i] = reader.IsDBNull(i) ? null : FormatCell(reader.GetValue(i));
            rows.Add(row);
        }
        return new PreviewResult(names, rows);
    }

    /// <summary>Total row count for a table: <c>SELECT count() FROM `db`.`table`</c> (KPI widget).</summary>
    /// <exception cref="UnknownIdentifierException">No such database or table for this connection.</exception>
    public async Task<long> RowCountAsync(
        ClickHouseConnectionInfo info, string database, string table, CancellationToken ct)
    {
        await EnsureTableExistsAsync(info, database, table, ct);
        var sql = $"SELECT count() FROM {Identifier.QualifiedName(database, table)}";

        using var httpClient = CreateHttpClient(info);
        await using var conn = new ClickHouseConnection(BuildConnectionString(info), httpClient);
        await conn.OpenAsync(ct);

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        return Convert.ToInt64(await cmd.ExecuteScalarAsync(ct));
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
            values.Add(reader.IsDBNull(0) ? null : reader.GetValue(0)?.ToString());
        return values;
    }

    // "countdistinct" counts unique values — mapped to ClickHouse uniqExact() in the SELECT builders.
    private static readonly HashSet<string> Aggregations =
        new(StringComparer.OrdinalIgnoreCase) { "count", "sum", "avg", "min", "max", "countdistinct" };

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
    /// clamped 1..500) plus one probe row, so the server can tell whether more rows exist.</summary>
    internal static int ProbeLimit(int? requested) => Math.Clamp(requested ?? 50, 1, ApiLimits.MaxRowLimit) + 1;

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
    /// parameters — never interpolated. Returns the SQL condition, or an empty string when the filter
    /// is a no-op (an empty <c>in</c> list, or a <c>between</c> missing a bound). Unknown operators throw.
    /// </summary>
    internal static string BuildCondition(
        string? op, string paramBase, string expr, bool numeric,
        string? value, IReadOnlyList<string>? values,
        List<(string Name, string Type, object Value)> parameters)
    {
        switch ((op ?? string.Empty).ToLowerInvariant())
        {
            case "in":
            {
                var vals = (values ?? []).Where(v => v is not null).Take(ApiLimits.MaxInValues).ToList();
                if (vals.Count == 0) return string.Empty; // empty IN → skip (never emit "IN ()")
                if (numeric && vals.All(v => double.TryParse(v, NumberStyles.Any, CultureInfo.InvariantCulture, out _)))
                {
                    var nums = vals.Select(v => double.Parse(v, NumberStyles.Any, CultureInfo.InvariantCulture)).ToArray();
                    parameters.Add((paramBase, "Array(Float64)", nums));
                    return $"{expr} IN {{{paramBase}:Array(Float64)}}";
                }
                parameters.Add((paramBase, "Array(String)", vals.ToArray()));
                return $"{expr} IN {{{paramBase}:Array(String)}}";
            }
            case "between":
            {
                var lo = values is { Count: > 0 } ? values[0] : null;
                var hi = values is { Count: > 1 } ? values[1] : null;
                if (lo is null || hi is null) return string.Empty;
                var (na, nb) = ($"{paramBase}a", $"{paramBase}b");
                if (numeric
                    && double.TryParse(lo, NumberStyles.Any, CultureInfo.InvariantCulture, out var dlo)
                    && double.TryParse(hi, NumberStyles.Any, CultureInfo.InvariantCulture, out var dhi))
                {
                    parameters.Add((na, "Float64", dlo));
                    parameters.Add((nb, "Float64", dhi));
                    return $"{expr} >= {{{na}:Float64}} AND {expr} <= {{{nb}:Float64}}";
                }
                parameters.Add((na, "String", lo));
                parameters.Add((nb, "String", hi));
                return $"{expr} >= {{{na}:String}} AND {expr} <= {{{nb}:String}}";
            }
            default:
            {
                if (!Operators.TryGetValue(op ?? string.Empty, out var sqlOp))
                    throw new UnknownIdentifierException("Unknown operator.");
                if (numeric && double.TryParse(value, NumberStyles.Any, CultureInfo.InvariantCulture, out var num))
                {
                    parameters.Add((paramBase, "Float64", num));
                    return $"{expr} {sqlOp} {{{paramBase}:Float64}}";
                }
                parameters.Add((paramBase, "String", value ?? string.Empty));
                return $"{expr} {sqlOp} {{{paramBase}:String}}";
            }
        }
    }

    /// <summary>
    /// Build a bound-parameter WHERE clause for a <em>single</em> table (no join alias) from a filter
    /// list, appending typed parameters to <paramref name="parameters"/>. Pure + testable: each column
    /// is looked up in <paramref name="byName"/> (unknown → 400), each operator whitelisted, and each
    /// value bound (numeric columns as Float64 when the value parses, else String) — never interpolated.
    /// Returns the clause **including** a leading <c>" WHERE "</c>, or an empty string when there are no
    /// conditions. At most 8 filters are honoured.
    /// </summary>
    internal static string BuildSingleTableFilters(
        IReadOnlyList<AggregateFilter> filters,
        IReadOnlyDictionary<string, ColumnInfo> byName,
        List<(string Name, string Type, object Value)> parameters)
    {
        var conditions = new List<string>();
        for (var i = 0; i < filters.Count; i++)
        {
            var f = filters[i];
            if (string.IsNullOrEmpty(f.Column) || !byName.TryGetValue(f.Column, out var ci))
                throw new UnknownIdentifierException("Unknown column.");
            if (!Operators.TryGetValue(f.Op, out var op))
                throw new UnknownIdentifierException("Unknown operator.");

            var name = $"p{i}";
            if (ci.Category == ClickHouseType.Numeric
                && double.TryParse(f.Value, NumberStyles.Any, CultureInfo.InvariantCulture, out var num))
            {
                parameters.Add((name, "Float64", num));
                conditions.Add($"{Identifier.Quote(f.Column)} {op} {{{name}:Float64}}");
            }
            else
            {
                parameters.Add((name, "String", f.Value ?? string.Empty));
                conditions.Add($"{Identifier.Quote(f.Column)} {op} {{{name}:String}}");
            }
        }
        return conditions.Count > 0 ? " WHERE " + string.Join(" AND ", conditions) : string.Empty;
    }

    /// <summary>
    /// Run a single-table aggregate for a chart (2a): <c>SELECT dim, agg(measure) FROM db.table
    /// [WHERE …] [GROUP BY dim] ORDER BY value DESC LIMIT n</c>. Columns are catalog-validated and
    /// quoted; the aggregation and operators come from whitelists; filter values are bound as typed
    /// parameters (never interpolated). The row count is bounded.
    /// </summary>
    /// <exception cref="UnknownIdentifierException">An identifier / aggregation / operator is not allowed.</exception>
    public async Task<AggregateResult> AggregateAsync(
        ClickHouseConnectionInfo info, string database, string table, AggregateRequest req, CancellationToken ct)
    {
        var columns = await DescribeColumnsAsync(info, database, table, ct); // also validates db+table
        var byName = columns.ToDictionary(c => c.Name, c => c, StringComparer.Ordinal);

        string Require(string? name)
        {
            if (string.IsNullOrEmpty(name) || !byName.ContainsKey(name))
                throw new UnknownIdentifierException("Unknown column.");
            return name;
        }

        var agg = (req.Agg ?? "count").ToLowerInvariant();
        if (!Aggregations.Contains(agg))
            throw new UnknownIdentifierException("Unknown aggregation.");

        var hasDimension = !string.IsNullOrEmpty(req.Dimension);
        var dimension = hasDimension ? Require(req.Dimension) : null;

        var valueExpr = agg switch
        {
            "count" => "count()",
            "countdistinct" => $"uniqExact({Identifier.Quote(Require(req.Measure))})",
            _ => $"{agg}({Identifier.Quote(Require(req.Measure))})",
        };

        var sql = new StringBuilder("SELECT ");
        if (dimension is not null) sql.Append($"{Identifier.Quote(dimension)} AS label, ");
        sql.Append(valueExpr).Append(" AS value FROM ").Append(Identifier.QualifiedName(database, table));

        var parameters = new List<(string Name, string Type, object Value)>();
        var filters = req.Filters ?? [];
        var conditions = new List<string>();
        for (var i = 0; i < filters.Length; i++)
        {
            var f = filters[i];
            var col = Require(f.Column);
            if (!Operators.TryGetValue(f.Op, out var op))
                throw new UnknownIdentifierException("Unknown operator.");

            var name = $"p{i}";
            if (byName[col].Category == ClickHouseType.Numeric
                && double.TryParse(f.Value, NumberStyles.Any, CultureInfo.InvariantCulture, out var num))
            {
                parameters.Add((name, "Float64", num));
                conditions.Add($"{Identifier.Quote(col)} {op} {{{name}:Float64}}");
            }
            else
            {
                parameters.Add((name, "String", f.Value ?? string.Empty));
                conditions.Add($"{Identifier.Quote(col)} {op} {{{name}:String}}");
            }
        }
        if (conditions.Count > 0) sql.Append(" WHERE ").Append(string.Join(" AND ", conditions));

        if (dimension is not null) sql.Append(" GROUP BY label");
        sql.Append(" ORDER BY value DESC LIMIT ").Append(Math.Clamp(req.Limit ?? 50, 1, ApiLimits.MaxRowLimit));

        using var httpClient = CreateHttpClient(info);
        await using var conn = new ClickHouseConnection(BuildConnectionString(info), httpClient);
        await conn.OpenAsync(ct);

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql.ToString();
        foreach (var (name, type, value) in parameters)
            cmd.AddParameter(name, type, value);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        var valueIdx = dimension is not null ? 1 : 0;
        var rows = new List<AggregateRow>();
        while (await reader.ReadAsync(ct))
        {
            var label = dimension is not null
                ? (reader.IsDBNull(0) ? null : reader.GetValue(0)?.ToString())
                : null;
            var value = reader.IsDBNull(valueIdx)
                ? 0d
                : Convert.ToDouble(reader.GetValue(valueIdx), CultureInfo.InvariantCulture);
            rows.Add(new AggregateRow(label, value));
        }
        return new AggregateResult(rows);
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
        var sql =
            $"WITH (SELECT min({qname}) FROM {qualified}{where}) AS lo, " +
            $"(SELECT max({qname}) FROM {qualified}{where}) AS hi, " +
            $"if(hi > lo, (hi - lo) / {bins}, 1) AS width " +
            $"SELECT least(toUInt32(floor(({qname} - lo) / width)), {bins - 1}) AS bin, " +
            $"lo + bin * width AS x0, lo + (bin + 1) * width AS x1, count() AS c " +
            $"FROM {qualified}{where} GROUP BY bin, x0, x1 ORDER BY bin";

        using var httpClient = CreateHttpClient(info);
        await using var conn = new ClickHouseConnection(BuildConnectionString(info), httpClient);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, type, value) in parameters) cmd.AddParameter(name, type, value);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        var doub = (int i) => reader.IsDBNull(i) ? 0d : Convert.ToDouble(reader.GetValue(i), CultureInfo.InvariantCulture);
        var binsOut = new List<HistogramBin>();
        while (await reader.ReadAsync(ct))
            binsOut.Add(new HistogramBin(doub(1), doub(2),
                reader.IsDBNull(3) ? 0L : Convert.ToInt64(reader.GetValue(3), CultureInfo.InvariantCulture)));
        return new HistogramResult(binsOut);
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
        var doub = (int i) => reader.IsDBNull(i) ? 0d : Convert.ToDouble(reader.GetValue(i), CultureInfo.InvariantCulture);
        var groups = new List<BoxPlotGroup>();
        while (await reader.ReadAsync(ct))
        {
            var label = hasDim ? (reader.IsDBNull(0) ? null : reader.GetValue(0)?.ToString()) : null;
            groups.Add(new BoxPlotGroup(label, doub(b), doub(b + 1), doub(b + 2), doub(b + 3), doub(b + 4)));
        }
        var truncated = TrimProbeRow(groups, limit);
        return new BoxPlotResult(groups, truncated);
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
    public async Task<QueryResult> QueryAsync(ClickHouseConnectionInfo info, QueryRequest req, CancellationToken ct)
    {
        var aliases = new Dictionary<string, string>();                 // "db\0table" -> alias
        var categories = new Dictionary<string, Dictionary<string, string>>(); // "db\0table" -> col -> category
        static string Key(string db, string table) => $"{db}\0{table}";

        async Task<Dictionary<string, string>> ColumnsOf(string db, string table)
        {
            var key = Key(db, table);
            if (!categories.TryGetValue(key, out var map))
            {
                var cols = await DescribeColumnsAsync(info, db, table, ct); // validates db + table
                map = cols.ToDictionary(c => c.Name, c => c.Category, StringComparer.Ordinal);
                categories[key] = map;
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

        // Base table = t0.
        await ColumnsOf(req.From.Db, req.From.Table);
        aliases[Key(req.From.Db, req.From.Table)] = "t0";
        var from = new StringBuilder(" FROM ")
            .Append(Identifier.QualifiedName(req.From.Db, req.From.Table)).Append(" AS t0");

        var next = 1;
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
                from.Append(" INNER JOIN ").Append(Identifier.QualifiedName(j.Right.Db, j.Right.Table))
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
        foreach (var d in req.RowDimensions ?? [])
        {
            dimExprs.Add(await QualifyAsync(d.Db, d.Table, d.Column));
            rowDimNames.Add($"{d.Table}.{d.Column}");
        }
        foreach (var d in req.ColumnDimensions ?? [])
        {
            dimExprs.Add(await QualifyAsync(d.Db, d.Table, d.Column));
            colDimNames.Add($"{d.Table}.{d.Column}");
        }

        // Measures → aggregated columns, selected as v0, v1, … (in request order). No measures →
        // an implicit count() so every view (bar/line/KPI) has a value to plot.
        var measExprs = new List<string>();
        var measNames = new List<string>();
        foreach (var m in req.Measures ?? [])
        {
            var mAgg = (m.Agg ?? "count").ToLowerInvariant();
            if (!Aggregations.Contains(mAgg)) throw new UnknownIdentifierException("Unknown aggregation.");
            if (mAgg == "count")
            {
                measExprs.Add("count()");
                measNames.Add("count");
            }
            else if (mAgg == "countdistinct")
            {
                measExprs.Add($"uniqExact({await QualifyAsync(m.Db, m.Table, m.Column)})");
                measNames.Add($"distinct {m.Column}");
            }
            else
            {
                measExprs.Add($"{mAgg}({await QualifyAsync(m.Db, m.Table, m.Column)})");
                measNames.Add($"{mAgg} {m.Column}");
            }
        }
        if (measExprs.Count == 0)
        {
            measExprs.Add("count()");
            measNames.Add("count");
        }

        var sql = new StringBuilder("SELECT ");
        var selects = new List<string>();
        for (var i = 0; i < dimExprs.Count; i++) selects.Add($"{dimExprs[i]} AS k{i}");
        for (var i = 0; i < measExprs.Count; i++) selects.Add($"{measExprs[i]} AS v{i}");
        sql.Append(string.Join(", ", selects)).Append(from);

        var parameters = new List<(string Name, string Type, object Value)>();
        var conditions = new List<string>();
        var filters = req.Filters ?? [];
        for (var i = 0; i < filters.Length; i++)
        {
            var f = filters[i];
            var expr = await QualifyAsync(f.Db, f.Table, f.Column);      // validates + quotes the column
            var numeric = categories[Key(f.Db, f.Table)][f.Column] == ClickHouseType.Numeric;
            var cond = BuildCondition(f.Op, $"p{i}", expr, numeric, f.Value, f.Values, parameters);
            if (cond.Length > 0) conditions.Add(cond);                    // empty = no-op (empty IN / partial range)
        }
        if (conditions.Count > 0) sql.Append(" WHERE ").Append(string.Join(" AND ", conditions));
        if (dimExprs.Count > 0)
            sql.Append(" GROUP BY ").Append(string.Join(", ", Enumerable.Range(0, dimExprs.Count).Select(i => $"k{i}")));
        // ORDER BY: the requested sort column (a generated k{n}/v{n} alias, validated against the
        // dimension/measure counts) in the chosen direction, defaulting to ascending by the first
        // dimension (or first measure if there are none). The remaining dimension keys are always
        // appended ascending so the crosstab's nested layout stays stable regardless of the sort.
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
        sql.Append(" ORDER BY ").Append(string.Join(", ", orderParts));
        var limit = ProbeLimit(req.Limit);
        sql.Append(" LIMIT ").Append(limit);

        using var httpClient = CreateHttpClient(info);
        await using var conn = new ClickHouseConnection(BuildConnectionString(info), httpClient);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql.ToString();
        foreach (var (name, type, value) in parameters) cmd.AddParameter(name, type, value);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        var rows = new List<QueryResultRow>();
        while (await reader.ReadAsync(ct))
        {
            var keys = new string?[dimExprs.Count];
            for (var i = 0; i < dimExprs.Count; i++)
                keys[i] = reader.IsDBNull(i) ? null : reader.GetValue(i)?.ToString();
            var values = new double[measExprs.Count];
            for (var i = 0; i < measExprs.Count; i++)
            {
                var idx = dimExprs.Count + i;
                values[i] = reader.IsDBNull(idx) ? 0d : Convert.ToDouble(reader.GetValue(idx), CultureInfo.InvariantCulture);
            }
            rows.Add(new QueryResultRow(keys, values));
        }
        var truncated = TrimProbeRow(rows, limit);
        return new QueryResult(rowDimNames, colDimNames, measNames, rows, truncated);
    }

    /// <summary>Confirm a table exists in a database for this connection (validates the db too).</summary>
    private async Task EnsureTableExistsAsync(
        ClickHouseConnectionInfo info, string database, string table, CancellationToken ct)
    {
        var tables = await ListTablesAsync(info, database, ct); // throws for an unknown database
        if (!tables.Contains(table, StringComparer.Ordinal))
            throw new UnknownIdentifierException("Unknown table.");
    }

    // Reduce a cell value to a display string. Numbers use the invariant culture; arrays/tuples/maps
    // render compactly; byte blobs become hex. Nulls are handled by the caller (kept as JSON null).
    private static string FormatCell(object value) => value switch
    {
        string s => s,
        bool b => b ? "true" : "false",
        byte[] bytes => Convert.ToHexString(bytes),
        System.Collections.IEnumerable items and not string =>
            "[" + string.Join(", ", items.Cast<object?>().Select(x => x?.ToString() ?? "NULL")) + "]",
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
