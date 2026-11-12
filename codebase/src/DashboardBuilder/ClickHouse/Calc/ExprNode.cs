using System.Text.Json;
using System.Text.Json.Serialization;

namespace DashboardBuilder.ClickHouse.Calc;

/// <summary>
/// A calculated-field expression tree as it arrives on the wire. The browser parses the formula and
/// sends this tree; no formula text ever reaches SQL. The JSON discriminator <c>k</c> is one of
/// <c>field | num | un | bin | agg | str | date | bool | null | cmp | logic | not | in | case | ifnull | isnull | fn</c>; an unknown or missing <c>k</c>, a missing or wrongly typed
/// member, or a non-finite number fails deserialisation with a <see cref="JsonException"/> (a 400).
/// Operators and function names are plain strings here — the validator whitelists them.
/// </summary>
[JsonConverter(typeof(ExprNodeConverter))]
public abstract record ExprNode;

/// <summary>A column reference; validated against the live catalog before use.</summary>
public sealed record FieldNode(string Db, string Table, string Column) : ExprNode;

/// <summary>A numeric literal; always bound as a parameter.</summary>
public sealed record NumNode(double V) : ExprNode;

public sealed record UnNode(string Op, ExprNode Arg) : ExprNode;

/// <summary>A binary operation (arithmetic, comparison or logic).</summary>
public sealed record BinNode(string Op, ExprNode L, ExprNode R) : ExprNode;

/// <summary>An aggregate function (e.g. <c>sum</c>) over a sub-expression. <see cref="P"/> is the fraction a
/// parametric aggregate takes (<c>percentile</c>: 0..1, always bound as a parameter); absent for every other function.</summary>
public sealed record AggNode(string Fn, ExprNode Arg, double? P = null) : ExprNode;

/// <summary>A text literal; always bound as a <c>String</c> parameter, never written into SQL.</summary>
public sealed record StrNode(string V) : ExprNode;

/// <summary>A date literal (<c>#2024-01-31#</c>), wire <c>{ "k": "date", "v": "2024-01-31" }</c>; the validator demands a real day a <c>Date</c> holds, and it is
/// bound as a <c>String</c> parameter read by <c>toDate</c>, never written into SQL.</summary>
public sealed record DateNode(string V) : ExprNode;

/// <summary>A <c>TRUE</c> / <c>FALSE</c> literal; one of two fixed SQL keywords, never user text.</summary>
public sealed record BoolNode(bool V) : ExprNode;

/// <summary>A <c>NULL</c> literal; it takes the type of the results beside it (see <see cref="CalcType.Null"/>).</summary>
public sealed record NullNode() : ExprNode;

/// <summary><c>arg IN (v1, v2, …)</c>: the values are number, text or date literals (each bound as a parameter), at most <see cref="CalcLimits.MaxInList"/>; boolean result.</summary>
public sealed record InNode(ExprNode Arg, ExprNode[] List) : ExprNode;

/// <summary>A comparison (<c>= != &lt; &lt;= &gt; &gt;=</c>) of two values of the same type; boolean result.</summary>
public sealed record CmpNode(string Op, ExprNode L, ExprNode R) : ExprNode;

/// <summary>A boolean connective: <c>Op</c> is <c>and</c> or <c>or</c>.</summary>
public sealed record LogicNode(string Op, ExprNode L, ExprNode R) : ExprNode;

public sealed record NotNode(ExprNode Arg) : ExprNode;

/// <summary>One <c>WHEN cond THEN result</c> arm (wire: <c>{ c, t }</c>); not a node of its own.</summary>
public sealed record WhenArm(ExprNode Cond, ExprNode Then);

/// <summary><c>CASE WHEN … THEN … [ELSE …] END</c>; <c>IF</c>/<c>IIF</c> are one arm plus an else. No else gives NULL.</summary>
public sealed record CaseNode(WhenArm[] Whens, ExprNode? Else) : ExprNode;

/// <summary><c>IFNULL(l, r)</c> — <c>l</c>, or <c>r</c> when <c>l</c> is NULL.</summary>
public sealed record IfNullNode(ExprNode L, ExprNode R) : ExprNode;

/// <summary><c>ISNULL(arg)</c> — true when the value is NULL.</summary>
public sealed record IsNullNode(ExprNode Arg) : ExprNode;

/// <summary>A row-level function call (<c>lower</c>, <c>left</c>, <c>split</c> …) over its arguments; the name is whitelisted
/// by <see cref="CalcCatalog.RowFunctions"/>, which also fixes the argument kinds.</summary>
public sealed record FnNode(string Fn, ExprNode[] Args) : ExprNode;

/// <summary>The sub-expressions of a node, in source order — the one place a tree walk learns a node's shape.</summary>
public static class ExprTree
{
    public static IEnumerable<ExprNode> Children(ExprNode n)
    {
        switch (n)
        {
            case UnNode u: yield return u.Arg; break;
            case AggNode a: yield return a.Arg; break;
            case NotNode x: yield return x.Arg; break;
            case IsNullNode x: yield return x.Arg; break;
            case BinNode b: yield return b.L; yield return b.R; break;
            case CmpNode b: yield return b.L; yield return b.R; break;
            case LogicNode b: yield return b.L; yield return b.R; break;
            case IfNullNode b: yield return b.L; yield return b.R; break;
            case InNode i: yield return i.Arg; foreach (var v in i.List) yield return v; break;
            case FnNode f: foreach (var a in f.Args) yield return a; break;
            case CaseNode c:
                foreach (var w in c.Whens) { yield return w.Cond; yield return w.Then; }
                if (c.Else is not null) yield return c.Else;
                break;
        }
    }
}

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
            "str" => new StrNode(Text(e, "v")),
            "date" => new DateNode(Text(e, "v")),
            "bool" => new BoolNode(Bool(e, "v")),
            "null" => new NullNode(),
            "in" => new InNode(Child(e, "arg"), Children(e, "list")),
            "cmp" => new CmpNode(Text(e, "op"), Child(e, "l"), Child(e, "r")),
            "logic" => new LogicNode(Text(e, "op"), Child(e, "l"), Child(e, "r")),
            "not" => new NotNode(Child(e, "arg")),
            "case" => new CaseNode(Whens(e), Optional(e, "else")),
            "ifnull" => new IfNullNode(Child(e, "l"), Child(e, "r")),
            "isnull" => new IsNullNode(Child(e, "arg")),
            "fn" => new FnNode(Text(e, "fn"), Children(e, "args")),
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

    private static bool Bool(JsonElement e, string name)
    {
        var v = Member(e, name);
        return v.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? v.GetBoolean()
            : throw new JsonException($"Expression node '{name}' must be true or false.");
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

    private static ExprNode[] Children(JsonElement e, string name)
    {
        var v = Member(e, name);
        if (v.ValueKind != JsonValueKind.Array) throw new JsonException($"Expression node '{name}' must be an array.");
        return v.EnumerateArray().Select(Build).ToArray();
    }

    private static ExprNode? Optional(JsonElement e, string name)
    {
        foreach (var p in e.EnumerateObject())
            if (string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase))
                return p.Value.ValueKind == JsonValueKind.Null ? null : Build(p.Value);
        return null;
    }

    private static WhenArm[] Whens(JsonElement e)
    {
        var v = Member(e, "whens");
        if (v.ValueKind != JsonValueKind.Array) throw new JsonException("Expression node 'whens' must be an array.");
        return v.EnumerateArray().Select(w => w.ValueKind == JsonValueKind.Object
            ? new WhenArm(Child(w, "c"), Child(w, "t"))
            : throw new JsonException("A CASE arm must be an object.")).ToArray();
    }

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
            case StrNode t:
                w.WriteString("k", "str"); w.WriteString("v", t.V);
                break;
            case DateNode d:
                w.WriteString("k", "date"); w.WriteString("v", d.V);
                break;
            case BoolNode bl:
                w.WriteString("k", "bool"); w.WriteBoolean("v", bl.V);
                break;
            case NullNode:
                w.WriteString("k", "null");
                break;
            case InNode i:
                w.WriteString("k", "in"); w.WritePropertyName("arg"); Write(w, i.Arg, options); w.WritePropertyName("list"); w.WriteStartArray();
                foreach (var v in i.List) Write(w, v, options);
                w.WriteEndArray();
                break;
            case CmpNode c:
                w.WriteString("k", "cmp"); w.WriteString("op", c.Op);
                w.WritePropertyName("l"); Write(w, c.L, options); w.WritePropertyName("r"); Write(w, c.R, options);
                break;
            case LogicNode g:
                w.WriteString("k", "logic"); w.WriteString("op", g.Op);
                w.WritePropertyName("l"); Write(w, g.L, options); w.WritePropertyName("r"); Write(w, g.R, options);
                break;
            case NotNode x:
                w.WriteString("k", "not"); w.WritePropertyName("arg"); Write(w, x.Arg, options);
                break;
            case IfNullNode i:
                w.WriteString("k", "ifnull");
                w.WritePropertyName("l"); Write(w, i.L, options); w.WritePropertyName("r"); Write(w, i.R, options);
                break;
            case IsNullNode z:
                w.WriteString("k", "isnull"); w.WritePropertyName("arg"); Write(w, z.Arg, options);
                break;
            case FnNode f:
                w.WriteString("k", "fn"); w.WriteString("fn", f.Fn); w.WritePropertyName("args"); w.WriteStartArray();
                foreach (var a in f.Args) Write(w, a, options);
                w.WriteEndArray();
                break;
            case CaseNode k:
                w.WriteString("k", "case"); w.WritePropertyName("whens"); w.WriteStartArray();
                foreach (var arm in k.Whens)
                {
                    w.WriteStartObject();
                    w.WritePropertyName("c"); Write(w, arm.Cond, options); w.WritePropertyName("t"); Write(w, arm.Then, options);
                    w.WriteEndObject();
                }
                w.WriteEndArray();
                if (k.Else is not null) { w.WritePropertyName("else"); Write(w, k.Else, options); }
                break;
            default:
                throw new JsonException("Unknown expression node.");
        }
        w.WriteEndObject();
    }
}
