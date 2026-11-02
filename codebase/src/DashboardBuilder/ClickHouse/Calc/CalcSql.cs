using DashboardBuilder.ClickHouse;

namespace DashboardBuilder.ClickHouse.Calc;

/// <summary>A validated, compiled calculation: its SQL (parameters already appended) and what it is.</summary>
internal sealed record CompiledCalc(string Sql, CalcInfo Info);

/// <summary>The gateway's calculation-only helpers: resolving a calculation's fields against the catalog, validating and
/// compiling it, and shaping calculated dimensions, measures and ranks. Pure apart from the callbacks passed in.</summary>
internal static class CalcSql
{
    /// <summary>Resolves a calculation's field references to their qualified SQL and type category. A field on a table that is
    /// not in the query is rejected first — before any catalog lookup — so a calculation can't trigger metadata queries on
    /// arbitrary tables. A column the catalog doesn't know on an in-query table is left out, so the validator names it with its path.</summary>
    internal static async Task<Dictionary<(string, string, string), (string Sql, string Category)>> ResolveCalcRefsAsync(
        IEnumerable<FieldNode> fields,
        Func<string, string, bool> inQuery,
        Func<string, string, Task<Dictionary<string, string>>> columnsOf,
        Func<string, string, string, Task<string>> qualify)
    {
        var refs = new Dictionary<(string, string, string), (string Sql, string Category)>();
        foreach (var f in fields)
        {
            if (!inQuery(f.Db, f.Table)) throw new UnknownIdentifierException("Field references a table not in the query.");
            if (refs.ContainsKey((f.Db, f.Table, f.Column))) continue;
            if (!(await columnsOf(f.Db, f.Table)).TryGetValue(f.Column, out var category)) continue;
            refs[(f.Db, f.Table, f.Column)] = (await qualify(f.Db, f.Table, f.Column), category);
        }
        return refs;
    }

    /// <summary>Every field reference in a calculation tree, in tree order (left to right).</summary>
    internal static List<FieldNode> CalcFields(ExprNode node)
    {
        var found = new List<FieldNode>();
        Walk(node);
        return found;
        void Walk(ExprNode n)
        {
            switch (n)
            {
                case FieldNode f: found.Add(f); break;
                case UnNode u: Walk(u.Arg); break;
                case BinNode b: Walk(b.L); Walk(b.R); break;
                case AggNode a: Walk(a.Arg); break;
                default: foreach (var c in ExprTree.Children(n)) Walk(c); break;
            }
        }
    }

    /// <summary>
    /// Validate a calculation against the already-resolved fields and compile it. <paramref name="refs"/> maps each
    /// field the catalog knows to its qualified, quoted SQL and category (a field missing from it is unknown);
    /// <paramref name="field"/> is the request path (<c>measures[0]</c>) a rejection names, as <c>….calc.&lt;node&gt;</c>.
    /// Number literals are bound into <paramref name="parameters"/> as <c>{prefix}p{n}</c> — the prefix must be
    /// unique per compiled calculation in one request.
    /// </summary>
    internal static CompiledCalc CompileCalc(
        ExprNode calc, string field,
        IReadOnlyDictionary<(string, string, string), (string Sql, string Category)> refs,
        List<(string Name, string Type, object Value)> parameters, string prefix, bool sampled, bool approximate)
    {
        CalcInfo info;
        try { info = CalcValidator.Validate(calc, (d, t, c) => refs.TryGetValue((d, t, c), out var r) ? r.Category : null); }
        catch (CalcException e) { throw new RequestValidationException(e.Message, e.Path.Length == 0 ? $"{field}.calc" : $"{field}.calc.{e.Path}"); }
        var sql = CalcCompiler.Compile(calc, (d, t, c) => refs[(d, t, c)], parameters, prefix, sampled, approximate);
        // A computed true/false is a UInt8 in ClickHouse; as a result column it must read true/false, like a Bool field does.
        if (info.Type == CalcType.Boolean && calc is not FieldNode) sql = $"toBool({sql})";
        return new CompiledCalc(sql, info);
    }

    /// <summary>
    /// A calculated measure's SQL and whether its values are numbers: an aggregate tree is used as is (no
    /// <paramref name="agg"/>); a row-level tree is aggregated by the pill through <see cref="ClickHouseGateway.AggregateSql"/>.
    /// Re-checks the role rules <see cref="RequestRules"/> applies, plus the type (no sum/avg of text).
    /// </summary>
    internal static (string Sql, bool Numeric) CalcMeasureSql(string? agg, CompiledCalc c, string field, bool sampled, bool approximate)
    {
        if (c.Info.IsAggregate)
        {
            if (agg is not null) throw new RequestValidationException("A calculation that already aggregates takes no further aggregation.", field + ".calc");
            return (c.Sql, c.Info.Type == CalcType.Number);
        }
        var a = agg?.ToLowerInvariant();
        if (a is null || !CalcCatalog.RowLevelAggregations.Contains(a))
            throw new RequestValidationException(CalcCatalog.RowLevelHint, field + ".calc");
        if (a is "sum" or "avg" or "median" or "stddev" or "variance" && c.Info.Type != CalcType.Number)
            throw new RequestValidationException($"{char.ToUpperInvariant(a[0])}{a[1..]} needs a number — this calculation is {c.Info.Type}.", field + ".calc");
        return (ClickHouseGateway.AggregateSql(a, c.Sql, sampled, approximate), a is "sum" or "avg" or "countdistinct" or "countnonnull" or "median" or "stddev" or "variance" || c.Info.Type == CalcType.Number);
    }

    /// <summary>A calculated dimension groups by its row-level expression; an aggregate tree there is a 400.</summary>
    internal static string CalcDimensionSql(CompiledCalc c, string field) => c.Info.IsAggregate
        ? throw new RequestValidationException("A dimension can't contain an aggregate. Put it in a measure instead.", field + ".calc")
        : c.Info.Type == CalcType.Boolean ? $"toString({c.Sql})" // a calculated true/false group reads "true"/"false"; a plain Bool field keeps its own spelling
        : c.Sql;

    /// <summary>A calculated filter's row-level SQL and the category its values are coerced to (D82). The condition goes in WHERE, so an
    /// aggregate tree has no row to test: a 400 naming the calculation.</summary>
    internal static (string Sql, string Category) CalcFilterSql(CompiledCalc c, string field) => c.Info.IsAggregate
        ? throw new RequestValidationException("A filter can't contain an aggregate — it is applied to each row before the view is grouped.", field + ".calc")
        : (c.Sql, c.Info.Type switch
        {
            CalcType.Number => ClickHouseType.Numeric,
            CalcType.Date => ClickHouseType.Temporal,
            CalcType.Boolean => ClickHouseType.Boolean,
            _ => ClickHouseType.Text,
        });

    /// <summary>The name a calculated dimension or measure has in the result: its label, or "calculation".</summary>
    internal static string CalcLabel(string? label) =>
        string.IsNullOrEmpty(label) || label.Length > CalcLimits.MaxName ? "calculation" : label;

    /// <summary>Whether any measure counts distinct values (estimated in approximate mode) — a plain or
    /// row-level <c>countDistinct</c>, or a <c>COUNTD</c> inside a calculation.</summary>
    internal static bool UsesDistinctCount(IEnumerable<MeasureRef> measures) => measures.Any(m =>
        string.Equals(m.Agg, "countDistinct", StringComparison.OrdinalIgnoreCase) || (m.Calc is { } c && HasCountD(c)));

    private static bool HasCountD(ExprNode n) => n switch
    {
        AggNode a => a.Fn == "countd" || HasCountD(a.Arg),
        UnNode u => HasCountD(u.Arg),
        BinNode b => HasCountD(b.L) || HasCountD(b.R),
        _ => ExprTree.Children(n).Any(HasCountD),
    };
}
