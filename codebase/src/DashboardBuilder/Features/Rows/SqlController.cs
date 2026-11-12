using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc;

namespace DashboardBuilder.Features.Rows;

/// <summary>The body of <c>POST /api/sql/translate</c>.</summary>
public sealed record TranslateRequest(string Sql, string From, string To);

/// <summary>
/// <c>POST /api/sql/translate</c>: the Edit SQL dialog's dialect switch (D106). Converts one query between MySQL and ClickHouse with
/// <see cref="SqlTranslator"/> and answers <c>{ sql, warnings, changes }</c>. It reads no tables and runs no SQL; a converted query is checked by the same
/// guard as any custom SQL before it is saved or described. 400 <c>sql</c> (with <c>line</c> / <c>col</c> / <c>start</c> when the text can't
/// be read), 503 when this server has no Python 3.
/// </summary>
public sealed class SqlController : ApiControllerBase
{
    private readonly SqlTranslator _translator;
    public SqlController(ConnectionRegistry registry, ClickHouseGateway gateway, ILoggerFactory loggers, SqlTranslator translator)
        : base(registry, gateway, loggers) => _translator = translator;

    /// <summary>The ids of the comparisons whose two columns are both text: MySQL compares those without regard to case, ClickHouse with it, so the translator folds them (D106).
    /// ClickHouse describes each probe (<c>DESCRIBE</c>: no rows are read, and the text has passed the same guard as any custom SQL); a probe that fails (an outer name, a refusal)
    /// is left out, and the comparison stays as written.</summary>
    private async Task<IReadOnlyList<int>> TextPairsAsync(ClickHouseConnectionInfo info, IReadOnlyList<TypeProbe> probes, CancellationToken ct)
    {
        async Task<int?> One(TypeProbe p)
        {
            try
            {
                var columns = await Gateway.DescribeQueryAsync(info, CustomSql.Clean(p.Sql), ct);
                return columns.Count == p.Columns && columns.All(c => IsText(c.Type)) ? p.Id : null;
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { return null; }
        }
        return (await Task.WhenAll(probes.Select(One))).OfType<int>().ToList();
    }

    /// <summary>A text type whose comparison ClickHouse does with case: String, FixedString and Enum, also inside Nullable / LowCardinality.</summary>
    internal static bool IsText(string type)
    {
        var t = type.Trim();
        while (t.StartsWith("Nullable(", StringComparison.Ordinal) || t.StartsWith("LowCardinality(", StringComparison.Ordinal)) t = t[(t.IndexOf('(') + 1)..^1].Trim();
        return t == "String" || t.StartsWith("FixedString(", StringComparison.Ordinal) || t.StartsWith("Enum8(", StringComparison.Ordinal) || t.StartsWith("Enum16(", StringComparison.Ordinal);
    }

    [HttpPost("sql/translate")]
    public Task<IResult> Translate([FromBody] TranslateRequest req, CancellationToken ct)
        => RunAsync(async info =>
        {
            if (req is null) throw new RequestValidationException("Request body is missing.", "sql");
            try
            {
                var result = await _translator.TranslateAsync(req.Sql, req.From, req.To, ct);
                if (req.From == "mysql" && req.To == "clickhouse" && result.ProbeList.Count > 0)
                {
                    var text = await TextPairsAsync(info, result.ProbeList, ct);
                    if (text.Count > 0) result = await _translator.TranslateAsync(req.Sql, req.From, req.To, ct, text);
                }
                return Results.Ok(new { sql = result.Sql, warnings = result.Warnings, changes = result.Changes });
            }
            catch (SqlTranslateException ex)
            {
                var f = ex.Failure;
                return Results.Json(new { error = ex.Message, field = "sql", line = f.Line, col = f.Col, start = f.Start }, statusCode: StatusCodes.Status400BadRequest);
            }
            catch (SqlTranslatorUnavailableException ex)
            {
                return Results.Json(new ApiError(ex.Message), statusCode: StatusCodes.Status503ServiceUnavailable);
            }
        });
}
