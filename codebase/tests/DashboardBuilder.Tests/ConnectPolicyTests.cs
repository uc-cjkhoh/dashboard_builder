using System.Net;
using System.Net.Http.Json;
using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>
/// D135 (review 2026-11-17): the connect form must not turn the app into a probe of the network it sits on. An operator's
/// allowlist refuses every other host before any network; link-local and unspecified addresses are always refused; and
/// connect attempts are rate-limited per client address.
/// </summary>
public class ConnectPolicyTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public ConnectPolicyTests(WebApplicationFactory<Program> factory) => _factory = factory;

    [Theory]
    [InlineData("db.internal")]
    [InlineData("DB.Internal.")]
    [InlineData("10.0.0.5")]
    [InlineData("[fd00::5]")]
    public void An_allowed_host_may_be_tried_however_it_is_written(string host)
        => Assert.Null(new ConnectPolicy(["db.internal", "10.0.0.5", "fd00::5"]).HostError(host));

    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("other.internal")]
    [InlineData("10.0.0.6")]
    public void Any_other_host_is_refused_when_an_allowlist_is_set(string host)
        => Assert.Equal(ConnectPolicy.NotAllowedMessage, new ConnectPolicy(["db.internal", "10.0.0.5"]).HostError(host));

    [Theory]
    [InlineData("169.254.169.254")]
    [InlineData("fe80::1")]
    [InlineData("[fe80::1]")]
    [InlineData("0.0.0.0")]
    [InlineData("::")]
    [InlineData("::ffff:169.254.169.254")]
    public void Link_local_and_unspecified_addresses_are_refused_even_without_an_allowlist(string host)
        => Assert.Equal(ConnectPolicy.LinkLocalMessage, new ConnectPolicy(null).HostError(host));

    [Fact]
    public void Without_an_allowlist_any_ordinary_host_may_be_tried()
    {
        var open = new ConnectPolicy([]);
        Assert.False(open.Restricted);
        Assert.Null(open.HostError("127.0.0.1"));
        Assert.Null(open.HostError("db.example.com"));
    }

    [Fact]
    public async Task A_host_outside_the_allowlist_is_refused_on_the_host_field_without_being_tried()
    {
        var client = _factory.WithWebHostBuilder(b => b.UseSetting("ClickHouse:AllowedHosts:0", "db.internal")).CreateClient();
        // Port 1 on loopback would answer "refused" at once if it were tried; the allowlist answers first, with its own message.
        var resp = await client.PostAsJsonAsync("/api/connection", new { host = "127.0.0.1", port = 1, user = "default", password = "x", secure = false });
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<ErrorDto>();
        Assert.Equal(ConnectPolicy.NotAllowedMessage, body!.Error);
        Assert.Equal("host", body.Field);
    }

    [Fact]
    public async Task Connect_attempts_are_rate_limited_with_the_api_error_shape()
    {
        var client = _factory.WithWebHostBuilder(b => b.UseSetting("ClickHouse:ConnectPerMinute", "2")).CreateClient();
        var attempt = () => client.PostAsJsonAsync("/api/connection", new { host = "169.254.169.254", port = 8123, user = "default", password = "x", secure = false });
        Assert.Equal(HttpStatusCode.BadRequest, (await attempt()).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await attempt()).StatusCode);
        var third = await attempt();
        Assert.Equal(HttpStatusCode.TooManyRequests, third.StatusCode);
        Assert.Equal(ConnectPolicy.TooManyMessage, (await third.Content.ReadFromJsonAsync<ErrorDto>())!.Error);
    }

    private sealed record ErrorDto(string Error, string? Field);
}
