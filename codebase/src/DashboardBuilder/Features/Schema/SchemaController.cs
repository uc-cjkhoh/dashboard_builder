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
    private const string LogCategory = "DashboardBuilder.Features.Schema";

    public SchemaController(ConnectionRegistry registry, ClickHouseGateway gateway, ILoggerFactory loggers)
        : base(registry, gateway, loggers) { }

    [HttpGet("databases")]
    public async Task<IResult> ListDatabases(CancellationToken ct)
    {
        var info = Registry.Current;
        if (info is null) return NotConnected();
        try
        {
            return Results.Ok(await Gateway.ListDatabasesAsync(info, ct));
        }
        catch (Exception ex) when (!IsClientAbort(ex))
        {
            return SafeError(ex, LogCategory);
        }
    }

    [HttpGet("databases/{db}/tables")]
    public async Task<IResult> ListTables(string db, CancellationToken ct)
    {
        var info = Registry.Current;
        if (info is null) return NotConnected();
        try
        {
            return Results.Ok(await Gateway.ListTablesAsync(info, db, ct));
        }
        catch (UnknownIdentifierException)
        {
            return Results.NotFound(new { error = "Unknown database." });
        }
        catch (Exception ex) when (!IsClientAbort(ex))
        {
            return SafeError(ex, LogCategory);
        }
    }

    [HttpGet("databases/{db}/tables/{table}/columns")]
    public async Task<IResult> ListColumns(string db, string table, CancellationToken ct)
    {
        var info = Registry.Current;
        if (info is null) return NotConnected();
        try
        {
            return Results.Ok(await Gateway.DescribeColumnsAsync(info, db, table, ct));
        }
        catch (UnknownIdentifierException ex)
        {
            return Results.NotFound(new { error = ex.Message });
        }
        catch (Exception ex) when (!IsClientAbort(ex))
        {
            return SafeError(ex, LogCategory);
        }
    }

    [HttpGet("databases/{db}/tables/{table}/preview")]
    public async Task<IResult> Preview(string db, string table, int? limit, CancellationToken ct)
    {
        var info = Registry.Current;
        if (info is null) return NotConnected();
        try
        {
            return Results.Ok(await Gateway.PreviewAsync(info, db, table, limit ?? 50, ct));
        }
        catch (UnknownIdentifierException ex)
        {
            return Results.NotFound(new { error = ex.Message });
        }
        catch (Exception ex) when (!IsClientAbort(ex))
        {
            return SafeError(ex, LogCategory);
        }
    }

    [HttpGet("databases/{db}/tables/{table}/count")]
    public async Task<IResult> Count(string db, string table, CancellationToken ct)
    {
        var info = Registry.Current;
        if (info is null) return NotConnected();
        try
        {
            return Results.Ok(new { count = await Gateway.RowCountAsync(info, db, table, ct) });
        }
        catch (UnknownIdentifierException ex)
        {
            return Results.NotFound(new { error = ex.Message });
        }
        catch (Exception ex) when (!IsClientAbort(ex))
        {
            return SafeError(ex, LogCategory);
        }
    }

    [HttpGet("databases/{db}/tables/{table}/columns/{column}/distinct")]
    public async Task<IResult> Distinct(string db, string table, string column, int? limit, CancellationToken ct)
    {
        var info = Registry.Current;
        if (info is null) return NotConnected();
        try
        {
            return Results.Ok(await Gateway.DistinctValuesAsync(info, db, table, column, limit, ct));
        }
        catch (UnknownIdentifierException ex)
        {
            return Results.NotFound(new { error = ex.Message });
        }
        catch (Exception ex) when (!IsClientAbort(ex))
        {
            return SafeError(ex, LogCategory);
        }
    }
}
