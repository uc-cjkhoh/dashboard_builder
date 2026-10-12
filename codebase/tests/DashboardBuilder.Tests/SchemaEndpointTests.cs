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

    [Theory]
    [InlineData("GET", "/api/databases/default/tables/t/preview?limit=10")]
    [InlineData("GET", "/api/databases/default/tables/t/count")]
    [InlineData("POST", "/api/databases/default/tables/t/aggregate")]
    public async Task Removed_endpoints_are_gone(string method, string url)
    {
        var req = new HttpRequestMessage(new HttpMethod(method), url);
        if (method == "POST") req.Content = JsonContent.Create(new { });
        var resp = await _factory.CreateClient().SendAsync(req);
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
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
