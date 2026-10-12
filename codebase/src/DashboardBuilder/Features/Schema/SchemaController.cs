using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc;

namespace DashboardBuilder.Features.Schema;

/// <summary>
/// Read-only schema browsing (P3): list databases and the tables in a database, describe columns,
/// preview rows, count, and distinct values — all scoped to the session's connection. No identifier
/// reaches SQL without catalog-validation + quoting (handled in <see cref="ClickHouseGateway"/>).
/// </summary>
public sealed class SchemaController : ApiControllerBase
{
    public SchemaController(ConnectionRegistry registry, ClickHouseGateway gateway, ILoggerFactory loggers)
        : base(registry, gateway, loggers) { }

    [HttpGet("databases")]
    public Task<IResult> ListDatabases(CancellationToken ct)
        => RunAsync(async info => Results.Ok(await Gateway.ListDatabasesAsync(info, ct)), StatusCodes.Status404NotFound);

    [HttpGet("databases/{db}/tables")]
    public Task<IResult> ListTables(string db, CancellationToken ct)
        => RunAsync(async info => Results.Ok(await Gateway.ListTablesAsync(info, db, ct)), StatusCodes.Status404NotFound);

    [HttpGet("databases/{db}/tables/{table}/columns")]
    public Task<IResult> ListColumns(string db, string table, CancellationToken ct)
        => RunAsync(async info => Results.Ok(await Gateway.DescribeColumnsAsync(info, db, table, ct)), StatusCodes.Status404NotFound);

    [HttpGet("databases/{db}/tables/{table}/preview")]
    public Task<IResult> Preview(string db, string table, int? limit, CancellationToken ct)
        => RunAsync(async info => Results.Ok(await Gateway.PreviewAsync(info, db, table, limit ?? 50, ct)), StatusCodes.Status404NotFound);

    [HttpGet("databases/{db}/tables/{table}/count")]
    public Task<IResult> Count(string db, string table, CancellationToken ct)
        => RunAsync(async info => Results.Ok(new { count = await Gateway.RowCountAsync(info, db, table, ct) }), StatusCodes.Status404NotFound);

    [HttpGet("databases/{db}/tables/{table}/columns/{column}/distinct")]
    public Task<IResult> Distinct(string db, string table, string column, int? limit, CancellationToken ct)
        => RunAsync(async info => { RequestRules.ValidateDistinctLimit(limit); return Results.Ok(await Gateway.DistinctValuesAsync(info, db, table, column, limit, ct)); }, StatusCodes.Status404NotFound);
}
