namespace DashboardBuilder.ClickHouse;

/// <summary>
/// T02-34 display type cast: a column read as text, number or date. The target is a whitelisted word
/// (never user text); the SQL is a fixed ClickHouse conversion wrapped around an already catalog-validated,
/// quoted column expression. Every conversion is an <c>OrNull</c> variant, so a value that doesn't fit
/// becomes NULL rather than failing the query. Mirrored client-side in Dashboard/cast-model.js.
/// </summary>
public static class TypeCast
{
    public const string Text = "text", Number = "number", Date = "date";
    public static readonly IReadOnlySet<string> Casts = new HashSet<string>(StringComparer.Ordinal) { Text, Number, Date };

    public const string UnknownMessage = "Data type must be text, number or date.";
    public const string CalcMessage = "A calculation has its own type — it can't be cast.";

    /// <summary>The column category the cast produces (what role, aggregation and filter operators follow).</summary>
    public static string TargetCategory(string cast) => cast switch
    {
        Text => ClickHouseType.Text,
        Number => ClickHouseType.Numeric,
        Date => ClickHouseType.Temporal,
        _ => throw new RequestValidationException(UnknownMessage, "cast"),
    };

    /// <summary>The category a column has once cast (the column's own when there is no cast).</summary>
    public static string EffectiveCategory(string category, string? cast) => cast is null ? category : TargetCategory(cast);

    /// <summary>
    /// The whitelisted conversion of <paramref name="expr"/> (a quoted column) from <paramref name="category"/>
    /// to <paramref name="cast"/>; the expression unchanged when there is no cast or the type already fits.
    /// A pairing with no safe conversion (number or date to date, date to number) is a 400.
    /// </summary>
    public static string Apply(string? cast, string expr, string category, string column, string field)
    {
        if (cast is null) return expr;
        if (!Casts.Contains(cast)) throw new RequestValidationException(UnknownMessage, field);
        return (cast, category) switch
        {
            (Text, ClickHouseType.Text) => expr,
            (Text, _) => $"toString({expr})",
            (Number, ClickHouseType.Numeric) => expr,
            (Number, ClickHouseType.Text) => $"toFloat64OrNull(toString({expr}))",
            (Number, ClickHouseType.Boolean) => $"toFloat64({expr})",
            (Date, ClickHouseType.Temporal) => expr,
            (Date, ClickHouseType.Text) => $"parseDateTimeBestEffortOrNull(toString({expr}))",
            _ => throw new RequestValidationException($"{column} is {category} and can't be read as {cast}.", field),
        };
    }

    /// <summary>A cast column is never a Date/Date32 (a date cast yields a date-time), so date-only handling is off.</summary>
    public static bool DateOnly(string? cast, bool raw) => cast is null && raw;
}
