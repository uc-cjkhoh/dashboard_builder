namespace DashboardBuilder.ClickHouse;

/// <summary>A column profile request (POST /api/databases/{db}/tables/{table}/profile): one column, and how
/// many top values to return (default 10, max 50; out of range is rejected). <c>Source</c>: a custom SQL card's query (kind sql, for this very table),
/// read as a derived table instead of the catalog table.</summary>
public sealed record ProfileRequest(string Column, int? Limit, QuerySource? Source = null);

/// <summary>One frequent value: its text (null = SQL NULL; cut at 100 characters, <see cref="Cut"/> says so) and how many
/// of the profiled rows hold it.</summary>
public sealed record ProfileValue(string? Value, long Count, bool Cut);

/// <summary>
/// What one column holds, over the first <see cref="SampleLimit"/> rows of the table: <see cref="Rows"/> scanned,
/// <see cref="Nulls"/>, <see cref="Distinct"/> (approximate, non-null values), <see cref="Min"/>/<see cref="Max"/> (numeric and
/// date columns, as text) and the <see cref="Top"/> values by count. <see cref="Sampled"/>: the table has at least
/// <see cref="SampleLimit"/> rows, so the figures describe its first rows, not all of it.
/// </summary>
public sealed record ColumnProfile(
    string Column, string Type, string Category, long Rows, long Nulls, long Distinct,
    string? Min, string? Max, IReadOnlyList<ProfileValue> Top, bool Sampled, int SampleLimit);
