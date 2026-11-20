namespace DashboardBuilder.ClickHouse;

/// <summary>A column profile request (POST /api/databases/{db}/tables/{table}/profile): one column, and how
/// many top values to return (default 10, max 50; out of range is rejected). <c>Source</c>: a custom SQL card's query (kind sql, for this very table),
/// read as a derived table instead of the catalog table.</summary>
public sealed record ProfileRequest(string Column, int? Limit, QuerySource? Source = null);

/// <summary>One frequent value: its text (null = SQL NULL; cut at 100 characters, <see cref="Cut"/> says so) and how many
/// of the profiled rows hold it.</summary>
public sealed record ProfileValue(string? Value, long Count, bool Cut);

/// <summary>The numeric summary of a numeric column (null on any other): mean and sample standard deviation over every non-null row,
/// and the quartiles (<c>quantile</c>, approximate, the function the box plot uses). A figure ClickHouse cannot give (one row has no
/// standard deviation; NaN / infinity) is null.</summary>
public sealed record NumericSummary(double? Mean, double? StdDev, double? Q1, double? Median, double? Q3);

/// <summary>
/// What one column holds, over every row of the table: <see cref="Rows"/> scanned,
/// <see cref="Nulls"/>, <see cref="Distinct"/> (approximate, non-null values), <see cref="Min"/>/<see cref="Max"/> (numeric and
/// date columns, as text), the <see cref="Summary"/> (numeric columns only) and the <see cref="Top"/> values by count.
/// </summary>
public sealed record ColumnProfile(
    string Column, string Type, string Category, long Rows, long Nulls, long Distinct,
    string? Min, string? Max, IReadOnlyList<ProfileValue> Top, NumericSummary? Summary = null);
