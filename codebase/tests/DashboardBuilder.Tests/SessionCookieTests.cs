using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>The session cookie carries only the session id (credentials live in server memory): it is HTTP-only, SameSite Lax, and Secure whenever the request is
/// HTTPS, which behind Apache is what its X-Forwarded-Proto header says.</summary>
public class SessionCookieTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public SessionCookieTests(WebApplicationFactory<Program> factory) => _factory = factory;

    [Fact]
    public void The_session_cookie_is_http_only_lax_and_secure_on_https()
    {
        var cookie = _factory.Services.GetRequiredService<IOptions<SessionOptions>>().Value.Cookie;
        Assert.True(cookie.HttpOnly);
        Assert.Equal(CookieSecurePolicy.SameAsRequest, cookie.SecurePolicy);
        Assert.Equal(SameSiteMode.Lax, cookie.SameSite);
        Assert.Equal("DashboardBuilder.Session", cookie.Name);
    }
}
