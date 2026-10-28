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
    /// <summary>The largest whole number a text function's length or position (<c>LEFT</c>, <c>RIGHT</c>, <c>SPLIT</c>) may be.</summary>
    public const int MaxCount = 1000;
    /// <summary>The longest <c>SPLIT</c> separator, in characters.</summary>
    public const int MaxSeparator = 20;
    /// <summary>The most arguments <c>CONCAT</c> takes.</summary>
    public const int MaxConcat = 10;
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
/// (<c>null</c> means the same type as the argument).
/// <c>Fraction</c>: the function takes a literal 0..1 fraction (<see cref="AggNode.P"/>) after its argument.</summary>
public sealed record AggSpec(IReadOnlyList<string> Accepts, string? Result, bool Fraction = false);

/// <summary>What a row-level function argument must be. <c>Text</c>: any text expression. <c>Length</c>: a whole number
/// literal 0..<see cref="CalcLimits.MaxCount"/>. <c>Position</c>: a whole number literal 1..<see cref="CalcLimits.MaxCount"/>.
/// <c>Separator</c>: a non-empty text literal of at most <see cref="CalcLimits.MaxSeparator"/> characters.</summary>
public enum FnArg { Text, Length, Position, Separator }

/// <summary>One row-level function: its arguments in order and its result type. <c>MaxArgs</c> above <c>Args.Count</c> lets
/// the last argument kind repeat (<c>CONCAT</c>).</summary>
public sealed record FnSpec(IReadOnlyList<FnArg> Args, string Result, int MaxArgs = 0)
{
    public int Max => Math.Max(MaxArgs, Args.Count);
}

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
        ["median"] = new(NumberOnly, CalcType.Number),
        ["stddev"] = new(NumberOnly, CalcType.Number),
        ["variance"] = new(NumberOnly, CalcType.Number),
        ["percentile"] = new(NumberOnly, CalcType.Number, Fraction: true),
        ["attr"] = new(Anything, null),
    };

    private static FnSpec Fn(string result, params FnArg[] args) => new(args, result);

    /// <summary>The row-level text functions (<c>FnNode</c>). Names are the lowercase wire names. Written with <c>Fn(</c>, not <c>new(</c>,
    /// so the aggregate-table check in <c>calc-limits.test.mjs</c> does not mistake them for aggregates.</summary>
    public static readonly IReadOnlyDictionary<string, FnSpec> RowFunctions = new Dictionary<string, FnSpec>(StringComparer.Ordinal)
    {
        ["lower"] = Fn(CalcType.Text, FnArg.Text),
        ["upper"] = Fn(CalcType.Text, FnArg.Text),
        ["trim"] = Fn(CalcType.Text, FnArg.Text),
        ["len"] = Fn(CalcType.Number, FnArg.Text),
        ["left"] = Fn(CalcType.Text, FnArg.Text, FnArg.Length),
        ["right"] = Fn(CalcType.Text, FnArg.Text, FnArg.Length),
        ["replace"] = Fn(CalcType.Text, FnArg.Text, FnArg.Text, FnArg.Text),
        ["concat"] = new FnSpec([FnArg.Text, FnArg.Text], CalcType.Text, CalcLimits.MaxConcat),
        ["contains"] = Fn(CalcType.Boolean, FnArg.Text, FnArg.Text),
        ["startswith"] = Fn(CalcType.Boolean, FnArg.Text, FnArg.Text),
        ["endswith"] = Fn(CalcType.Boolean, FnArg.Text, FnArg.Text),
        ["split"] = Fn(CalcType.Text, FnArg.Text, FnArg.Separator, FnArg.Position),
    };

    /// <summary>E13: what a row-level calculation in a measure may be aggregated by (<c>count</c> of rows would ignore it).
    /// The single whitelist <see cref="DashboardBuilder.ClickHouse.RequestRules"/> and the gateway both use.</summary>
    public static readonly IReadOnlySet<string> RowLevelAggregations = new HashSet<string>(StringComparer.Ordinal)
        { "sum", "avg", "min", "max", "countdistinct", "countnonnull", "median", "stddev", "variance", "attr" };

    /// <summary>The rejection text for a row-level calculation with no (or an unknown) aggregation; lists <see cref="RowLevelAggregations"/>.</summary>
    public const string RowLevelHint = "Choose how to aggregate this calculation: sum, average, min, max, median, standard deviation, variance, ATTR, distinct count or non-null count.";

    public static bool IsKnown(string fn) => Aggregates.ContainsKey(fn);
}
