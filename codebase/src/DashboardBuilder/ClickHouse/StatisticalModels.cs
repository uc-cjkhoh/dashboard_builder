namespace DashboardBuilder.ClickHouse;

/// <summary>
/// A histogram plan (P12 — new bucketing query shape): bucket a single numeric <see cref="Column"/>
/// into <see cref="Buckets"/> equal-width bins over its [min,max] range and count rows per bin.
/// Single-table (a distribution is one column); every identifier is catalog-validated and quoted,
/// the bucket count is clamped, and filter values are bound as typed parameters.
/// </summary>
public sealed record HistogramRequest(
    string Column,
    int? Buckets,
    StatFilter[]? Filters);

/// <summary>A filter on a stat chart's source table: scalar <see cref="Value"/>, or <see cref="Values"/> for <c>in</c>/<c>between</c>.</summary>
public sealed record StatFilter(string Column, string Op, string? Value, string[]? Values = null);

/// <summary>One histogram bin: the half-open range <c>[X0, X1)</c> and how many rows fell in it.</summary>
public sealed record HistogramBin(double X0, double X1, long Count);

/// <summary>The histogram data: bins in ascending range order.</summary>
public sealed record HistogramResult(IReadOnlyList<HistogramBin> Bins);

/// <summary>
/// A box-plot plan (P12 — new quantile query shape): the five-number summary
/// (min, Q1, median, Q3, max) of a numeric <see cref="Measure"/>, optionally grouped by a
/// <see cref="Dimension"/>. Single-table; identifiers validated + quoted; row count bounded;
/// filter values bound.
/// </summary>
public sealed record BoxPlotRequest(
    string? Dimension,
    string Measure,
    StatFilter[]? Filters,
    int? Limit);

/// <summary>One box: the (optional) group label and its five-number summary.</summary>
/// <remarks><see cref="LowerWhisker"/>/<see cref="UpperWhisker"/> are the extreme values inside the Tukey fences
/// (Q1 - 1.5 IQR, Q3 + 1.5 IQR); <see cref="Min"/>/<see cref="Max"/> stay the true extremes.</remarks>
public sealed record BoxPlotGroup(string? Label, double Min, double Q1, double Median, double Q3, double Max, double LowerWhisker, double UpperWhisker);

/// <summary>One outlier point: a value beyond its group's Tukey fences.</summary>
public sealed record BoxPlotOutlier(string? Label, double Value);

/// <summary>The box-plot data: one box per group.</summary>
/// <remarks><see cref="Truncated"/> is true when more groups exist beyond the limit; <see cref="OutliersTruncated"/>
/// when more than <c>ApiLimits.MaxBoxOutliers</c> outlier points exist.</remarks>
public sealed record BoxPlotResult(IReadOnlyList<BoxPlotGroup> Groups, bool Truncated = false,
    IReadOnlyList<BoxPlotOutlier>? Outliers = null, bool OutliersTruncated = false);

/// <summary>
/// A raw-row read of ONE table (POST /api/rows): the first <see cref="Limit"/> rows (default 100, max 1000) of
/// the optional <see cref="Columns"/> (default: the table's first 200), narrowed by <see cref="Filters"/>.
/// No ordering, no aggregation. Identifiers are catalog-validated and quoted; filter values are bound.
/// </summary>
public sealed record RowsRequest(string Db, string Table, string[]? Columns, StatFilter[]? Filters, int? Limit);

/// <summary>A returned column: its name and raw ClickHouse type.</summary>
public sealed record RowColumn(string Name, string Type);

/// <summary>Rows as display text (null = SQL NULL, each cell cut at <see cref="ApiLimits.MaxCellLength"/> characters).
/// <see cref="Truncated"/>: more rows matched than <see cref="Limit"/>; <see cref="ColumnsTruncated"/>: the table has
/// more columns than were returned.</summary>
public sealed record RowsResult(
    IReadOnlyList<RowColumn> Columns, IReadOnlyList<IReadOnlyList<string?>> Rows,
    bool Truncated, int Limit, bool ColumnsTruncated);

/// <summary>
/// A bounded UNION ALL of 2..5 tables of one database (POST /api/union): the first <see cref="Limit"/> rows (default
/// 100, max 1000) of the stacked tables, over <see cref="Columns"/> (default: every column all tables share by name
/// and kind). The result's first column is the source table. No ordering. Identifiers are catalog-validated and quoted.
/// </summary>
public sealed record UnionRequest(string Db, string[] Tables, string[]? Columns, int? Limit);
