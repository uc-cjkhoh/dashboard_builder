namespace DashboardBuilder.ClickHouse;

/// <summary>A column from <c>DESCRIBE</c>: raw ClickHouse type plus its display category.</summary>
public sealed record ColumnInfo(string Name, string Type, string Category);

