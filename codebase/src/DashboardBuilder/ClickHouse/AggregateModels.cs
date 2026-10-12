namespace DashboardBuilder.ClickHouse;

/// <summary>One filter condition: <c>column op value</c>. The value is bound as a parameter.</summary>
public sealed record AggregateFilter(string Column, string Op, string Value);

/// <summary>
/// A chart's query plan (single-table, 2a): group by an optional <see cref="Dimension"/>, aggregate
/// a <see cref="Measure"/> with <see cref="Agg"/>, optionally filtered. Every column is validated
/// against the table's live catalog and quoted; agg/op come from whitelists; filter values are bound.
/// </summary>
public sealed record AggregateRequest(
    string? Dimension,
    string? Measure,
    string Agg,
    AggregateFilter[]? Filters,
    int? Limit);

/// <summary>One result row: the (optional) group label and the aggregated numeric value.</summary>
public sealed record AggregateRow(string? Label, double Value);

/// <summary>The chart data: aggregated rows.</summary>
public sealed record AggregateResult(IReadOnlyList<AggregateRow> Rows);
