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
  the cache. Unversioned `/features/…` URLs keep working (`no-cache` + ETag): the deploy check uses them. A browser test must not `import('/features/…')` the unversioned URL, though: the page's modules load from `/features/v-<id>/…`, so that import is a second copy of the module with its own empty store; `tests/live/cdp.mjs` `evaluate` rewrites such imports to the page's own prefix.
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

### D143 — The column profile reads every row
The profile dialog used to scan only the first 1,000,000 rows ClickHouse returned (a `LIMIT 1000000` subquery plus `max_rows_to_read` with `read_overflow_mode = 'break'`) and said so in a warning band. It now scans the whole column, so Rows, Distinct, Null value, Min / Max and the top values describe the table.
- **Why:** the first million rows are in no particular order and not a statistical sample, so on a big table the figures could mislead; the user asked for full-data statistics.
- **What changed:** both statements lose the `LIMIT`; the row-bound settings are gone (the memory settings stay); `sampled` and `sampleLimit` leave the response; the dialog has no sampling note and the Rows tile no "first N rows" note. `ApiLimits.ProfileSampleRows` and `PROFILE_LIMITS.sampleRows` are removed.
- **Rule 3 still holds:** the *result* is bounded (one stats row, ≤ 50 top values, a value cut at 100 characters) and the query is time-limited. What is no longer bounded is the rows scanned. A table too big to finish in the connection's time limit (or the 15 s HTTP wait where there is no server-side limit) fails with a 504 and a message; there is no fallback to a partial scan.
- **Not touched:** the join check and the relationship suggestion still read at most 1,000,000 rows per side; the data preview and worksheet queries are unchanged.

### D144 — Edit SQL opens at once, and checks a query that has just opened at once
Measured with the translator's real cost (about 155 ms per call, nearly all of it importing sqlglot; a bare `python3` starts in 15 ms) and ClickHouse calls modelled at 40 ms: a card saved in ClickHouse syntax showed nothing for about 435 ms after the click (two translations, two `DESCRIBE`s, two `EXPLAIN`s before the dialog opened), and every dialog, plain or not, showed its first verdict only after the 800 ms typing pause (900 ms on a plain card, 1,290 ms on a saved one).
- **What changed:** the dialog opens first. When the open decision needs work it shows an empty, read-only editor with "Opening your query…" and fills in when the answer is ready (the translation and the editor files load in parallel). The decision is kept per (table, ClickHouse text) for the life of the page, so reopening is instant; failures are never kept. A query that has just opened is checked with no pause.
- **After:** dialog 15–25 ms in every case; first verdict 65–115 ms on a plain card (was 900), 70 ms on a reopened saved card (was 1,290), 480 ms on the first open of a saved one (was 1,290; the translation still takes its 435 ms).
- **Kept as it was:** the 800 ms pause while typing, and when a note explains how the query opened (so the note can be read before the verdict replaces it). Keystroke cost (about 4 ms on a 10,000-character query) and asset delivery (D139: 67 KB Brotli, immutable) were measured and are fine.
- **Rejected:** prefetching the editor and formatter files (cached for a year after the first load, 67 KB and 62 KB Brotli); starting `DESCRIBE` and `EXPLAIN` of the saved text alongside the second translation (saves one 40 ms step, adds two calls whenever the round trip comes back identical); a persistent server-side translation cache.
- **Not measured:** real ClickHouse round-trip times (no server was reachable); the 40 ms figure is an assumption, the translator's 155 ms is not.
