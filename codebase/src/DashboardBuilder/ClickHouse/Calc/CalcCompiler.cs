using System.Globalization;

namespace DashboardBuilder.ClickHouse.Calc;

/// <summary>
/// Turns a <b>validated</b> calculation tree into a SQL expression. It never re-validates (the gateway
/// always runs <see cref="CalcValidator"/> first) and never writes a literal into the SQL: every number
/// becomes a bound <c>Float64</c> parameter, and every column reference is whatever the caller's
/// <c>qualified</c> callback returned (already catalog-validated and quoted by <c>Identifier</c>).
/// Numeric columns are widened with <c>toFloat64</c> so unsigned or integer arithmetic cannot wrap or round;
/// division by zero yields NULL through <c>nullIf(r, 0)</c>. A text literal is a bound <c>String</c> parameter.
/// TRUE / FALSE / NULL compile to the SQL keywords; <c>IN</c> binds each value. Conditions follow SQL: a NULL condition is not true, so <c>IF</c>/<c>CASE</c> fall through to the next arm or the
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
            // TRUE / FALSE / NULL are fixed keywords (nothing the user typed reaches the SQL); an IN value is a bound parameter.
            BoolNode bl => bl.V ? "true" : "false",
            NullNode => "NULL",
            InNode i => In(i),
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

        // The argument is compiled first, then each value, so parameters keep source order.
        string In(InNode i)
        {
            var arg = Walk(i.Arg);
            return $"({arg} IN ({string.Join(", ", i.List.Select(Walk))}))";
        }

        // Parameters are numbered in source order, so each part is walked in turn (not through a lazy query).
        string MultiIf(CaseNode k)
        {
            var parts = new List<string>();
            foreach (var w in k.Whens) { parts.Add(Walk(w.Cond)); parts.Add(Walk(w.Then)); }
            parts.Add(k.Else is null ? "NULL" : Walk(k.Else));
            return $"multiIf({string.Join(", ", parts)})";
        }

        // A text function: a fixed ClickHouse function over compiled children. Children are compiled once, in source
        // order, so each literal is bound exactly once; a length or position is a bound UInt32 (validated 0..1000), a DATEADD amount a bound Int32 and a DATEDIFF unit a bound String.
        string Call(FnNode fn)
        {
            var spec = CalcCatalog.RowFunctions[fn.Fn];
            var a = new List<string>();
            for (var i = 0; i < fn.Args.Length; i++)
            {
                var kind = spec.Args[Math.Min(i, spec.Args.Count - 1)];
                a.Add(kind switch
                {
                    FnArg.Length or FnArg.Position => Param((uint)((NumNode)fn.Args[i]).V, "UInt32"),
                    // DATEADD's unit picks a fixed function below (nothing bound); DATEDIFF binds its unit word.
                    FnArg.Unit => fn.Fn is "dateadd" or "datetrunc" ? ((StrNode)fn.Args[i]).V.ToLowerInvariant() : Param(((StrNode)fn.Args[i]).V.ToLowerInvariant(), "String"),
                    FnArg.Part => ((StrNode)fn.Args[i]).V.ToLowerInvariant(), // picks a fixed dateName part below; nothing bound
                    FnArg.Amount => Param((int)CalcValidator.AmountLiteral(fn.Args[i])!.Value, "Int32"),
                    _ => Walk(fn.Args[i]),
                });
            }
            return fn.Fn switch
            {
                "lower" => $"lowerUTF8({a[0]})",
                "upper" => $"upperUTF8({a[0]})",
                "trim" => $"trimBoth({a[0]})",
                "ltrim" => $"trimLeft({a[0]})",
                "rtrim" => $"trimRight({a[0]})",
                "text" => $"toString({a[0]})",
                "len" => $"toFloat64(lengthUTF8({a[0]}))",
                "left" => $"leftUTF8({a[0]}, {a[1]})",
                "right" => $"rightUTF8({a[0]}, {a[1]})",
                "mid" => a.Count == 2 ? $"substringUTF8({a[0]}, {a[1]})" : $"substringUTF8({a[0]}, {a[1]}, {a[2]})",
                "find" => $"toFloat64(positionUTF8({string.Join(", ", a)}))",
                "replace" => $"replaceAll({a[0]}, {a[1]}, {a[2]})",
                "concat" => $"concat({string.Join(", ", a)})",
                "contains" => $"(position({a[0]}, {a[1]}) > 0)",
                "startswith" => $"startsWith({a[0]}, {a[1]})",
                "endswith" => $"endsWith({a[0]}, {a[1]})",
                "icontains" => $"(positionCaseInsensitiveUTF8({a[0]}, {a[1]}) > 0)",
                "istartswith" => $"startsWith(lowerUTF8({a[0]}), lowerUTF8({a[1]}))",
                "iendswith" => $"endsWith(lowerUTF8({a[0]}), lowerUTF8({a[1]}))",
                // splitByString has no Nullable form, so a NULL value is answered before it; a position past the end is NULL.
                "split" => $"if(isNull({a[0]}), NULL, arrayElementOrNull(splitByString({a[1]}, assumeNotNull({a[0]})), {a[2]}))",
                "datediff" => $"toFloat64(dateDiff({a[0]}, {a[1]}, {a[2]}))",
                "dateadd" => DateAdd(AddFunction(a[0]), a[2], a[1]),
                "year" => $"toFloat64(toYear({a[0]}))",
                "month" => $"toFloat64(toMonth({a[0]}))",
                "day" => $"toFloat64(toDayOfMonth({a[0]}))",
                "quarter" => $"toFloat64(toQuarter({a[0]}))",
                "week" => $"toFloat64(toISOWeek({a[0]}))",
                "weekday" => $"toFloat64(toDayOfWeek({a[0]}))",
                "date" => TypeCast.ParseDate(a[0]),
                "isoyear" => $"toFloat64(toISOYear({a[0]}))",
                "datename" => $"dateName('{a[0]}', toDateTime64({a[1]}, 0))",
                "datetrunc" => DateTrunc(a[0], a[1]),
                "makedate" => MakeDate(a[0], a[1], a[2]),
                _ => throw new InvalidOperationException($"Unsupported function '{fn.Fn}'."),
            };
        }

        // DATEADD is computed on a DateTime64 (1900..2299), not on the column's own type: a plain Date (1970..2149) wraps around
        // and a DateTime clamps to 1970 when a step leaves its range. A result at the DateTime64 edge is itself clamped, so
        // the answer must lie strictly inside 1900-01-03..2299-12-29 (UTC) or it is NULL.
        static string DateAdd(string add, string date, string amount)
        {
            var r = $"{add}(toDateTime64({date}, 0), {amount})";
            return $"if({r} > toDateTime64('1900-01-03 00:00:00', 0, 'UTC') AND {r} < toDateTime64('2299-12-29 00:00:00', 0, 'UTC'), {r}, NULL)";
        }

        // DATETRUNC on a DateTime64 (1900..2299): the date-sized units come back as Date32 (never the 1970-based Date), so every
        // unit is widened to DateTime64 and the result is one type. The unit is whitelisted and written as a fixed word.
        static string DateTrunc(string unit, string date)
        {
            var t = $"dateTrunc('{unit}', toDateTime64({date}, 0))";
            return unit is "year" or "quarter" or "month" or "week" ? $"toDateTime64({t}, 0)" : t;
        }

        // makeDate32 rolls an impossible day over (Feb 30 -> Mar 1) and answers 1970-01-01 for a bad month, so MAKEDATE is NULL unless
        // all three are whole numbers, the year lies in 1901..2298 (inside the DATEADD window), month 1..12, day 1..31 and the built
        // date's day is the day asked for (a rolled-over date never matches). A NULL part makes the condition NULL, so the answer is NULL.
        static string MakeDate(string y, string m, string d)
        {
            var x = $"makeDate32(toInt32({y}), toInt32({m}), toInt32({d}))";
            return $"if({y} = floor({y}) AND {m} = floor({m}) AND {d} = floor({d}) AND {y} >= 1901 AND {y} <= 2298 AND {m} >= 1 AND {m} <= 12 AND {d} >= 1 AND {d} <= 31 AND toDayOfMonth({x}) = {d}, toDateTime64({x}, 0), NULL)";
        }

        // DATEADD's fixed ClickHouse function per whitelisted unit (the unit never reaches SQL as text).
        static string AddFunction(string unit) => unit switch
        {
            "year" => "addYears", "quarter" => "addQuarters", "month" => "addMonths", "week" => "addWeeks",
            "day" => "addDays", "hour" => "addHours", "minute" => "addMinutes", "second" => "addSeconds",
            _ => throw new InvalidOperationException($"Unsupported unit '{unit}'."),
        };

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
