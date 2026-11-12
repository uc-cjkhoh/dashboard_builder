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

    [HttpPost("sql/translate")]
    public Task<IResult> Translate([FromBody] TranslateRequest req, CancellationToken ct)
        => RunAsync(async _ =>
        {
            if (req is null) throw new RequestValidationException("Request body is missing.", "sql");
            try
            {
                var result = await _translator.TranslateAsync(req.Sql, req.From, req.To, ct);
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
