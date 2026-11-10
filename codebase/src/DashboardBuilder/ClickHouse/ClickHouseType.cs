namespace DashboardBuilder.ClickHouse;

/// <summary>
/// Reduces a ClickHouse type string to a coarse **display category** for the entity card's type
/// badge and grid alignment. ClickHouse types are not SQL-92 (CLAUDE.md gotcha): expect wrappers
/// like <c>Nullable(...)</c> / <c>LowCardinality(...)</c> and rich types like <c>Decimal(18,4)</c>,
/// <c>Array(UInt64)</c>, <c>DateTime64(3)</c>, <c>Enum8('a'=1)</c>.
/// </summary>
public static class ClickHouseType
{
    public const string Numeric = "numeric";
    public const string Text = "text";
    public const string Temporal = "temporal";
    public const string Boolean = "boolean";
    public const string Compound = "compound";
    public const string Other = "other";

    /// <summary>Display category. Unwraps <c>Nullable(...)</c> / <c>LowCardinality(...)</c> first.</summary>
    public static string Categorize(string? type)
    {
        var name = BaseName(Unwrap(type ?? string.Empty));
        if (name.Length == 0) return Other;

        if (name is "Bool" or "Boolean") return Boolean;
        if (name.StartsWith("UInt", StringComparison.Ordinal)
            || name.StartsWith("Int", StringComparison.Ordinal)
            || name.StartsWith("Float", StringComparison.Ordinal)
            || name.StartsWith("Decimal", StringComparison.Ordinal))
            return Numeric;
        if (name is "Date" or "Date32" or "DateTime" or "DateTime64") return Temporal;
        if (name is "Array" or "Map" or "Tuple" or "Nested") return Compound;
        if (name is "String" or "FixedString" or "UUID" or "IPv4" or "IPv6"
            || name.StartsWith("Enum", StringComparison.Ordinal))
            return Text;
        return Other;
    }

    /// <summary>True for the integer types (<c>Int*</c>/<c>UInt*</c>, under Nullable/LowCardinality) — a column whose values are whole numbers.</summary>
    public static bool IsWholeNumber(string? type)
    {
        var name = BaseName(Unwrap(type ?? string.Empty));
        return name.StartsWith("UInt", StringComparison.Ordinal) || (name.StartsWith("Int", StringComparison.Ordinal) && !name.StartsWith("Interval", StringComparison.Ordinal));
    }

    /// <summary>True for <c>Date</c>/<c>Date32</c> (after unwrapping Nullable/LowCardinality) — columns that hold no time of day.</summary>
    public static bool IsDateOnly(string? type) => BaseName(Unwrap(type ?? string.Empty)) is "Date" or "Date32";

    /// <summary>The type without its outer <c>Nullable(...)</c> / <c>LowCardinality(...)</c> wrappers.</summary>
    public static string BaseType(string? type) => Unwrap(type ?? string.Empty);

    /// <summary>True when the type is wrapped in <c>Nullable(...)</c> (under any <c>LowCardinality</c>).</summary>
    public static bool IsNullable(string? type)
    {
        var t = (type ?? string.Empty).Trim();
        while (TryUnwrap(t, "Nullable", out var inner) || TryUnwrap(t, "LowCardinality", out inner))
        {
            if (t.StartsWith("Nullable(", StringComparison.Ordinal)) return true;
            t = inner;
        }
        return false;
    }

    // Strip outer Nullable(...) / LowCardinality(...) wrappers, possibly nested.
    private static string Unwrap(string type)
    {
        var t = type.Trim();
        while (TryUnwrap(t, "Nullable", out var inner) || TryUnwrap(t, "LowCardinality", out inner))
            t = inner;
        return t;
    }

    private static bool TryUnwrap(string t, string wrapper, out string inner)
    {
        inner = t;
        if (t.StartsWith(wrapper + "(", StringComparison.Ordinal) && t.EndsWith(")", StringComparison.Ordinal))
        {
            inner = t.Substring(wrapper.Length + 1, t.Length - wrapper.Length - 2).Trim();
            return true;
        }
        return false;
    }

    // Base type name = text before the first '(' — "Decimal(18,4)" → "Decimal".
    private static string BaseName(string type)
    {
        var paren = type.IndexOf('(');
        return (paren >= 0 ? type[..paren] : type).Trim();
    }
}
