using System.Globalization;
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
                  ?? throw new UnknownIdentifierException("Unknown column.");
        var top = req.Limit ?? ApiLimits.DefaultProfileTop;

        using var httpClient = CreateHttpClient(info);
        await using var conn = new ClickHouseConnection(BuildConnectionString(info), httpClient);
        await conn.OpenAsync(ct);

        long rows, nulls, distinct; string? lo = null, hi = null;
        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = BuildProfileStatsSql(database, table, col.Name, col.Category);
            await using var r = await cmd.ExecuteReaderAsync(ct);
            if (!await r.ReadAsync(ct)) throw new InvalidOperationException("The profile query returned no row.");
            rows = Convert.ToInt64(r.GetValue(0), CultureInfo.InvariantCulture);
            nulls = Convert.ToInt64(r.GetValue(1), CultureInfo.InvariantCulture);
            distinct = Convert.ToInt64(r.GetValue(2), CultureInfo.InvariantCulture);
            if (r.FieldCount > 3)
            {
                lo = ProfileExtreme(r.IsDBNull(3) ? null : r.GetValue(3)?.ToString(), rows, nulls);
                hi = ProfileExtreme(r.IsDBNull(4) ? null : r.GetValue(4)?.ToString(), rows, nulls);
            }
        }

        var values = new List<ProfileValue>();
        if (rows > 0)
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = BuildProfileTopSql(database, table, col.Name, col.Category, top);
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
            {
                var (text, cut) = CutProfileValue(r.IsDBNull(0) ? null : r.GetValue(0)?.ToString());
                values.Add(new ProfileValue(text, Convert.ToInt64(r.GetValue(1), CultureInfo.InvariantCulture), cut));
            }
        }
        return new ColumnProfile(col.Name, col.Type, col.Category, rows, nulls, distinct, lo, hi, values,
            rows >= ApiLimits.ProfileSampleRows, ApiLimits.ProfileSampleRows);
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

    /// <summary>The most frequent values (ties broken by value), cut in SQL one character past the display limit; NULL stays NULL.</summary>
    internal static string BuildProfileTopSql(string database, string table, string column, string category, int top)
        => $"SELECT if(isNull(v), NULL, left(toString(v), {ApiLimits.ProfileValueLength + 1})) AS label, count() AS cnt " +
           $"FROM {ProfileSubquery(database, table, column, category)} GROUP BY v ORDER BY cnt DESC, v ASC LIMIT {top}";

    /// <summary>A value of at most 100 characters, and whether it was cut (never splits a surrogate pair).</summary>
    internal static (string? Text, bool Cut) CutProfileValue(string? s)
    {
        if (s is null || s.Length <= ApiLimits.ProfileValueLength) return (s, false);
        var n = char.IsHighSurrogate(s[ApiLimits.ProfileValueLength - 1]) ? ApiLimits.ProfileValueLength - 1 : ApiLimits.ProfileValueLength;
        return (s[..n], true);
    }

    /// <summary>An empty or all-NULL column has no min/max (ClickHouse returns 0 for a non-Nullable one).</summary>
    internal static string? ProfileExtreme(string? raw, long rows, long nulls) => rows == 0 || nulls >= rows ? null : raw;
}
