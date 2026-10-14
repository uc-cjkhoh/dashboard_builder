using DashboardBuilder.ClickHouse;
using DashboardBuilder.Features;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc.Razor;
using Microsoft.AspNetCore.ResponseCompression;
using System.IO.Compression;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllersWithViews()
    .ConfigureApiBehaviorOptions(o => o.InvalidModelStateResponseFactory = ctx => ApiErrors.FromModelState(ctx.ModelState));

// Feature folders: a view lives next to its controller under /Features/{Feature}/, not under /Views.
// {1} = controller name (e.g. Shell), {0} = view name (e.g. Index) → /Features/Shell/Index.cshtml.
builder.Services.Configure<RazorViewEngineOptions>(options =>
{
    options.ViewLocationFormats.Clear();
    options.ViewLocationFormats.Add("/Features/{1}/{0}" + RazorViewEngine.ViewExtension);
    options.ViewLocationFormats.Add("/Features/Shared/{0}" + RazorViewEngine.ViewExtension);
});

// Persist the Data Protection key ring to a stable directory so keys survive process
// restarts. Without this, keys are ephemeral (or per-process under systemd), so after every
// restart the old session cookie can't be decrypted — logging a noisy
// CryptographicException ("The payload was invalid") on the user's next request. With a
// persisted key ring the cookie decrypts cleanly to a fresh session instead. (Session
// *contents* still reset on restart because the store is in-memory — see AddDistributedMemoryCache
// below — this only removes the crypto error, it does not preserve session state.)
// Defaults to a "keys" folder under the content root; override with config key
// DataProtection:KeyRingPath (e.g. a path outside the deploy dir). SetApplicationName keeps
// key isolation stable across deploys.
var keyRingPath = builder.Configuration["DataProtection:KeyRingPath"]
    ?? Path.Combine(builder.Environment.ContentRootPath, "keys");
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(keyRingPath))
    .SetApplicationName("DashboardBuilder");

// Session holds the per-session ClickHouse connection info (credentials live here and
// nowhere else — CLAUDE.md golden rule 3). The cookie carries only the session id.
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession(options =>
{
    options.Cookie.Name = "DashboardBuilder.Session";
    options.Cookie.HttpOnly = true;
    options.Cookie.IsEssential = true;
    options.IdleTimeout = TimeSpan.FromHours(2);
});
builder.Services.AddHttpContextAccessor();

// Compress API responses (JSON results and CSV export shrink 5–10×; a table page or a 5,000-group
// chart is mostly repeated keys). Fastest level: the win is bytes on the wire, not ratio. HTTPS is on
// because the API carries no secrets to leak through compression (no tokens; credentials never sent back).
builder.Services.AddResponseCompression(o =>
{
    o.EnableForHttps = true;
    o.Providers.Add<BrotliCompressionProvider>();
    o.Providers.Add<GzipCompressionProvider>();
    o.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(["text/csv"]);
});
builder.Services.Configure<BrotliCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest);
builder.Services.Configure<GzipCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest);

// Session-scoped connection store + the read-only ClickHouse gateway.
builder.Services.AddScoped<ConnectionRegistry>();
// P33: worksheet results are reused for a minute per server + user + request (bounded: ~256 units).
builder.Services.AddMemoryCache(o => o.SizeLimit = 256);
builder.Services.AddScoped<ClickHouseGateway>();

var app = builder.Build();

// When hosted behind a reverse proxy under a path prefix (e.g. Apache proxying
// /dashboardbuilder → this app), set PathBase (config key "PathBase", e.g. env
// PathBase=/dashboardbuilder) so routing, `~/` asset links, and the API all resolve under
// it. Empty (the default) = served at the site root, unchanged for local dev and tests.
var pathBase = builder.Configuration["PathBase"];
if (!string.IsNullOrWhiteSpace(pathBase))
{
    app.UsePathBase(pathBase);
}

// One error shape for everything a controller doesn't catch, and a hard cap on API body size.
app.UseResponseCompression();
app.UseExceptionHandler(new ExceptionHandlerOptions { ExceptionHandler = ApiErrors.WriteUnhandledAsync });
app.UseApiBodyLimit();

// Force revalidation of static assets. The page's <script>/<link> tags are not version-stamped and
// the ES-module imports (../Core/store.js, ../Core/ui.js, …) certainly aren't — so without this a
// browser can serve a *stale* module from an earlier deploy, breaking the (interdependent) module
// graph. `no-cache` + the ETag means unchanged files still 304 cheaply, but changed ones are always
// re-fetched.
static void NoCache(StaticFileResponseContext ctx)
    => ctx.Context.Response.Headers.CacheControl = "no-cache";

app.UseStaticFiles(new StaticFileOptions { OnPrepareResponse = NoCache });

// Serve each feature's co-located CSS/JS from its folder under /features. A restricted content-type
// map means ONLY .css and .js are ever served — the .cs source and .cshtml views in the same folders
// have no mapped content type and, with ServeUnknownFileTypes off, 404 rather than leak.
var featureAssetTypes = new FileExtensionContentTypeProvider();
featureAssetTypes.Mappings.Clear();
featureAssetTypes.Mappings[".css"] = "text/css";
featureAssetTypes.Mappings[".js"] = "text/javascript";
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(Path.Combine(builder.Environment.ContentRootPath, "Features")),
    RequestPath = "/features",
    ContentTypeProvider = featureAssetTypes,
    ServeUnknownFileTypes = false,
    OnPrepareResponse = NoCache,
});

app.UseRouting();
app.UseSession();

// The Shell page (GET /) and the read-only /api/* controllers are all attribute-routed.
app.MapControllers();

app.Run();

// Exposed so the integration tests can spin up the app via WebApplicationFactory<Program>.
public partial class Program;
