using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>
/// Schema endpoints (P3) gate on a live session connection. Without one (the case that needs
/// no ClickHouse) they must return 409, not 500 — the happy path is exercised live against a
/// real server.
/// </summary>
public class SchemaEndpointTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;

    public SchemaEndpointTests(WebApplicationFactory<Program> factory) => _factory = factory;

    [Fact]
    public async Task Databases_without_a_connection_returns_409()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetAsync("/api/databases");
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }

    [Fact]
    public async Task Tables_without_a_connection_returns_409()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetAsync("/api/databases/default/tables");
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }

    [Fact]
    public async Task Columns_without_a_connection_returns_409()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetAsync("/api/databases/default/tables/t/columns");
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }

    [Fact]
    public async Task Preview_without_a_connection_returns_409()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetAsync("/api/databases/default/tables/t/preview?limit=10");
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }

    [Fact]
    public async Task Count_without_a_connection_returns_409()
    {
        var client = _factory.CreateClient();
        var resp = await client.GetAsync("/api/databases/default/tables/t/count");
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }

    [Fact]
    public async Task Aggregate_without_a_connection_returns_409()
    {
        var client = _factory.CreateClient();
        var resp = await client.PostAsJsonAsync("/api/databases/default/tables/t/aggregate",
            new { agg = "count" });
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }

    [Fact]
    public async Task Query_without_a_connection_returns_409()
    {
        var client = _factory.CreateClient();
        var resp = await client.PostAsJsonAsync("/api/query",
            new { from = new { db = "default", table = "t" } });
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }
}
