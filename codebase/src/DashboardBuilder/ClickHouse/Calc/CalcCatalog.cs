namespace DashboardBuilder.ClickHouse.Calc;

/// <summary>A calculation was rejected. <see cref="Exception.Message"/> is a plain sentence for the user;
/// <see cref="Path"/> locates the offending node relative to the tree root (dotted: <c>l</c>, <c>r</c>,
/// <c>arg</c>; <c>""</c> for the root).</summary>
public sealed class CalcException(string message, string path) : Exception(message)
{
    public string Path { get; } = path;
}

/// <summary>What a valid tree is: its result type (<c>number|text|date|boolean</c>), whether it contains an
/// aggregate, and the <c>"db.table"</c> tables its fields come from.</summary>
public sealed record CalcInfo(string Type, bool IsAggregate, IReadOnlySet<string> Tables);

/// <summary>Limits on a calculation. Mirrored in the client's <c>LIMITS</c>; over the limit is a 400, never clamped.</summary>
public static class CalcLimits
{
    public const int MaxFormula = 500;
    public const int MaxDepth = 12;
    public const int MaxNodes = 200;
    public const int MaxCalcs = 20;
    public const int MaxName = 60;
    public const int MaxString = 100;
}

/// <summary>The type of a calculation value.</summary>
public static class CalcType
{
    public const string Number = "number";
    public const string Text = "text";
    public const string Date = "date";
    public const string Boolean = "boolean";
}

/// <summary>One aggregate function: the argument types it accepts (in display order) and its result type
/// (<c>null</c> means the same type as the argument).</summary>
public sealed record AggSpec(IReadOnlyList<string> Accepts, string? Result);

/// <summary>The function table — the only place a function exists. Names are the lowercase wire names.</summary>
public static class CalcCatalog
{
    private static readonly string[] NumberOnly = [CalcType.Number];
    private static readonly string[] Orderable = [CalcType.Number, CalcType.Date, CalcType.Text];
    private static readonly string[] Anything = [CalcType.Number, CalcType.Date, CalcType.Text, CalcType.Boolean];

    public static readonly IReadOnlyDictionary<string, AggSpec> Aggregates = new Dictionary<string, AggSpec>(StringComparer.Ordinal)
    {
        ["sum"] = new(NumberOnly, CalcType.Number),
        ["avg"] = new(NumberOnly, CalcType.Number),
        ["min"] = new(Orderable, null),
        ["max"] = new(Orderable, null),
        ["count"] = new(Anything, CalcType.Number),
        ["countd"] = new(Anything, CalcType.Number),
    };

    /// <summary>E13: what a row-level calculation in a measure may be aggregated by (<c>count</c> of rows would ignore it).
    /// The single whitelist <see cref="DashboardBuilder.ClickHouse.RequestRules"/> and the gateway both use.</summary>
    public static readonly IReadOnlySet<string> RowLevelAggregations = new HashSet<string>(StringComparer.Ordinal)
        { "sum", "avg", "min", "max", "countdistinct", "countnonnull" };

    public static bool IsKnown(string fn) => Aggregates.ContainsKey(fn);
}
