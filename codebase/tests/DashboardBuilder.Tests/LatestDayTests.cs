using System.Net;
using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc.Testing;
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
}
