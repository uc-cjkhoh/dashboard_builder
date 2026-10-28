using System.Globalization;

namespace DashboardBuilder.ClickHouse.Calc;

/// <summary>
/// Turns a <b>validated</b> calculation tree into a SQL expression. It never re-validates (the gateway
/// always runs <see cref="CalcValidator"/> first) and never writes a literal into the SQL: every number
/// becomes a bound <c>Float64</c> parameter, and every column reference is whatever the caller's
/// <c>qualified</c> callback returned (already catalog-validated and quoted by <c>Identifier</c>).
/// Numeric columns are widened with <c>toFloat64</c> so unsigned or integer arithmetic cannot wrap or round;
/// division by zero yields NULL through <c>nullIf(r, 0)</c>.
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
            NumNode num => Param(num.V),
            UnNode { Op: "-" } u => $"(-{Walk(u.Arg)})",
            BinNode { Op: "/" } b => $"({Walk(b.L)} / nullIf({Walk(b.R)}, 0))",
            BinNode { Op: "+" or "-" or "*" } b => $"({Walk(b.L)} {b.Op} {Walk(b.R)})",
            AggNode a => ClickHouseGateway.AggregateSql(AggName(a.Fn), Walk(a.Arg), sampled, approximate, a.P is { } p ? Param(p) : null),
            UnNode u => throw new InvalidOperationException($"Unsupported unary operator '{u.Op}'."),
            BinNode b => throw new InvalidOperationException($"Unsupported operator '{b.Op}'."),
            _ => throw new InvalidOperationException("Unsupported expression node."),
        };

        string Field(FieldNode f)
        {
            var (sql, category) = qualified(f.Db, f.Table, f.Column);
            return category == ClickHouseType.Numeric ? $"toFloat64({sql})" : sql;
        }

        string Param(double v)
        {
            var name = $"{paramPrefix}p{n++.ToString(CultureInfo.InvariantCulture)}";
            parameters.Add((name, "Float64", v));
            return $"{{{name}:Float64}}";
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
