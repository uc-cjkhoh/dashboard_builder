using System.Globalization;

namespace DashboardBuilder.ClickHouse.Calc;

/// <summary>
/// Turns a <b>validated</b> calculation tree into a SQL expression. It never re-validates (the gateway
/// always runs <see cref="CalcValidator"/> first) and never writes a literal into the SQL: every number
/// becomes a bound <c>Float64</c> parameter, and every column reference is whatever the caller's
/// <c>qualified</c> callback returned (already catalog-validated and quoted by <c>Identifier</c>).
/// Numeric columns are widened with <c>toFloat64</c> so unsigned or integer arithmetic cannot wrap or round;
/// division by zero yields NULL through <c>nullIf(r, 0)</c>. A text literal is a bound <c>String</c> parameter.
/// Conditions follow SQL: a NULL condition is not true, so <c>IF</c>/<c>CASE</c> fall through to the next arm or the
/// else (NULL when there is none). Comparisons with NULL are NULL; <c>AND</c>/<c>OR</c> are three-valued.
/// </summary>
public static class CalcCompiler
{
    /// <summary>Compile <paramref name="node"/>. <paramref name="qualified"/> maps (db, table, column) to the
    /// validated, quoted reference and its <see cref="ClickHouseType"/> category. Number literals are appended
    /// to <paramref name="parameters"/> as <c>{paramPrefix}p{n}</c> (<c>n</c> from 0 per call).</summary>
    public static string Compile(
        ExprNode node,
        Func<string, string, string, (string Sql, string Category)> qualified,
        List<(string Name, string Type, object Value)> parameters,
        string paramPrefix,
        bool sampled,
        bool approximate)
    {
        var n = 0;
        return Walk(node);

        string Walk(ExprNode x) => x switch
        {
            FieldNode f => Field(f),
            NumNode num => Param(num.V, "Float64"),
            UnNode { Op: "-" } u => $"(-{Walk(u.Arg)})",
            BinNode { Op: "/" } b => $"({Walk(b.L)} / nullIf({Walk(b.R)}, 0))",
            BinNode { Op: "+" or "-" or "*" } b => $"({Walk(b.L)} {b.Op} {Walk(b.R)})",
            StrNode t => Param(t.V, "String"),
            CmpNode { Op: "=" or "!=" or "<" or "<=" or ">" or ">=" } c => $"({Walk(c.L)} {c.Op} {Walk(c.R)})",
            LogicNode { Op: "and" or "or" } g => $"{g.Op}({Walk(g.L)}, {Walk(g.R)})",
            NotNode nt => $"not({Walk(nt.Arg)})",
            IfNullNode i => $"ifNull({Walk(i.L)}, {Walk(i.R)})",
            IsNullNode z => $"isNull({Walk(z.Arg)})",
            FnNode fn => Call(fn),
            CaseNode { Whens.Length: 1, Else: not null } k => $"if({Walk(k.Whens[0].Cond)}, {Walk(k.Whens[0].Then)}, {Walk(k.Else)})",
            CaseNode k => MultiIf(k),
            AggNode a => ClickHouseGateway.AggregateSql(AggName(a.Fn), Walk(a.Arg), sampled, approximate, a.P is { } p ? Param(p, "Float64") : null),
            UnNode u => throw new InvalidOperationException($"Unsupported unary operator '{u.Op}'."),
            BinNode b => throw new InvalidOperationException($"Unsupported operator '{b.Op}'."),
            CmpNode or LogicNode => throw new InvalidOperationException("Unsupported operator."),
            _ => throw new InvalidOperationException("Unsupported expression node."),
        };

        // Parameters are numbered in source order, so each part is walked in turn (not through a lazy query).
        string MultiIf(CaseNode k)
        {
            var parts = new List<string>();
            foreach (var w in k.Whens) { parts.Add(Walk(w.Cond)); parts.Add(Walk(w.Then)); }
            parts.Add(k.Else is null ? "NULL" : Walk(k.Else));
            return $"multiIf({string.Join(", ", parts)})";
        }

        // A text function: a fixed ClickHouse function over compiled children. Children are compiled once, in source
        // order, so each literal is bound exactly once; a length or position is a bound UInt32 (validated 0..1000).
        string Call(FnNode fn)
        {
            var spec = CalcCatalog.RowFunctions[fn.Fn];
            var a = new List<string>();
            for (var i = 0; i < fn.Args.Length; i++)
            {
                var kind = spec.Args[Math.Min(i, spec.Args.Count - 1)];
                a.Add(kind is FnArg.Length or FnArg.Position ? Param((uint)((NumNode)fn.Args[i]).V, "UInt32") : Walk(fn.Args[i]));
            }
            return fn.Fn switch
            {
                "lower" => $"lowerUTF8({a[0]})",
                "upper" => $"upperUTF8({a[0]})",
                "trim" => $"trimBoth({a[0]})",
                "len" => $"toFloat64(lengthUTF8({a[0]}))",
                "left" => $"leftUTF8({a[0]}, {a[1]})",
                "right" => $"rightUTF8({a[0]}, {a[1]})",
                "replace" => $"replaceAll({a[0]}, {a[1]}, {a[2]})",
                "concat" => $"concat({string.Join(", ", a)})",
                "contains" => $"(position({a[0]}, {a[1]}) > 0)",
                "startswith" => $"startsWith({a[0]}, {a[1]})",
                "endswith" => $"endsWith({a[0]}, {a[1]})",
                // splitByString has no Nullable form, so a NULL value is answered before it; a position past the end is NULL.
                "split" => $"if(isNull({a[0]}), NULL, arrayElementOrNull(splitByString({a[1]}, assumeNotNull({a[0]})), {a[2]}))",
                _ => throw new InvalidOperationException($"Unsupported function '{fn.Fn}'."),
            };
        }

        string Field(FieldNode f)
        {
            var (sql, category) = qualified(f.Db, f.Table, f.Column);
            return category == ClickHouseType.Numeric ? $"toFloat64({sql})" : sql;
        }

        string Param(object v, string type)
        {
            var name = $"{paramPrefix}p{n++.ToString(CultureInfo.InvariantCulture)}";
            parameters.Add((name, type, v));
            return $"{{{name}:{type}}}";
        }
    }

    // Tree names -> AggregateSql names. COUNT([f]) counts non-null values; COUNTD counts distinct values.
    private static string AggName(string fn) => fn switch
    {
        "sum" or "avg" or "min" or "max" or "median" or "stddev" or "variance" or "percentile" or "attr" => fn,
        "count" => "countnonnull",
        "countd" => "countdistinct",
        _ => throw new InvalidOperationException($"Unsupported aggregate '{fn}'."),
    };
}
