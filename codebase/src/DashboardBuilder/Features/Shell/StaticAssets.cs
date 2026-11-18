using System.Collections.Concurrent;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Primitives;

namespace DashboardBuilder.Features.Shell;

/// <summary>
/// What the page ships: a content hash of every <c>.js</c> / <c>.css</c> under <c>Features/</c> (the cache-busting id the page
/// puts in every asset URL), and the ES-module graph reachable from <c>Shell/app.js</c> (what the page tells the browser to
/// preload, so it fetches all ~190 modules in one wave instead of six dependent ones).
/// <para>Re-checked at most once a second, by file timestamp and size, so editing a file in a running dev copy (or replacing the
/// files under a running service) is picked up without a restart.</para>
/// </summary>
public sealed partial class AssetCatalog
{
    public sealed record Snapshot(string Id, string Prefix, IReadOnlyList<string> Modules);

    public const string Root = "/features";
    private const string EntryModule = "Shell/app.js";
    private static readonly TimeSpan Recheck = TimeSpan.FromSeconds(1);

    private readonly string _dir;
    private readonly Lock _gate = new();
    private Snapshot _current;
    private string _stamp;
    private long _checkedAt;

    public AssetCatalog(string featuresDir)
    {
        _dir = featuresDir;
        _stamp = Stamp();
        _current = Build();
        _checkedAt = Environment.TickCount64;
    }

    /// <summary>The current snapshot; cheap to call on every page request.</summary>
    public Snapshot Current
    {
        get
        {
            if (Environment.TickCount64 - Volatile.Read(ref _checkedAt) < Recheck.TotalMilliseconds) return _current;
            lock (_gate)
            {
                _checkedAt = Environment.TickCount64;
                var stamp = Stamp();
                if (stamp != _stamp) { _stamp = stamp; _current = Build(); }
                return _current;
            }
        }
    }

    /// <summary>Whether <paramref name="id"/> is the id the page being served right now would use.</summary>
    public bool IsCurrent(string id) => Current.Id == id;

    private IEnumerable<string> Files() => Directory.EnumerateFiles(_dir, "*", SearchOption.AllDirectories)
        .Where(f => f.EndsWith(".js", StringComparison.Ordinal) || f.EndsWith(".css", StringComparison.Ordinal))
        .OrderBy(f => f, StringComparer.Ordinal);

    private string Stamp()
    {
        var sb = new StringBuilder();
        foreach (var f in Files()) { var i = new FileInfo(f); sb.Append(f).Append(':').Append(i.LastWriteTimeUtc.Ticks).Append(':').Append(i.Length).Append(';'); }
        return sb.ToString();
    }

    private Snapshot Build()
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var f in Files())
        {
            sha.AppendData(Encoding.UTF8.GetBytes(Path.GetRelativePath(_dir, f).Replace('\\', '/') + "\n"));
            try { sha.AppendData(File.ReadAllBytes(f)); } catch (IOException) { /* being replaced: the next check rebuilds */ }
        }
        var id = Convert.ToHexString(sha.GetHashAndReset())[..12].ToLowerInvariant();
        return new Snapshot(id, "v-" + id, ModuleGraph());
    }

    [GeneratedRegex("""(?:^|\n)[ \t]*(?:import|export)\b[^;'"]*?\bfrom\s*['"](\.[^'"]+)['"]|(?:^|\n)[ \t]*import\s*['"](\.[^'"]+)['"]""")]
    private static partial Regex StaticImport();

    /// <summary>Module paths (relative to <c>Features/</c>) reachable from the entry module through static imports, entry first.
    /// A miss only means a module is fetched a little later; it never breaks the page.</summary>
    private List<string> ModuleGraph()
    {
        var seen = new HashSet<string>(StringComparer.Ordinal) { EntryModule };
        var order = new List<string> { EntryModule };
        for (var i = 0; i < order.Count; i++)
        {
            var path = Path.Combine(_dir, order[i]);
            if (!File.Exists(path)) continue;
            foreach (Match m in StaticImport().Matches(File.ReadAllText(path)))
            {
                var spec = m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value;
                var dep = Path.GetRelativePath(_dir, Path.GetFullPath(Path.Combine(_dir, Path.GetDirectoryName(order[i]) ?? "", spec))).Replace('\\', '/');
                if (dep.StartsWith("..", StringComparison.Ordinal) || !dep.EndsWith(".js", StringComparison.Ordinal)) continue;
                if (seen.Add(dep) && File.Exists(Path.Combine(_dir, dep))) order.Add(dep);
            }
        }
        return order;
    }

    // ── Brotli, once ───────────────────────────────────────────────────────────────────────────────────────────────────
    // Compressing per request at the fast level costs ~10 ms of CPU for echarts and leaves it at 432 KB; compressed once at the
    // smallest-size level it is 271 KB and costs nothing to serve. Built in the background after start-up; until a file's bytes are
    // ready the normal pipeline serves it (dynamic Brotli / gzip).

    public sealed record Packed(long Ticks, long Length, byte[] Bytes, string ETag);

    // Process-wide on purpose: entries are validated against the file's timestamp and size, so every catalog (and every test host) can
    // share them, and the expensive compression runs once per file version, one file at a time.
    private static readonly ConcurrentDictionary<string, Packed> Cache = new(StringComparer.Ordinal);
    private static readonly ConcurrentDictionary<string, bool> Queued = new(StringComparer.Ordinal);
    private static readonly SemaphoreSlim OneAtATime = new(1);
    private static readonly Lock WarmGate = new();
    private static Task? s_warm;

    /// <summary>The precompressed Brotli bytes for a file under Features/, or null while they are not ready (or the file changed).</summary>
    public Packed? PackedFor(string physicalPath)
    {
        var warming = s_warm is { IsCompleted: false };
        if (!Cache.TryGetValue(physicalPath, out var p)) { if (!warming) QueueInBackground(physicalPath); return null; } // the start-up pass is on its way to it
        var i = new FileInfo(physicalPath);
        if (i.Exists && i.LastWriteTimeUtc.Ticks == p.Ticks && i.Length == p.Length) return p;
        Cache.TryRemove(physicalPath, out _);
        if (!warming) QueueInBackground(physicalPath);
        return null;
    }

    private static void QueueInBackground(string path)
    {
        if (!Queued.TryAdd(path, true)) return;
        _ = Task.Run(() => { try { Pack(path); } catch { /* served uncompressed-by-us; the normal pipeline still works */ } finally { Queued.TryRemove(path, out _); } });
    }

    /// <summary>Compress one file at the smallest-size level; one at a time process-wide, and a file already current is skipped.</summary>
    private static void Pack(string path)
    {
        OneAtATime.Wait();
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists) return;
            if (Cache.TryGetValue(path, out var have) && have.Ticks == info.LastWriteTimeUtc.Ticks && have.Length == info.Length) return;
            var raw = File.ReadAllBytes(path);
            using var ms = new MemoryStream();
            using (var br = new BrotliStream(ms, CompressionLevel.SmallestSize, leaveOpen: true)) br.Write(raw);
            Cache[path] = new Packed(info.LastWriteTimeUtc.Ticks, info.Length, ms.ToArray(), $"\"br-{info.LastWriteTimeUtc.Ticks:x}-{info.Length:x}\"");
        }
        finally { OneAtATime.Release(); }
    }

    /// <summary>Compress every asset, one at a time, once per process (called after start-up, off the request path). Later calls
    /// return the same task.</summary>
    public Task WarmAsync()
    {
        lock (WarmGate)
            return s_warm ??= Task.Run(() => { foreach (var f in Files()) { try { Pack(f); } catch { /* skip */ } } });
    }
}

/// <summary>
/// <c>/features/v-&lt;id&gt;/…</c> is the same file as <c>/features/…</c>. When <c>&lt;id&gt;</c> is the current content id the
/// response may be cached forever (a changed file gets a new id and so a new URL); any other id (an old tab, a stale bookmark)
/// still gets the file, but must revalidate. Unversioned URLs keep working and revalidate, as before.
/// </summary>
public sealed partial class VersionedAssets(RequestDelegate next, AssetCatalog catalog)
{
    public const string ImmutableKey = "db.asset.immutable";
    [GeneratedRegex("^/features/v-[0-9a-f]{12}(?=/)")]
    private static partial Regex Versioned();

    public Task InvokeAsync(HttpContext ctx)
    {
        var path = ctx.Request.Path.Value ?? "";
        var m = Versioned().Match(path);
        if (m.Success)
        {
            ctx.Items[ImmutableKey] = catalog.IsCurrent(m.Value["/features/v-".Length..]);
            ctx.Request.Path = new PathString(AssetCatalog.Root + path[m.Length..]);
        }
        return next(ctx);
    }
}

/// <summary>Serves a feature's <c>.js</c> / <c>.css</c> from the precompressed Brotli bytes when the browser accepts Brotli and they are ready.</summary>
public sealed class PrecompressedAssets(RequestDelegate next, AssetCatalog catalog, IWebHostEnvironment env)
{
    private static readonly Dictionary<string, string> Types = new(StringComparer.OrdinalIgnoreCase) { [".js"] = "text/javascript", [".css"] = "text/css" };

    public static void SetCacheControl(HttpContext ctx)
        => ctx.Response.Headers.CacheControl = ctx.Items[VersionedAssets.ImmutableKey] is true ? "public, max-age=31536000, immutable" : "no-cache";

    public Task InvokeAsync(HttpContext ctx)
    {
        var req = ctx.Request;
        if ((!HttpMethods.IsGet(req.Method) && !HttpMethods.IsHead(req.Method)) || !req.Path.StartsWithSegments(AssetCatalog.Root, out var rest)
            || !Types.TryGetValue(Path.GetExtension(rest.Value ?? ""), out var type)
            || !AcceptsBrotli(req.Headers.AcceptEncoding)) return next(ctx);

        var features = Path.GetFullPath(Path.Combine(env.ContentRootPath, "Features"));
        var file = Path.GetFullPath(Path.Combine(features, (rest.Value ?? "").TrimStart('/')));
        if (!file.StartsWith(features + Path.DirectorySeparatorChar, StringComparison.Ordinal) || !File.Exists(file)) return next(ctx);
        var packed = catalog.PackedFor(file);
        if (packed is null) return next(ctx); // not ready yet: the normal pipeline answers

        var res = ctx.Response;
        SetCacheControl(ctx);
        res.Headers.ETag = packed.ETag;
        res.Headers.Vary = StringValues.Concat(res.Headers.Vary, "Accept-Encoding");
        if (req.Headers.IfNoneMatch.Any(v => v is not null && v.Contains(packed.ETag, StringComparison.Ordinal)))
        {
            res.StatusCode = StatusCodes.Status304NotModified;
            return Task.CompletedTask;
        }
        res.ContentType = type;
        res.Headers.ContentEncoding = "br";
        res.ContentLength = packed.Bytes.Length;
        return HttpMethods.IsHead(req.Method) ? Task.CompletedTask : res.Body.WriteAsync(packed.Bytes, ctx.RequestAborted).AsTask();
    }

    private static bool AcceptsBrotli(StringValues header)
        => header.Any(h => h is not null && h.Split(',').Any(t => t.Split(';')[0].Trim().Equals("br", StringComparison.OrdinalIgnoreCase)
                                                                    && !t.Contains("q=0,", StringComparison.Ordinal) && !t.TrimEnd().EndsWith("q=0", StringComparison.Ordinal)));
}
