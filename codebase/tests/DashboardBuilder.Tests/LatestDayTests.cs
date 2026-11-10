using System.Net;
using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Logging.Abstractions;
using static DashboardBuilder.Tests.StubClickHouse;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>The latest day of a date column (GET .../columns/{column}/latest): one quoted MAX, date columns only, gated.</summary>
public class LatestDayTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public LatestDayTests(WebApplicationFactory<Program> factory) => _factory = factory;

    [Fact] public void The_sql_is_one_null_safe_max_with_every_identifier_quoted()
        => Assert.Equal("SELECT toString(toDate(maxOrNull(`a\\`; DROP TABLE x; --`))) FROM `d\\`b`.`t`",
            ClickHouseGateway.BuildLatestDaySql("d`b", "t", "a`; DROP TABLE x; --"));

    [Fact] public async Task Latest_without_a_connection_returns_409()
    {
        var resp = await _factory.CreateClient().GetAsync("/api/databases/d/tables/t/columns/c/latest");
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }

    private static StubClickHouse.Result Answer(string sql)
    {
        if (sql.StartsWith("SHOW DATABASES")) return new([new Col("name", "String")], [["db"]]);
        if (sql.StartsWith("SHOW TABLES")) return new([new Col("name", "String")], [["orders"]]);
        if (sql.StartsWith("DESCRIBE TABLE")) return new([new Col("name", "String"), new Col("type", "String")], [["placed", "DateTime"], ["status", "String"]]);
        return new([new Col("v", "String")], [["2024-03-31"]]);
    }
    private static Task<string?> Latest(StubClickHouse stub, string column) =>
        new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance)
            .LatestDayAsync(new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false), "db", "orders", column, default);

    [Fact] public async Task A_date_column_returns_its_latest_day()
    {
        using var stub = new StubClickHouse(Answer);
        Assert.Equal("2024-03-31", await Latest(stub, "placed"));
        Assert.Contains(stub.Statements, x => x.Sql.StartsWith("SELECT toString(toDate(maxOrNull(`placed`)))"));
    }
    [Fact] public async Task A_non_date_column_is_refused_without_reading_it()
    {
        using var stub = new StubClickHouse(Answer);
        var e = await Assert.ThrowsAsync<UnknownIdentifierException>(() => Latest(stub, "status"));
        Assert.Equal("Column \"status\" is not a date column.", e.Message);
        Assert.DoesNotContain(stub.Statements, x => x.Sql.Contains("maxOrNull"));
    }
    [Fact] public async Task A_missing_column_gets_the_same_message_as_the_profile()
    {
        using var stub = new StubClickHouse(Answer);
        var e = await Assert.ThrowsAsync<UnknownIdentifierException>(() => Latest(stub, "nope"));
        Assert.Equal(UnknownIdentifierException.Column("nope", "db", "orders").Message, e.Message);
    }
}
