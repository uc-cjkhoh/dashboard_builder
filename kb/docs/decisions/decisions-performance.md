---
components: [src/DashboardBuilder/Program.cs, src/DashboardBuilder/Features/Shell/StaticAssets.cs, src/DashboardBuilder/ClickHouse/SharedHttpClients.cs]
---
# Decisions — performance

### D139 — Static assets live under a content-hash URL and are cached for a year; ClickHouse calls share one HTTP client per endpoint
**Assets.** The page links every `.js` / `.css` under `/features/v-<hash>/…`, where `<hash>` is the first 12 hex digits of a SHA-256 over
every feature file's path and bytes. Every ES-module import is relative, so the whole module graph sits under the same prefix.
- **Why:** the old `no-cache` header (kept so a deploy could never leave a browser with modules from two builds) made the browser
  revalidate all ~210 files on every page load. A hash in the path gives the same guarantee — a changed file changes every URL — without asking
  the server, so the response can be `public, max-age=31536000, immutable`.
- **Rules:** the HTML is never cached. A request for an *old* hash still gets the current file but `no-cache`, so a stale tab cannot poison
  the cache. Unversioned `/features/…` URLs keep working (`no-cache` + ETag): the deploy check and the live tests use them.
- **Preload and Brotli:** the server reads the static `import`s from `Shell/app.js` outward and lists every module as `<link rel="modulepreload">`,
  so the browser fetches the graph in one wave instead of six dependent ones. Each asset is Brotli-compressed once at the smallest-size level, in
  the background after start-up, and served from memory; until its bytes are ready the normal compression pipeline answers.
- **Rejected:** a query-string version (a module's own imports would not carry it); bundling or minifying (rule 10: no build step);
  lazy-loading ECharts (`renderChart` is synchronous and every caller would turn async).

**ClickHouse HTTP clients.** One `HttpClient` per (host, port, TLS, trust-any-certificate) is kept for the life of the process, so repeated
queries reuse pooled connections instead of opening a TCP (and TLS) connection per call. Credentials are not part of the client: ClickHouse.Client
sends them with each request, so sessions never share an identity (`SharedHttpClientTests`).
- Bounded to 32 clients (users name the host); connections recycle after 5 minutes and close after 1 idle minute.
- The connect check keeps a one-off client: its certificate callback records per-call state.
