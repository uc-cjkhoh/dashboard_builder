namespace DashboardBuilder.ClickHouse;

/// <summary>A column from <c>DESCRIBE</c>: raw ClickHouse type plus its display category.</summary>
public sealed record ColumnInfo(string Name, string Type, string Category);

/// <summary>A bounded row preview: the column names and the sampled rows (cells as display strings).</summary>
public sealed record PreviewResult(IReadOnlyList<string> Columns, IReadOnlyList<object?[]> Rows);
