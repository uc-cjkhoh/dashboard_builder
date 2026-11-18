using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Text.RegularExpressions;
using DashboardBuilder.Features.Shell;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>How the page's files are cached and compressed: a content-hash URL prefix with `immutable`, a preload list for the module
/// graph, and Brotli computed once. The HTML itself must always revalidate.</summary>
public partial class StaticAssetTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    [GeneratedRegex("/features/(v-[0-9a-f]{12})/Core/core\\.css")] private static partial Regex CssUrl();

    private HttpClient Client(bool brotli = false)
    {
        var c = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        if (brotli) c.DefaultRequestHeaders.AcceptEncoding.Add(new StringWithQualityHeaderValue("br"));
        return c;
    }
    private async Task<string> PrefixAsync() => CssUrl().Match(await Client().GetStringAsync("/")).Groups[1].Value;

    [Fact] public async Task The_page_links_every_asset_under_one_content_hash_prefix_and_preloads_the_module_graph()
    {
        var html = await Client().GetStringAsync("/");
        var prefix = CssUrl().Match(html).Groups[1].Value;
        Assert.NotEmpty(prefix);
        Assert.DoesNotMatch(@"(?:src|href)=""/features/(?!v-)", html); // nothing is linked by its unversioned URL
        Assert.Contains($"/features/{prefix}/Shell/app.js", html);
        var preloads = Regex.Matches(html, "rel=\"modulepreload\" href=\"([^\"]+)\"").Select(m => m.Groups[1].Value).ToList();
        Assert.True(preloads.Count > 100, $"expected the module graph, got {preloads.Count}");
        Assert.Contains($"/features/{prefix}/Core/store.js", preloads);
        Assert.Contains($"/features/{prefix}/Dashboard/dashboards.js", preloads);
        Assert.DoesNotContain(preloads, p => p.Contains("/vendor/")); // the editor's libraries load on demand
    }

    [Fact] public async Task The_page_itself_is_never_cached_forever()
    {
        var r = await Client().GetAsync("/");
        Assert.True(r.Headers.CacheControl?.Public != true && r.Headers.CacheControl?.MaxAge is null or { TotalSeconds: 0 });
    }

    [Fact] public async Task A_current_hash_url_is_immutable()
    {
        var r = await Client().GetAsync($"/features/{await PrefixAsync()}/Core/store.js");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal("public, max-age=31536000, immutable", r.Headers.CacheControl?.ToString());
        Assert.Equal("text/javascript", r.Content.Headers.ContentType?.MediaType);
    }

    [Fact] public async Task An_old_hash_still_serves_the_file_but_must_revalidate()
    {
        var r = await Client().GetAsync("/features/v-000000000000/Core/store.js");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal("no-cache", r.Headers.CacheControl?.ToString());
    }

    [Fact] public async Task The_unversioned_url_still_works_and_revalidates()
    {
        var r = await Client().GetAsync("/features/Core/api.js");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal("no-cache", r.Headers.CacheControl?.ToString());
        Assert.NotNull(r.Headers.ETag);
    }

    [Fact] public async Task Only_css_and_js_are_served_and_nothing_escapes_the_features_folder()
    {
        var prefix = await PrefixAsync();
        foreach (var p in new[] { $"/features/{prefix}/Shell/ShellController.cs", $"/features/{prefix}/Shell/Index.cshtml", $"/features/{prefix}/../../Program.cs", "/features/v-000000000000/Shell/StaticAssets.cs" })
            Assert.Equal(HttpStatusCode.NotFound, (await Client(brotli: true).GetAsync(p)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Client(brotli: true).GetAsync($"/features/{prefix}/Core/..%2f..%2fProgram.cs")).StatusCode);
    }

    [Fact] public async Task Brotli_is_precompressed_once_and_answers_a_conditional_request_with_304()
    {
        await factory.Services.GetRequiredService<AssetCatalog>().WarmAsync();
        var url = $"/features/{await PrefixAsync()}/Dashboard/chart.js";
        var r = await Client(brotli: true).GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Contains("br", r.Content.Headers.ContentEncoding);
        Assert.Contains("Accept-Encoding", r.Headers.Vary);
        Assert.Equal("public, max-age=31536000, immutable", r.Headers.CacheControl?.ToString());
        var etag = r.Headers.ETag!;
        // The bytes decode to exactly the file on disk.
        await using var br = new BrotliStream(await r.Content.ReadAsStreamAsync(), CompressionMode.Decompress);
        using var ms = new MemoryStream(); await br.CopyToAsync(ms);
        var plain = await Client().GetByteArrayAsync("/features/Dashboard/chart.js");
        Assert.Equal(plain, ms.ToArray());
        // Revalidation: same ETag, no body.
        var req = new HttpRequestMessage(HttpMethod.Get, url); req.Headers.IfNoneMatch.Add(etag); req.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue("br"));
        var again = await Client().SendAsync(req);
        Assert.Equal(HttpStatusCode.NotModified, again.StatusCode);
    }

    [Fact] public async Task Without_brotli_the_file_is_still_served()
    {
        await factory.Services.GetRequiredService<AssetCatalog>().WarmAsync();
        var r = await Client().GetAsync($"/features/{await PrefixAsync()}/Dashboard/chart.js");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.DoesNotContain("br", r.Content.Headers.ContentEncoding);
    }
}
