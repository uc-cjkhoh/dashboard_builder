using System.Net; using System.Text; using System.Text.Json;
using ClickHouse.Client; using DashboardBuilder.ClickHouse; using DashboardBuilder.Features;
using Microsoft.AspNetCore.Diagnostics; using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing; using Microsoft.Extensions.DependencyInjection; using Xunit;
namespace DashboardBuilder.Tests;
public class ErrorContractTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private static StringContent Json(string s) => new(s, Encoding.UTF8, "application/json");
    private static async Task<JsonElement> Body(HttpResponseMessage r) => JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement;

    [Fact] public async Task Malformed_json_is_a_400_with_one_error_and_no_type_names()
    {
        var r = await factory.CreateClient().PostAsync("/api/query", Json("{ not json"));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        var text = await r.Content.ReadAsStringAsync();
        Assert.Contains("\"error\"", text); Assert.DoesNotContain("errors", text); Assert.DoesNotContain("System.", text);
    }
    [Fact] public async Task A_wrongly_typed_field_names_the_field()
    {
        var r = await factory.CreateClient().PostAsync("/api/connection", Json("{\"host\":\"h\",\"port\":\"abc\",\"user\":\"u\"}"));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("port", (await Body(r)).GetProperty("field").GetString());
    }
    [Fact] public async Task An_oversized_body_is_a_413()
    {
        var big = "{\"host\":\"" + new string('a', ApiLimits.MaxBodyBytes) + "\"}";
        var r = await factory.CreateClient().PostAsync("/api/connection", Json(big));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, r.StatusCode);
        Assert.Equal("Request too large.", (await Body(r)).GetProperty("error").GetString());
    }
    [Fact] public void Our_own_bug_is_a_500_with_a_reference()
        => Assert.Equal((500, "Unexpected error (ref t-1)."), ApiControllerBase.DescribeFailure(new InvalidOperationException(), "t-1"));
    [Fact] public void A_network_failure_is_a_502()
        => Assert.Equal(502, ApiControllerBase.DescribeFailure(new HttpRequestException(), "t").Status);
    [Fact] public void A_clickhouse_rejection_is_a_502()
        => Assert.Equal(502, ApiControllerBase.DescribeFailure(new ClickHouseServerException("x", "SELECT", 62), "t").Status);
    [Fact] public async Task The_unhandled_writer_never_echoes_the_exception_message()
    {
        var ctx = new DefaultHttpContext { TraceIdentifier = "t-9" };
        ctx.Response.Body = new MemoryStream();
        ctx.RequestServices = new ServiceCollection().AddLogging().BuildServiceProvider();
        ctx.Features.Set<IExceptionHandlerFeature>(new ExceptionHandlerFeature { Error = new InvalidOperationException("pw=secret") });
        await ApiErrors.WriteUnhandledAsync(ctx);
        ctx.Response.Body.Position = 0;
        var text = await new StreamReader(ctx.Response.Body).ReadToEndAsync();
        Assert.Equal(500, ctx.Response.StatusCode); Assert.Contains("t-9", text); Assert.DoesNotContain("secret", text);
    }
}
