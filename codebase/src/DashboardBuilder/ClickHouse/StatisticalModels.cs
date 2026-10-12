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
public sealed record BoxPlotGroup(string? Label, double Min, double Q1, double Median, double Q3, double Max);

/// <summary>The box-plot data: one box per group.</summary>
/// <remarks><see cref="Truncated"/> is true when more groups exist beyond the limit.</remarks>
public sealed record BoxPlotResult(IReadOnlyList<BoxPlotGroup> Groups, bool Truncated = false);
