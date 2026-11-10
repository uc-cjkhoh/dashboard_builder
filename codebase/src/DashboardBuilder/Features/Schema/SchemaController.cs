using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc;

namespace DashboardBuilder.Features.Schema;

/// <summary>
/// Read-only schema browsing: list databases and the tables in a database, describe columns,
/// and list distinct values — all scoped to the session's connection. No identifier
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

    [HttpGet("databases/{db}/tables/{table}/columns/{column}/distinct")]
    public Task<IResult> Distinct(string db, string table, string column, int? limit, CancellationToken ct)
        => RunAsync(async info => { RequestRules.ValidateDistinctLimit(limit); return Results.Ok(await Gateway.DistinctValuesAsync(info, db, table, column, limit, ct)); }, StatusCodes.Status404NotFound);

    /// <summary>Column profile: rows, NULL share, approximate distinct count, min/max and top values of one column over the table's first rows.</summary>
    [HttpPost("databases/{db}/tables/{table}/profile")]
    public Task<IResult> Profile(string db, string table, [FromBody] ProfileRequest request, CancellationToken ct)
        => RunAsync(async info => { RequestRules.ValidateProfile(request); return Results.Ok(await Gateway.ProfileColumnAsync(info, db, table, request, ct)); }, StatusCodes.Status404NotFound);

    /// <summary>The newest day of a date column (<c>{ latest: "2024-03-31" | null }</c>), so relative ranges can count from the data.</summary>
    [HttpGet("databases/{db}/tables/{table}/columns/{column}/latest")]
    public Task<IResult> Latest(string db, string table, string column, CancellationToken ct)
        => RunAsync(async info => Results.Ok(new { latest = await Gateway.LatestDayAsync(info, db, table, column, ct) }), StatusCodes.Status404NotFound);
}
