using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>
/// End-to-end tests for the connection endpoints against the real app pipeline
/// (session, DI, routing) via WebApplicationFactory — no live ClickHouse required.
/// They lock in the P1 safety guarantees: a failed connect returns a clean error with
/// <strong>no secret leaked</strong>, and a fresh session starts disconnected.
/// </summary>
public class ConnectionEndpointTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;

    public ConnectionEndpointTests(WebApplicationFactory<Program> factory) => _factory = factory;

    [Fact]
    public async Task Index_serves_the_shell()
    {
        var client = _factory.CreateClient();
        var html = await client.GetStringAsync("/");
        Assert.Contains("class=\"sidebar glass\"", html);
        Assert.Contains("class=\"canvas\"", html);
    }

    [Fact]
    public async Task Status_defaults_to_disconnected()
    {
        var client = _factory.CreateClient();
        var view = await client.GetFromJsonAsync<StatusDto>("/api/connection");
        Assert.NotNull(view);
        Assert.False(view!.Connected);
        Assert.Null(view.Host);
    }

    [Fact]
    public async Task Connect_with_missing_fields_is_rejected()
    {
        var client = _factory.CreateClient();
        var resp = await client.PostAsJsonAsync("/api/connection",
            new { host = "", port = 8443, user = "", password = "x", secure = true });
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task Connect_to_unreachable_server_fails_cleanly_without_leaking_the_password()
    {
        var client = _factory.CreateClient();
        const string secret = "sup3r-s3cret-PW-!@#";

        // Port 1 refuses immediately, so the failure path runs fast and deterministically.
        var resp = await client.PostAsJsonAsync("/api/connection",
            new { host = "127.0.0.1", port = 1, user = "default", password = secret, secure = false });

        Assert.False(resp.IsSuccessStatusCode);
        var body = await resp.Content.ReadAsStringAsync();
        Assert.DoesNotContain(secret, body);              // no credential leak in the response
        Assert.Contains("error", body, StringComparison.OrdinalIgnoreCase);

        // And the session is still not connected after a failed attempt.
        var status = await client.GetFromJsonAsync<StatusDto>("/api/connection");
        Assert.False(status!.Connected);
    }

    [Fact]
    public async Task Disconnect_returns_disconnected()
    {
        var client = _factory.CreateClient();
        var resp = await client.DeleteAsync("/api/connection");
        resp.EnsureSuccessStatusCode();
        var view = await resp.Content.ReadFromJsonAsync<StatusDto>();
        Assert.False(view!.Connected);
    }

    private sealed record StatusDto(
        bool Connected, string? Host, int? Port, string? User, bool? Secure, bool? AllowInvalidCertificate);
}
