using System.Globalization;
using ClickHouse.Client.Utility;

namespace DashboardBuilder.ClickHouse;

/// <summary>One end of a relationship's key join: a column of a table.</summary>
public sealed record JoinKeyRef(string Db, string Table, string Column);

/// <summary><c>POST /api/relationships/preview</c>. <see cref="SampleLimit"/> bounds the rows read from EACH table (default and cap 1,000,000).</summary>
public sealed record JoinPreviewRequest(JoinKeyRef From, JoinKeyRef To, int? SampleLimit);

/// <summary>What one table's key looks like against the other table's key. Counts are over the rows examined
/// (<see cref="Rows"/>): NULL keys never match; <see cref="Keys"/> are the distinct non-NULL keys, of which
/// <see cref="MatchedKeys"/> (covering <see cref="MatchedRows"/> rows) occur on the other side.</summary>
public sealed record JoinSideStats(long Rows, long NullRows, long Keys, long MatchedKeys, long MatchedRows, long MaxDuplicates, double AvgDuplicates);

/// <summary><see cref="Sampled"/>: a side reached the row bound, so its numbers describe the first <see cref="SampleLimit"/> rows, not the table.</summary>
public sealed record JoinPreviewResult(JoinSideStats From, JoinSideStats To, int SampleLimit, bool Sampled);

/// <summary>Input rules for the join preview. Throws <see cref="RequestValidationException"/>; never clamps.</summary>
public static class JoinPreviewRules
{
    public const int MaxSampleRows = 1_000_000;

    public static int Bound(int? sampleLimit) => sampleLimit ?? MaxSampleRows;

    public static void Validate(JoinPreviewRequest r)
    {
        CheckEnd(r.From, "from");
        CheckEnd(r.To, "to");
        if (r.SampleLimit is { } n && (n < 1 || n > MaxSampleRows))
            throw new RequestValidationException($"Sample limit must be between 1 and {MaxSampleRows}.", "sampleLimit");
    }

    private static void CheckEnd(JoinKeyRef? e, string field)
    {
        if (e is null) throw new RequestValidationException($"'{field}' is required.", field);
        if (string.IsNullOrWhiteSpace(e.Db)) throw new RequestValidationException($"'{field}.db' is required.", $"{field}.db");
        if (string.IsNullOrWhiteSpace(e.Table)) throw new RequestValidationException($"'{field}.table' is required.", $"{field}.table");
        if (string.IsNullOrWhiteSpace(e.Column)) throw new RequestValidationException($"'{field}.column' is required.", $"{field}.column");
    }

    /// <summary>The relationship dialog's rule (relation-rules.js <c>keysCompatible</c>): only number-number, text-text, date-date and
    /// boolean-boolean keys relate; compound and other columns never do. Same wording as the client's toast.</summary>
    public static void CheckKinds(ColumnInfo from, ColumnInfo to, string fromLabel, string toLabel)
    {
        static bool Joinable(string c) => c is ClickHouseType.Numeric or ClickHouseType.Text or ClickHouseType.Temporal or ClickHouseType.Boolean;
        if (!Joinable(from.Category) || from.Category != to.Category)
            throw new RequestValidationException(
                $"Can't relate {fromLabel} ({from.Category}) to {toLabel} ({to.Category}) — join keys must hold the same kind of value.", "to.column");
    }
}

public sealed partial class ClickHouseGateway
{
    /// <summary>
    /// The join safety preview: how well one table's key column matches another's, from two bounded read-only SELECTs
    /// (one per side, run together). Each reads at most <c>sampleLimit</c> rows of each table — never a whole table. Database,
    /// table and column names are catalog-validated (<see cref="DescribeColumnsAsync"/>) and quoted; the key kinds must be
    /// joinable; the only literal is the validated integer bound. A purely logical estimate: it joins nothing and writes nothing.
    /// </summary>
    /// <exception cref="UnknownIdentifierException">Unknown database, table or column.</exception>
    /// <exception cref="RequestValidationException">Key kinds that can't be related.</exception>
    public async Task<JoinPreviewResult> JoinPreviewAsync(ClickHouseConnectionInfo info, JoinPreviewRequest req, CancellationToken ct)
    {
        var a = await FindKeyAsync(info, req.From, ct);
        var b = await FindKeyAsync(info, req.To, ct);
        JoinPreviewRules.CheckKinds(a, b, $"{req.From.Table}.{req.From.Column}", $"{req.To.Table}.{req.To.Column}");
        var n = JoinPreviewRules.Bound(req.SampleLimit);
        var text = a.Category == ClickHouseType.Text;
        var fromTask = JoinSideAsync(info, BuildJoinSideSql(req.From.Db, req.From.Table, req.From.Column, req.To.Db, req.To.Table, req.To.Column, n, text), ct);
        var toTask = JoinSideAsync(info, BuildJoinSideSql(req.To.Db, req.To.Table, req.To.Column, req.From.Db, req.From.Table, req.From.Column, n, text), ct);
        var (from, to) = (await fromTask, await toTask);
        return new JoinPreviewResult(from, to, n, from.Rows >= n || to.Rows >= n);
    }

    private async Task<ColumnInfo> FindKeyAsync(ClickHouseConnectionInfo info, JoinKeyRef e, CancellationToken ct)
    {
        var cols = await DescribeColumnsAsync(info, e.Db, e.Table, ct); // validates db + table
        return cols.FirstOrDefault(c => string.Equals(c.Name, e.Column, StringComparison.Ordinal))
               ?? throw new UnknownIdentifierException("Unknown column.");
    }

    /// <summary>
    /// One side of the preview. Reads the first <paramref name="n"/> rows of the table's key, groups them by key (NULL is its own
    /// group), and from the groups reads: rows, NULL rows, distinct non-NULL keys, the most any key repeats, and how many keys /
    /// rows have a key present in the other table's first <paramref name="n"/> rows (NULLs never match). Names are quoted by
    /// <see cref="Identifier"/>; text keys compare as strings so UUID/Enum/FixedString mixes still match.
    /// </summary>
    internal static string BuildJoinSideSql(string db, string table, string column, string otherDb, string otherTable, string otherColumn, int n, bool textKeys)
    {
        if (n < 1 || n > JoinPreviewRules.MaxSampleRows) throw new ArgumentOutOfRangeException(nameof(n));
        static string Keys(string d, string t, string c, int n, bool text)
            => $"SELECT {(text ? $"toString({Identifier.Quote(c)})" : Identifier.Quote(c))} AS k FROM {Identifier.QualifiedName(d, t)} LIMIT {n.ToString(CultureInfo.InvariantCulture)}";
        var other = $"(SELECT k FROM ({Keys(otherDb, otherTable, otherColumn, n, textKeys)}) WHERE isNotNull(k))";
        return "SELECT sum(cnt), sumIf(cnt, isNull(k)), countIf(isNotNull(k)), maxIf(cnt, isNotNull(k)), " +
               $"sumIf(cnt, isNotNull(k) AND k IN {other}), countIf(isNotNull(k) AND k IN {other}) " +
               $"FROM (SELECT k, count() AS cnt FROM ({Keys(db, table, column, n, textKeys)}) GROUP BY k)";
    }

    private async Task<JoinSideStats> JoinSideAsync(ClickHouseConnectionInfo info, string sql, CancellationToken ct)
    {
        await using var conn = await OpenAsync(info, ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return new JoinSideStats(0, 0, 0, 0, 0, 0, 0);
        long L(int i) => reader.IsDBNull(i) ? 0 : Convert.ToInt64(reader.GetValue(i), CultureInfo.InvariantCulture);
        long rows = L(0), nulls = L(1), keys = L(2);
        var avg = keys > 0 ? Math.Round((double)(rows - nulls) / keys, 2) : 0;
        return new JoinSideStats(rows, nulls, keys, L(5), L(4), L(3), avg);
    }
}
