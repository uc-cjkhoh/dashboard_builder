using System.Globalization;
using System.Text;

namespace DashboardBuilder.ClickHouse;

/// <summary>
/// CSV serialisation for the bounded export. Pure + testable. Read-only: it only ever formats
/// rows a read query already returned — it never builds SQL. Every field is RFC-4180 quoted, and a
/// leading formula character is neutralised so a spreadsheet can't execute an exported cell.
/// </summary>
public static class CsvUtil
{
    /// <summary>
    /// Escape one CSV field. Quotes when the value contains a comma, quote, CR or LF (doubling inner
    /// quotes); and guards against CSV-formula injection — a value starting with <c>= + - @</c> (or a
    /// tab/CR that Excel strips to reveal one) is prefixed with a single quote so a spreadsheet treats
    /// it as text, not a formula.
    /// </summary>
    public static string Escape(string? field)
    {
        var s = field ?? string.Empty;
        // Formula-injection guard first, so the prefixed quote is inside any RFC-4180 quoting below.
        if (s.Length > 0 && (s[0] is '=' or '+' or '-' or '@' or '\t' or '\r'))
            s = "'" + s;

        if (s.IndexOfAny([',', '"', '\n', '\r']) >= 0)
            s = "\"" + s.Replace("\"", "\"\"") + "\"";
        return s;
    }

    /// <summary>
    /// Render a worksheet <see cref="QueryResult"/> to CSV text: a header of the dimension names then
    /// the measure names, followed by one line per grouped row (keys then values). Row count is already
    /// bounded by the query's LIMIT.
    /// </summary>
    public static string FromQueryResult(QueryResult result)
    {
        var header = new List<string>();
        header.AddRange(result.RowDimensions);
        header.AddRange(result.ColumnDimensions);
        header.AddRange(result.Measures);

        var sb = new StringBuilder();
        sb.Append(string.Join(",", header.Select(Escape))).Append("\r\n");
        foreach (var row in result.Rows)
        {
            var cells = new List<string>(row.Keys.Count + row.Values.Count);
            cells.AddRange(row.Keys.Select(k => Escape(k)));
            cells.AddRange(row.Values.Select(v => Escape(v switch { null => "", double d => d.ToString(CultureInfo.InvariantCulture), _ => v.ToString() ?? "" })));
            sb.Append(string.Join(",", cells)).Append("\r\n");
        }
        return sb.ToString();
    }
}
