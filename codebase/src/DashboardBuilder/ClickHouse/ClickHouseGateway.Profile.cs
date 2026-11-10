using System.Globalization;
using ClickHouse.Client;
using ClickHouse.Client.ADO;
using ClickHouse.Client.Utility;

namespace DashboardBuilder.ClickHouse;

// Column profile (backlog "Column profile"): two bounded read-only statements over the first
// ApiLimits.ProfileSampleRows rows of one catalog-validated column.
public sealed partial class ClickHouseGateway
{
    /// <summary>Stats + top values of one column. Database, table and column are catalog-validated and quoted; every scan is a
    /// <c>LIMIT</c>-ed subquery, so a huge table is never read in full.</summary>
    /// <exception cref="UnknownIdentifierException">No such database, table or column for this connection.</exception>
    public async Task<ColumnProfile> ProfileColumnAsync(
        ClickHouseConnectionInfo info, string database, string table, ProfileRequest req, CancellationToken ct)
    {
        var columns = await DescribeColumnsAsync(info, database, table, ct); // validates db + table
        var col = columns.FirstOrDefault(c => string.Equals(c.Name, req.Column, StringComparison.Ordinal))
                  ?? throw UnknownIdentifierException.Column(req.Column, database, table);
        var top = req.Limit ?? ApiLimits.DefaultProfileTop;

        using var httpClient = CreateHttpClient(info);
        await using var conn = new ClickHouseConnection(BuildConnectionString(info), httpClient);
        await conn.OpenAsync(ct);

        long rows, nulls, distinct; string? lo = null, hi = null;
        (rows, nulls, distinct, lo, hi) = await ReadProfileAsync(conn, info, BuildProfileStatsSql(database, table, col.Name, col.Category), async (r, token) =>
        {
            if (!await r.ReadAsync(token)) throw new InvalidOperationException("The profile query returned no row.");
            var n = Convert.ToInt64(r.GetValue(0), CultureInfo.InvariantCulture);
            var nl = Convert.ToInt64(r.GetValue(1), CultureInfo.InvariantCulture);
            var d = Convert.ToInt64(r.GetValue(2), CultureInfo.InvariantCulture);
            return r.FieldCount > 3
                ? (n, nl, d, ProfileExtreme(r.IsDBNull(3) ? null : r.GetValue(3)?.ToString(), n, nl), ProfileExtreme(r.IsDBNull(4) ? null : r.GetValue(4)?.ToString(), n, nl))
                : (n, nl, d, (string?)null, (string?)null);
        }, ct);

        var values = rows == 0 ? new List<ProfileValue>() : await ReadProfileAsync(conn, info, BuildProfileTopSql(database, table, col.Name, top), async (r, token) =>
        {
            var list = new List<ProfileValue>();
            while (await r.ReadAsync(token))
            {
                list.Add(new ProfileValue(r.IsDBNull(0) ? null : r.GetValue(0)?.ToString(),
                    Convert.ToInt64(r.GetValue(2), CultureInfo.InvariantCulture), Convert.ToInt64(r.GetValue(1), CultureInfo.InvariantCulture) != 0));
            }
            return list;
        }, ct);
        return new ColumnProfile(col.Name, col.Type, col.Category, rows, nulls, distinct, lo, hi, values,
            rows >= ApiLimits.ProfileSampleRows, ApiLimits.ProfileSampleRows);
    }

    /// <summary>Backstops for a profile statement: <c>max_rows_to_read</c> + <c>break</c> keeps the "first 1,000,000 rows" bound even
    /// where LIMIT is not pushed down (views, Merge / Distributed tables); the memory settings bound a wide-key GROUP BY.</summary>
    internal static readonly string ProfileSettings =
        $" SETTINGS max_rows_to_read = {ApiLimits.ProfileSampleRows}, read_overflow_mode = 'break', " +
        "max_bytes_before_external_group_by = 268435456, max_memory_usage = 2000000000";

    // Runs one profile statement with the backstop settings; a server that refuses them (settings constraints, read-only
    // account, unknown setting) gets the plain statement, as join_use_nulls does. The LIMIT-ed subquery still bounds the scan.
    private static async Task<T> ReadProfileAsync<T>(ClickHouseConnection conn, ClickHouseConnectionInfo info, string sql,
        Func<System.Data.Common.DbDataReader, CancellationToken, Task<T>> read, CancellationToken ct)
    {
        for (var withSettings = info.Guards != QueryGuards.None; ; withSettings = false)
        {
            try
            {
                await using var cmd = conn.CreateCommand();
                cmd.CommandText = withSettings ? sql + ProfileSettings : sql;
                await using var r = await cmd.ExecuteReaderAsync(ct);
                return await read(r, ct);
            }
            catch (ClickHouseServerException ex) when (withSettings && ex.ErrorCode is 115 or 164 or 452) { }
        }
    }


    // Compound and unclassified types are compared as text, so GROUP BY / ORDER BY / uniq work on any column.
    private static string ProfileSubquery(string database, string table, string column, string category)
    {
        var q = Identifier.Quote(column);
        var expr = category is ClickHouseType.Compound or ClickHouseType.Other ? $"toString({q})" : q;
        return $"(SELECT {expr} AS v FROM {Identifier.QualifiedName(database, table)} LIMIT {ApiLimits.ProfileSampleRows})";
    }

    /// <summary>Row, NULL and approximate distinct counts; min/max (as text) for numeric and date columns.</summary>
    internal static string BuildProfileStatsSql(string database, string table, string column, string category)
    {
        var extremes = category is ClickHouseType.Numeric or ClickHouseType.Temporal ? ", toString(min(v)) AS lo, toString(max(v)) AS hi" : "";
        return $"SELECT count() AS n, countIf(isNull(v)) AS nulls, uniq(v) AS d{extremes} FROM {ProfileSubquery(database, table, column, category)}";
    }

    /// <summary>The most frequent values, grouped on the label cut to 100 characters (<c>leftUTF8</c> — characters, not bytes) and a
    /// "was cut" flag (<c>lengthUTF8 &gt; 100</c>), so a huge string never becomes a group key: values differing only after
    /// character 100 count together. Ties break by label; NULL stays NULL (its own group, last among equals).</summary>
    internal static string BuildProfileTopSql(string database, string table, string column, int top)
    {
        var q = Identifier.Quote(column);
        return $"SELECT label, cut, count() AS cnt FROM (SELECT if(isNull({q}), NULL, leftUTF8(toString({q}), {ApiLimits.ProfileValueLength})) AS label, " +
               $"if(isNull({q}), 0, lengthUTF8(toString({q})) > {ApiLimits.ProfileValueLength}) AS cut " +
               $"FROM {Identifier.QualifiedName(database, table)} LIMIT {ApiLimits.ProfileSampleRows}) GROUP BY label, cut ORDER BY cnt DESC, label ASC, cut ASC LIMIT {top}";
    }

    /// <summary>An empty or all-NULL column has no min/max (ClickHouse returns 0 for a non-Nullable one).</summary>
    internal static string? ProfileExtreme(string? raw, long rows, long nulls) => rows == 0 || nulls >= rows ? null : raw;

    /// <summary>The newest day of one date / date-time column (null when empty or all NULL): the anchor for relative date ranges.
    /// One bounded read-only <c>max</c>; the connection's time limit and <c>readonly=2</c> apply.</summary>
    /// <exception cref="UnknownIdentifierException">No such database, table or column; or the column is not a date.</exception>
    public async Task<string?> LatestDayAsync(ClickHouseConnectionInfo info, string database, string table, string column, CancellationToken ct)
    {
        var columns = await DescribeColumnsAsync(info, database, table, ct); // validates db + table
        var col = columns.FirstOrDefault(c => string.Equals(c.Name, column, StringComparison.Ordinal))
                  ?? throw new UnknownIdentifierException("Unknown column.");
        if (col.Category != ClickHouseType.Temporal) throw new UnknownIdentifierException("Unknown date column.");
        using var httpClient = CreateHttpClient(info);
        await using var conn = new ClickHouseConnection(BuildConnectionString(info), httpClient);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = BuildLatestDaySql(database, table, col.Name);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct) && !r.IsDBNull(0) ? r.GetValue(0)?.ToString() : null;
    }

    internal static string BuildLatestDaySql(string database, string table, string column)
        => $"SELECT toString(toDate(maxOrNull({Identifier.Quote(column)}))) FROM {Identifier.QualifiedName(database, table)}";
}
