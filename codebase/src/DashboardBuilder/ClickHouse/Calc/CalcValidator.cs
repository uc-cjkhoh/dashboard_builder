namespace DashboardBuilder.ClickHouse.Calc;

/// <summary>
/// Types a calculation tree bottom-up and rejects anything invalid with a <see cref="CalcException"/>
/// (plain sentence + path). A tree is an aggregate if it contains an aggregate function, else row-level;
/// mixing both in one formula is an error, as is an aggregate inside an aggregate. A number literal is
/// neutral (it combines with either).
/// </summary>
public static class CalcValidator
{
    /// <summary>Depth and size limits; needs no catalog. A tree deeper than <see cref="CalcLimits.MaxDepth"/>
    /// or larger than <see cref="CalcLimits.MaxNodes"/> nodes throws.</summary>
    public static void CheckLimits(ExprNode node)
    {
        var nodes = 0;
        Walk(node, 1);

        void Walk(ExprNode n, int depth)
        {
            if (depth > CalcLimits.MaxDepth) throw new CalcException("That formula is too deep.", "");
            if (++nodes > CalcLimits.MaxNodes) throw new CalcException("That formula is too large.", "");
            switch (n)
            {
                case UnNode u: Walk(u.Arg, depth + 1); break;
                case BinNode b: Walk(b.L, depth + 1); Walk(b.R, depth + 1); break;
                case AggNode a: Walk(a.Arg, depth + 1); break;
            }
        }
    }

    /// <summary>True when the tree contains an aggregate function anywhere. Pure (no catalog). Recurses without
    /// a bound, so call <see cref="CheckLimits"/> first on a tree that came off the wire.</summary>
    public static bool ContainsAggregate(ExprNode node) => node switch
    {
        AggNode => true,
        UnNode u => ContainsAggregate(u.Arg),
        BinNode b => ContainsAggregate(b.L) || ContainsAggregate(b.R),
        _ => false,
    };

    /// <param name="categoryOf">Returns the <see cref="ClickHouseType"/> category of <c>(db, table, column)</c>,
    /// or <c>null</c> when the column does not exist.</param>
    public static CalcInfo Validate(ExprNode node, Func<string, string, string, string?> categoryOf)
    {
        CheckLimits(node);
        var t = Type(node, "", categoryOf);
        return new CalcInfo(t.Type, t.IsAggregate, t.Tables);
    }

    // Const: a number literal (or arithmetic over only literals) — it carries no field and no aggregate.
    private readonly record struct Typed(string Type, bool IsAggregate, bool Const, SortedSet<string> Tables, string Name);

    private static SortedSet<string> Tables(params string[] tables) => new(tables, StringComparer.Ordinal);

    private static string Child(string path, string name) => path.Length == 0 ? name : path + "." + name;

    private static Typed Type(ExprNode node, string path, Func<string, string, string, string?> categoryOf)
    {
        switch (node)
        {
            case NumNode n:
                if (!double.IsFinite(n.V)) throw new CalcException("That number is out of range.", path);
                return new Typed(CalcType.Number, false, true, Tables(), "that value");

            case FieldNode f:
            {
                var name = $"{f.Table}.{f.Column}";
                var category = categoryOf(f.Db, f.Table, f.Column) ?? throw new CalcException($"Unknown field {name}.", path);
                var type = category switch
                {
                    ClickHouseType.Numeric => CalcType.Number,
                    ClickHouseType.Text => CalcType.Text,
                    ClickHouseType.Temporal => CalcType.Date,
                    ClickHouseType.Boolean => CalcType.Boolean,
                    _ => throw new CalcException($"{name} can't be used in a calculation.", path),
                };
                return new Typed(type, false, false, Tables($"{f.Db}.{f.Table}"), name);
            }

            case UnNode u:
            {
                if (u.Op != "-") throw new CalcException($"Unknown operator {u.Op}.", path);
                var arg = Type(u.Arg, Child(path, "arg"), categoryOf);
                RequireNumber(arg, Child(path, "arg"));
                return new Typed(CalcType.Number, arg.IsAggregate, arg.Const, arg.Tables, "that value");
            }

            case BinNode b:
            {
                if (b.Op is not ("+" or "-" or "*" or "/")) throw new CalcException($"Unknown operator {b.Op}.", path);
                var l = Type(b.L, Child(path, "l"), categoryOf);
                var r = Type(b.R, Child(path, "r"), categoryOf);
                RequireNumber(l, Child(path, "l"));
                RequireNumber(r, Child(path, "r"));
                if ((l.IsAggregate && !r.IsAggregate && !r.Const) || (r.IsAggregate && !l.IsAggregate && !l.Const))
                    throw new CalcException("Can't mix an aggregate with a row-level value in one formula.", path);
                l.Tables.UnionWith(r.Tables);
                return new Typed(CalcType.Number, l.IsAggregate || r.IsAggregate, l.Const && r.Const, l.Tables, "that value");
            }

            case AggNode a:
            {
                if (!CalcCatalog.Aggregates.TryGetValue(a.Fn, out var spec))
                    throw new CalcException($"Unknown function {a.Fn}.", path);
                var argPath = Child(path, "arg");
                var arg = Type(a.Arg, argPath, categoryOf);
                if (arg.IsAggregate) throw new CalcException("An aggregate can't contain another aggregate.", argPath);
                if (!spec.Accepts.Contains(arg.Type))
                    throw new CalcException($"{a.Fn.ToUpperInvariant()} needs {Describe(spec.Accepts)} — {arg.Name} is {arg.Type}.", argPath);
                var pPath = Child(path, "p");
                if (spec.Fraction)
                {
                    if (a.P is not { } p || !double.IsFinite(p) || p < 0 || p > 1)
                        throw new CalcException($"{a.Fn.ToUpperInvariant()} needs a fraction between 0 and 1.", pPath);
                }
                else if (a.P is not null)
                    throw new CalcException($"{a.Fn.ToUpperInvariant()} takes no fraction.", pPath);
                return new Typed(spec.Result ?? arg.Type, true, false, arg.Tables, "that value");
            }

            default:
                throw new CalcException("Unknown expression node.", path);
        }
    }

    private static void RequireNumber(Typed t, string path)
    {
        if (t.Type != CalcType.Number)
            throw new CalcException($"Arithmetic needs numbers — {t.Name} is {t.Type}.", path);
    }

    private static string Describe(IReadOnlyList<string> accepts) => accepts.Count == 1
        ? "a " + accepts[0]
        : "a " + string.Join(", ", accepts.Take(accepts.Count - 1)) + " or " + accepts[^1];
}
