using DashboardBuilder.ClickHouse.Calc;

namespace DashboardBuilder.ClickHouse;

public sealed record TableRef(string Db, string Table);

/// <summary>A column on a specific table.</summary>
/// <summary>A column on a specific table. On a worksheet dimension, <see cref="DatePart"/> groups a
/// date/time column by a calendar part — a whitelisted function, never user text. When <see cref="Calc"/>
/// is set (calculated dimension) the tree replaces Db/Table/Column, and <see cref="Column"/> is only a
/// display label (≤ 60 characters, never used in SQL) echoed in the result. <see cref="Cast"/> (text, number
/// or date) reads a plain column as that type — a whitelisted conversion, NULL where a value doesn't fit.</summary>
public sealed record ColumnRef(string Db, string Table, string Column, string? DatePart = null, ExprNode? Calc = null, string? Cast = null);

/// <summary>A join edge: <c>left.column = right.column</c>. <c>Left</c> must already be in the query.</summary>
/// <summary><see cref="Type"/> is "inner" (default), "left", "right" or "full" — a whitelisted keyword, never user text.
/// <see cref="Pairs"/> are extra column pairs on the same two tables (a compound key): the ON clause ANDs them with Left = Right.</summary>
public sealed record JoinRef(ColumnRef Left, ColumnRef Right, string? Type = null, JoinColumnPair[]? Pairs = null);

/// <summary>One extra key pair of a compound join: a column of the left table and a column of the right table (names, validated against the catalog).</summary>
public sealed record JoinColumnPair(string Left, string Right);

/// <summary>A measure column + its aggregation. When <see cref="Calc"/> is set (calculated measure) the
/// tree replaces Db/Table/Column/Agg, and <see cref="Column"/> is only a display label echoed in the result.
/// <see cref="Agg"/> is nullable on the wire because an aggregate calculation carries none; a plain measure
/// without one is rejected by <c>RequestRules</c> ("'measures[i].agg' is required."). <see cref="P"/> is the
/// percentile fraction (0..1): required exactly when <see cref="Agg"/> is <c>percentile</c>, rejected otherwise;
/// it reaches SQL only as a bound <c>Float64</c> parameter.</summary>
public sealed record MeasureRef(string Db, string Table, string Column, string? Agg, ExprNode? Calc = null, string? Cast = null, double? P = null);

/// <summary>
/// A filter condition on a column. For the scalar operators (<c>= != &lt; &lt;= &gt; &gt;=</c>)
/// the single <see cref="Value"/> is bound. For <c>in</c> (multi-select) and <c>between</c> (range)
/// the <see cref="Values"/> list is bound instead — as an <c>Array(...)</c> for <c>in</c>, or as two
/// bounds for <c>between</c>. Values are always bound as parameters, never interpolated.
/// </summary>
public sealed record QueryFilter(
    string Db, string Table, string Column, string Op, string? Value, string[]? Values = null,
    // "top": keep the Value (1–1000) members of this column ranked by TopBy (highest, or lowest when Bottom).
    MeasureRef? TopBy = null, bool? Bottom = null,
    // Read the column as text, number or date (whitelisted <see cref="TypeCast"/>) before comparing.
    string? Cast = null,
    // A calculated field as the filtered expression (row-level only; Db / Table are empty, Column is its label). Never a top-N.
    ExprNode? Calc = null);

/// <summary>
/// A worksheet query that may span several related tables. <see cref="From"/> is the base table;
/// each <see cref="Joins"/> edge attaches a new table via a relationship's join keys. Dimensions are
/// split by shelf into <see cref="RowDimensions"/> (Rows shelf → the crosstab's left stub) and
/// <see cref="ColumnDimensions"/> (Columns shelf → the top header); <see cref="Measures"/> are the
/// aggregated cell values (from either shelf — which shelf drives table layout, not the SQL). The
/// server groups by every dimension (rows first, then columns) so keys arrive as
/// <c>[rowDim…, colDim…]</c>; the client pivots. Every identifier is validated against the live
/// catalog and quoted; aggregations/operators are whitelisted; filter values are bound.
/// </summary>
public sealed record QueryRequest(
    TableRef From,
    JoinRef[]? Joins,
    ColumnRef[]? RowDimensions,
    ColumnRef[]? ColumnDimensions,
    MeasureRef[]? Measures,
    QueryFilter[]? Filters,
    int? Limit,
    // How to order the grouped rows. <see cref="SortRef.Column"/> is a generated select alias
    // (k0,k1,… for dimensions in key order, v0,v1,… for measures); the server validates it and
    // always appends the remaining dimension keys ascending so the crosstab layout stays stable.
    // When absent, the default is ascending by the first dimension (or the first measure if none).
    SortRef? Sort,
    // Table paging: skip this many groups (ordered as above), so a long result loads a page at a time.
    int? Offset = null,
    // Also count every group the query would return (QueryResult.Total) — the table's "of N rows".
    bool? WithTotal = null,
    // One dimension + a truncated result → also aggregate everything past the limit as "Other".
    bool? OtherBucket = null,
    // Group the first date/time dimension by a calendar grain: hour, day, week, month, quarter, year,
    // or "auto" (exact when it has ≤ 500 distinct values, else the finest grain with ≤ 500 buckets).
    string? DateBucket = null,
    // Skip the server's result cache (Refresh) — the fresh result replaces the cached one.
    bool? Fresh = null,
    // Approximate mode — distinct counts estimated (uniq), and a 10% sample on a table with a sampling key.
    bool? Approximate = null,
    // A union / unpivot the query reads instead of a catalog table (<see cref="SourceSql"/>): From, and every field
    // reference, name it as (Source.Db, Source.Name). It takes no joins.
    QuerySource? Source = null,
    // A filter on aggregated measures (SQL HAVING): keeps the groups whose measure value passes. Each entry names a
    // measure by its position in Measures; see <see cref="HavingFilter"/>.
    HavingFilter[]? Having = null);

/// <summary>A condition on one aggregated measure of the same request, applied to each group after grouping (HAVING).
/// <see cref="Measure"/> is the index into <see cref="QueryRequest.Measures"/> (0 for the implicit count when there are none);
/// <see cref="Op"/> is one of <c>= != &gt; &gt;= &lt; &lt;= between</c> (whitelisted, never text); the numbers are bound as Float64
/// parameters — a single <see cref="Value"/>, or <see cref="Values"/> [from, to] for <c>between</c>. Never an identifier, never SQL.</summary>
public sealed record HavingFilter(int Measure, string Op, string? Value, string[]? Values = null);

/// <summary>Ordering spec: which select alias (<c>k{n}</c>/<c>v{n}</c>) to sort by, and direction.</summary>
public sealed record SortRef(string Column, bool Desc);

/// <summary>One grouped row: the dimension key labels in <c>[rowDim…, colDim…]</c> order, then an
/// aggregated value per measure (in request order).</summary>
public sealed record QueryResultRow(IReadOnlyList<string?> Keys, IReadOnlyList<object?> Values);

/// <summary>
/// A worksheet result. <see cref="RowDimensions"/> and <see cref="ColumnDimensions"/> name the group
/// keys (in the same order they appear in each <see cref="QueryResultRow.Keys"/>: row keys first,
/// then column keys); <see cref="Measures"/> names the aggregated values. When the request carries no
/// measures an implicit <c>count</c> is added so every view has a value. The client pivots these flat
/// grouped rows into the Rows×Columns crosstab.
/// </summary>
public sealed record QueryResult(
    IReadOnlyList<string> RowDimensions,
    IReadOnlyList<string> ColumnDimensions,
    IReadOnlyList<string> Measures,
    IReadOnlyList<QueryResultRow> Rows,
    // True when more groups exist beyond the limit — the client shows a "showing first N" notice.
    bool Truncated = false,
    // Every group the query would return, when WithTotal was asked.
    long? Total = null,
    // Everything past the limit, aggregated (OtherBucket on a truncated one-dimension result).
    OtherGroup? Other = null,
    // The calendar grain applied to a date/time dimension, when DateBucket grouped one.
    DateBucketApplied? Bucket = null,
    // Served from the server's short-lived result cache.
    bool Cached = false,
    // What approximate mode did (null = exact).
    ApproxApplied? Approx = null);

/// <summary>Approximate mode: distinct counts estimated, and the sample fraction when one was read.</summary>
public sealed record ApproxApplied(bool Distinct, double? Sample);

/// <summary>The groups past the limit: how many, and each measure aggregated over all of them.</summary>
public sealed record OtherGroup(long Groups, IReadOnlyList<object?> Values);

/// <summary>Which group key (<c>k{Key}</c>) was bucketed, and to which grain.</summary>
public sealed record DateBucketApplied(int Key, string Grain);
