---
components: [src/DashboardBuilder/Program.cs, src/DashboardBuilder/Features/Shell/Index.cshtml, src/DashboardBuilder/Features/Shell/StaticAssets.cs, src/DashboardBuilder/Features/Core/vendor/, src/DashboardBuilder/ClickHouse/ClickHouseGateway.cs, src/DashboardBuilder/ClickHouse/SharedHttpClients.cs]
---
# Resource usage

What the Dashboard Builder costs the browser, the network and the server, **before** and **after** the performance pass
of 2026-11-18 ([D139](../decisions/decisions-performance.md#d139--static-assets-live-under-a-content-hash-url-and-are-cached-for-a-year-clickhouse-calls-share-one-http-client-per-endpoint)).
Measured on the build host (`10.168.49.20`): headless Chromium (Playwright, CDP network events), Release build, the old
build (`publish/`, port 5196) against the new one (port 5197), both Kestrel directly. The page was loaded **unconnected**
(Data Source tab, no ClickHouse), so these are the fixed costs of opening the app; query-driven costs are under
[Not measured](#not-measured). "Slow link" = CDP-emulated 80 ms latency, 20 Mbit/s.

## Summary

| Metric | Before | After |
|---|---:|---:|
| Cold load, bytes on wire | 1.24 MB | **0.86 MB** (−31 %) |
| Warm reload, requests that reach the server | 212 (210 × `304`) | **2** (210 from the browser cache) |
| Warm reload, bytes on wire | 54 KB | **8 KB** |
| Warm reload, `load` event — localhost / slow link | 584 ms / 3,321 ms | 423 ms / **473 ms** |
| Cold load, `load` event — localhost / slow link | 687 ms / 3,655 ms | 490 ms / 3,247 ms |
| `echarts.min.js` on the wire | 433 KB | 271 KB |
| Server cost to send `echarts.min.js` (Brotli) | 10.6 ms per request | 1.0 ms per request |
| ClickHouse call | new TCP (+ TLS) connection each time | pooled connection reused (unmeasured, see below) |

## Page weight (cold load, empty cache)

| Resource | Requests | Wire before | Wire after | Decoded |
|---|---:|---:|---:|---:|
| HTML (`GET /`) | 1 | 6.3 KB | 8.3 KB (module preload list) | 19.5 KB → 37.8 KB |
| JavaScript — 194 app modules | 194 | ~745 KB | ~541 KB | 1.64 MB |
| JavaScript — `echarts.min.js` (classic script) | 1 | 433 KB | 271 KB | 1.03 MB |
| CSS — 15 stylesheets | 15 | 84 KB | 57 KB | 228 KB |
| `GET api/connection` | 1 | 0.3 KB | 0.3 KB | — |
| **Total** | **212** | **1.27 MB** | **0.88 MB** | **~2.9 MB** |

- Lazy vendor code, fetched on the first Edit SQL dialog (not in the cold load): `codemirror-sql.min.js` 240 KB and
  `sql-formatter.min.js` 320 KB decoded.
- Largest app modules (wire after): `dashboards.js` 216 KB decoded (52 KB), `chart.js` 112 KB (29 KB), `workbook-model.js` 61 KB (15 KB).
- Fonts and images: none (inline SVG icons, data-URI favicon).

## Requests and timing

- 212 requests on every load: 193 modules sit behind `Shell/app.js` (import depth 5; 135 at depth 2), plus 15 stylesheets, `echarts`,
  `scheme-boot.js`, the page and one API call.
- **Before:** every static file was `Cache-Control: no-cache`, so a warm reload revalidated all 210 files (210 conditional requests, each a
  `304`). On localhost that is cheap; on the slow link it is the whole cost (3.3 s of a 3.3 s load).
- **After:** assets live under `/features/v-<content hash>/` and are `immutable` for a year; a warm reload fetches only the page and
  `api/connection`. The module graph is announced with `modulepreload` and `echarts` with `preload`, so a cold load asks for everything at once.
- **What remains on a cold load:** the request count. Apache serves HTTP/1.1 on `:8443`, so only six requests run at a time (212 ÷ 6 ≈ 35
  round trips): 3.2 s on the slow link. Enabling `Protocols h2 http/1.1` on the vhost needs root on the host; bundling the modules would need a build
  step (golden rule 10).
- First contentful paint on localhost (old build only): 164 ms cold, 140 ms warm.

## Browser memory and CPU (idle, Data Source tab)

| Metric | Value |
|---|---:|
| JS heap used | 9.5 MB |
| DOM nodes | 781 |
| Event listeners | 205 |
| Observers / intervals in source | 11 call sites |

## Server (Kestrel, .NET 10)

| Metric | Value |
|---|---:|
| Resident memory (live service, idle, before) | ~134 MB |
| Resident memory (dev copy, after, incl. ~1.7 MB of precompressed assets) | ~145 MB (the old build's dev copy read ~114 MB; one sample each) |
| Threads | 21–24 |
| Start-up work added | content-hash of ~210 files (reads 3.5 MB once), Brotli-11 of all assets in the background, one file at a time (a few seconds of one core) |

- Assets are compressed **once**, not per request; until a file's Brotli bytes are ready the normal pipeline answers.
- `IMemoryCache` holds worksheet results (size limit 256 units, 1-minute TTL). The session store is in memory.
- The SQL translator (Edit SQL dialect switch) starts a `python3` child process per call, at most 4 at once (not changed).

## ClickHouse calls

- Before: `CreateHttpClient` built a new `HttpClient` and handler for every operation (20 call sites), so every introspection or worksheet
  query opened a new TCP connection, plus a TLS handshake on HTTPS servers.
- After: one pooled client per (host, port, TLS, trust flag), at most 32, connections recycled after 5 minutes. Credentials stay per request.
- **Not measured:** the saving per query depends on the ClickHouse server's distance and TLS cost; this needs a real or throwaway ClickHouse
  ([quickstart.md](../getting-started/quickstart.md)). The tests check the safety properties, not the speed.
- Query results stay bounded (5,000 chart groups, paged tables, CSV ≤ 100k rows — D24) and time-limited; JSON is Brotli/gzip compressed.

## Not measured

- Browser heap, scripting time and frame cost with a connected source and rendered worksheets (needs a real ClickHouse).
- ClickHouse server load and per-query latency (depends on the customer data).
- The live service behind Apache over a real WAN; figures above are Kestrel directly with emulated latency.

## Recommended next

- HTTP/2 on the Apache `:8443` vhost (largest remaining cold-load cost).
- Load ECharts on first chart render. It is 271 KB on the wire, but `renderChart` is synchronous, so every caller would turn async.
- Split `dashboards.js` (216 KB) and `chart.js` (112 KB) along feature lines so a Data Source session does not parse them.
