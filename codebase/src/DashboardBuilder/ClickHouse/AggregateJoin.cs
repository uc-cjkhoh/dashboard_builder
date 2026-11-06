using System.Text;

namespace DashboardBuilder.ClickHouse;

/// <summary>
/// Aggregate-before-join (P43). A many-to-many (or one-to-many) join repeats a row of one table once per matching row of the other, so a
/// sum or count over the repeated side double-counts. Here each table of a two-table join becomes a subquery grouped to the join key plus the
/// columns the view groups by, carrying a partial aggregate per measure; the outer query joins those and combines the partials
/// (sum of sums, sum of counts, min of mins, sum / count for an average).
/// Everything handed in is an already-quoted identifier, a whitelisted keyword or a SQL fragment with bound-parameter placeholders; nothing is user text.
/// Each subquery keeps its table's alias (t0, t1), so a column expression compiled against the joined view means the same inside it.
/// </summary>
internal sealed class AggregateJoin(bool filterBoth)
{
    private sealed class Side(string alias, string table)
    {
        public string Alias { get; } = alias;
        public string Table { get; } = table;
        public List<string> Columns { get; } = [];
        public List<string> Partials { get; } = [];
        public List<string> Where { get; } = [];
    }

    private readonly Dictionary<string, Side> _sides = [];
    private readonly List<string> _order = [];
    private List<(string Left, string Right)> _keys = [];

    public void AddSide(string alias, string qualifiedTable) { _sides[alias] = new Side(alias, qualifiedTable); _order.Add(alias); }

    /// <summary>The join's key pairs as quoted column names: the first side's, then the second's.</summary>
    public void Keys(IEnumerable<(string Left, string Right)> pairs)
    {
        _keys = [.. pairs];
        foreach (var (l, r) in _keys) { Need(_order[0], l); Need(_order[1], r); }
    }

    /// <summary>A column of a side the view reads raw (a group-by field): kept in its subquery's select and GROUP BY.</summary>
    public void Need(string alias, string quotedColumn)
    {
        var cols = _sides[alias].Columns;
        if (!cols.Contains(quotedColumn)) cols.Add(quotedColumn);
    }

    /// <summary>A filter condition (aliased to its own table) applied inside that side's subquery.</summary>
    public void Where(string alias, string condition) => _sides[alias].Where.Add(condition);

    /// <summary>The outer expression for a measure: a partial aggregate is added to <paramref name="alias"/>'s subquery and combined here.</summary>
    public string Measure(string agg, string alias, string expr, string field)
    {
        string P(string inner) => $"{alias}.{PartialName(alias, inner)}";
        switch (agg)
        {
            case "count": return $"sum({P("count()")})";
            case "sum": return $"sum({P($"sum({expr})")})";
            case "min": return $"min({P($"min({expr})")})";
            case "max": return $"max({P($"max({expr})")})";
            case "countnonnull": return $"sum({P($"count({expr})")})";
            case "avg": return $"sum({P($"sum({expr})")}) / nullIf(sum({P($"count({expr})")}), 0)";
            default:
                throw new RequestValidationException($"{char.ToUpperInvariant(agg[0])}{agg[1..]} can't be combined before the join — use Sum, Count, Min, Max or Average, or turn off aggregating before the join.", field);
        }
    }

    internal static readonly HashSet<string> Combinable = new(StringComparer.Ordinal) { "count", "sum", "min", "max", "countnonnull", "avg" };

    private string PartialName(string alias, string inner)
    {
        var partials = _sides[alias].Partials;
        var i = partials.IndexOf(inner);
        if (i < 0) { partials.Add(inner); i = partials.Count - 1; }
        return $"`__m{i}`";
    }

    /// <summary>The FROM clause: both subqueries, joined with <paramref name="joinKeyword"/> and <paramref name="on"/> (compiled against the outer aliases).</summary>
    public string FromSql(string joinKeyword, string on)
    {
        // With filters in both directions, a filtered side also limits the other side to the keys it still has.
        var extra = new Dictionary<string, string>();
        if (filterBoth)
            for (var s = 0; s < 2; s++)
            {
                var x = _sides[_order[s]]; var y = _sides[_order[1 - s]];
                if (x.Where.Count == 0) continue;
                var xk = _keys.Select(k => s == 0 ? k.Left : k.Right).ToList();
                var yk = _keys.Select(k => s == 0 ? k.Right : k.Left).ToList();
                string Tuple(string alias, List<string> cols) => cols.Count == 1 ? $"{alias}.{cols[0]}" : "(" + string.Join(", ", cols.Select(c => $"{alias}.{c}")) + ")";
                var sub = $"SELECT {string.Join(", ", xk.Select(c => $"{x.Alias}.{c}"))} FROM {x.Table} AS {x.Alias} WHERE {string.Join(" AND ", x.Where)}";
                extra[y.Alias] = $"{Tuple(y.Alias, yk)} IN ({sub})";
            }
        var sb = new StringBuilder(" FROM ");
        for (var s = 0; s < 2; s++)
        {
            var side = _sides[_order[s]];
            if (s == 1) sb.Append(joinKeyword);
            var select = side.Columns.Select(c => $"{side.Alias}.{c} AS {c}")
                .Concat(side.Partials.Select((p, i) => $"{p} AS `__m{i}`"));
            var where = side.Where.Concat(extra.TryGetValue(side.Alias, out var e) ? [e] : []).ToList();
            sb.Append($"(SELECT {string.Join(", ", select)} FROM {side.Table} AS {side.Alias}")
              .Append(where.Count > 0 ? " WHERE " + string.Join(" AND ", where) : "")
              .Append($" GROUP BY {string.Join(", ", side.Columns.Select(c => $"{side.Alias}.{c}"))}) AS {side.Alias}");
        }
        return sb.Append(on).ToString();
    }
}
