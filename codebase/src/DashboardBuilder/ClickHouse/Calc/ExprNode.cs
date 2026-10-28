using System.Text.Json;
using System.Text.Json.Serialization;

namespace DashboardBuilder.ClickHouse.Calc;

/// <summary>
/// A calculated-field expression tree as it arrives on the wire. The browser parses the formula and
/// sends this tree; no formula text ever reaches SQL. The JSON discriminator <c>k</c> is one of
/// <c>field | num | un | bin | agg</c>; an unknown or missing <c>k</c>, a missing or wrongly typed
/// member, or a non-finite number fails deserialisation with a <see cref="JsonException"/> (a 400).
/// Operators and function names are plain strings here — the validator whitelists them.
/// </summary>
[JsonConverter(typeof(ExprNodeConverter))]
public abstract record ExprNode;

/// <summary>A column reference; validated against the live catalog before use.</summary>
public sealed record FieldNode(string Db, string Table, string Column) : ExprNode;

/// <summary>A numeric literal; always bound as a parameter.</summary>
public sealed record NumNode(double V) : ExprNode;

/// <summary>A unary operation (e.g. negation).</summary>
public sealed record UnNode(string Op, ExprNode Arg) : ExprNode;

/// <summary>A binary operation (arithmetic, comparison or logic).</summary>
public sealed record BinNode(string Op, ExprNode L, ExprNode R) : ExprNode;

/// <summary>An aggregate function (e.g. <c>sum</c>) over a sub-expression. <see cref="P"/> is the fraction a
/// parametric aggregate takes (<c>percentile</c>: 0..1, always bound as a parameter); absent for every other function.</summary>
public sealed record AggNode(string Fn, ExprNode Arg, double? P = null) : ExprNode;

/// <summary>
/// Reads and writes <see cref="ExprNode"/> by its <c>k</c> discriminator. Hand-written (rather than
/// <c>[JsonPolymorphic]</c>) because the built-in handling throws <see cref="NotSupportedException"/>
/// — a 500 — when <c>k</c> is absent; here every malformed node is a <see cref="JsonException"/>.
/// Recursion depth is bounded by the serializer's own <c>MaxDepth</c> while the element is parsed.
/// </summary>
public sealed class ExprNodeConverter : JsonConverter<ExprNode>
{
    public override ExprNode? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return null;
        using var doc = JsonDocument.ParseValue(ref reader);
        return Build(doc.RootElement);
    }

    private static ExprNode Build(JsonElement e)
    {
        if (e.ValueKind != JsonValueKind.Object) throw new JsonException("Expression node must be an object.");
        return Text(e, "k") switch
        {
            "field" => new FieldNode(Text(e, "db"), Text(e, "table"), Text(e, "column")),
            "num" => new NumNode(Number(e, "v")),
            "un" => new UnNode(Text(e, "op"), Child(e, "arg")),
            "bin" => new BinNode(Text(e, "op"), Child(e, "l"), Child(e, "r")),
            "agg" => new AggNode(Text(e, "fn"), Child(e, "arg"), OptionalNumber(e, "p")),
            _ => throw new JsonException("Unknown expression node."),
        };
    }

    private static JsonElement Member(JsonElement e, string name)
    {
        foreach (var p in e.EnumerateObject())
            if (string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase)) return p.Value;
        throw new JsonException(name == "k" ? "Unknown expression node." : $"Expression node is missing '{name}'.");
    }

    private static string Text(JsonElement e, string name)
    {
        var v = Member(e, name);
        return v.ValueKind == JsonValueKind.String
            ? v.GetString()!
            : throw new JsonException(name == "k" ? "Unknown expression node." : $"Expression node '{name}' must be a string.");
    }

    private static double Number(JsonElement e, string name)
    {
        var v = Member(e, name);
        if (v.ValueKind != JsonValueKind.Number || !v.TryGetDouble(out var d) || !double.IsFinite(d))
            throw new JsonException($"Expression node '{name}' must be a finite number.");
        return d;
    }

    private static double? OptionalNumber(JsonElement e, string name)
    {
        foreach (var p in e.EnumerateObject())
            if (string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase))
                return p.Value.ValueKind == JsonValueKind.Null ? null : Number(e, name);
        return null;
    }

    private static ExprNode Child(JsonElement e, string name) => Build(Member(e, name));

    public override void Write(Utf8JsonWriter w, ExprNode value, JsonSerializerOptions options)
    {
        w.WriteStartObject();
        switch (value)
        {
            case FieldNode f:
                w.WriteString("k", "field"); w.WriteString("db", f.Db); w.WriteString("table", f.Table); w.WriteString("column", f.Column);
                break;
            case NumNode n:
                w.WriteString("k", "num"); w.WriteNumber("v", n.V);
                break;
            case UnNode u:
                w.WriteString("k", "un"); w.WriteString("op", u.Op); w.WritePropertyName("arg"); Write(w, u.Arg, options);
                break;
            case BinNode b:
                w.WriteString("k", "bin"); w.WriteString("op", b.Op);
                w.WritePropertyName("l"); Write(w, b.L, options); w.WritePropertyName("r"); Write(w, b.R, options);
                break;
            case AggNode a:
                w.WriteString("k", "agg"); w.WriteString("fn", a.Fn); w.WritePropertyName("arg"); Write(w, a.Arg, options);
                if (a.P is { } p) w.WriteNumber("p", p);
                break;
            default:
                throw new JsonException("Unknown expression node.");
        }
        w.WriteEndObject();
    }
}
