---
components: [src/DashboardBuilder/Features/Core/, tests/js/, tests/live/]
---
# Testing

How to run the .NET and JS suites, what each covers, and the manual smoke and live checks.

## Test

```bash
cd /unified/user/cj/web_development/prototype/dashboard_builder
dotnet test                                  # .NET suite
dotnet test --filter Identifier              # one class
~/.nvm/versions/node/v24.20.0/bin/node --test tests/js/*.test.mjs   # JS unit tests (pure modules)
```

Node 24 is installed through nvm (not on the default `PATH`). Its built-in `node --test` runs the JS
tests with no packages. They import the pure modules straight from `src/DashboardBuilder/Features/`.

In the table below, `P##` tags (P28, P33 …) name the product phase whose cases a test covers, and
`D##` is a decision ID in [decisions-platform.md](../decisions/decisions-platform.md).

| Test class | Covers |
|---|---|
| `IdentifierTests` | validate/quote with hostile names — the highest-value test |
| `ClickHouseTypeTests` | type string → display category |
| `ConnectionEndpointTests`, `SchemaEndpointTests` | endpoint contracts, 409 without a connection, 404 on unknown names, removed endpoints 404 |
| `ErrorContractTests` | the `{ error, field? }` shape, 400/413/500 mapping, `SafeError` 502 vs 500 split, no credential in a body |
| `ValidationTests` | host / port / length validators and every limit at the bound and bound + 1 |
| `FilterTests`, `TypedFilterTests` | `BuildCondition` / `BuildSingleTableFilters` — scalar, `in` arrays, `between`, hostile operators; typed value conversion per category, `Date` rejects a time |
| `StatisticalTests` | histogram / box-plot shapes and filters, `ClampBuckets`, `ClampDistinct` |
| `ExportTests` | `CsvUtil` RFC-4180 quoting + formula-injection guard |
| `CertificateValidationTests` | the TLS bypass gate (D11) |
| `QueryGuardTests` | database-level guards: `readonly=2`, time limit, cancel-on-disconnect, the step-down on codes 164/452, the 504 timeout messages |
| `TruncationTests` | probe-row limit, trimming, the `truncated` flag in the JSON |
| `tests/js/richer-filters.test.mjs` | ops per field type, text-match / relative / top-N validity, relative → bound `between`, stat charts skip top-N |
| `JoinTypeTests` | inner / left accepted, anything else 400; `join_use_nulls` only with a left join and a server that takes settings |
| `RicherFilterTests` | text match bound + case-insensitive (hostile text never in SQL), text-only, top-N needs a measure and a whole number 1–1000, histograms refuse it |
| `ResultCacheTests` | P33 cache key: `fresh` ignored, no password, separate entries per user / server / request / cap |
| `ScaleTests` | `offset` / export-limit / `dateBucket` validation, grain → function whitelist, `auto` grain choice |
| `tests/js/query-runner.test.mjs` | latest-wins gate, result cache, truncation notice |
| `DisaggregateTests.cs`, `tests/js/sheet-plan.test.mjs` (browser: `tests/live/disaggregate-ui.mjs`) | Aggregate Measures off ([D168](../decisions/decisions-dashboards.md#d168--aggregate-measures-off-one-mark-per-source-row-on-the-point-charts)): the request rules and the field each 400 names, the cache key, the statement the stub ClickHouse receives (no `GROUP BY`, raw columns, a full-row `ORDER BY`, never sampled, the two refusals only the gateway makes); the plan (`disaggregate`, no having / Other, Top-N ignored); in the browser: the menu item ticked / disabled by chart type, 12 rows that share keys stay 12 marks across Colour series with labels on, the pills, caption and sort menu lose "sum", a bar chart stays aggregated |
| `tests/js/tab-groups-model.test.mjs` (browser: `tests/live/tab-strip-ui.mjs`) | dashboard group membership and order, colour slots, close neighbour, `fitTabWidth`, the saved-field cleaners; in the browser: one row at 12 and 50 tabs, no overlap, the dashboard name drawn once per group, icon-only labels collapsed, scroll inside the bar with Data Source and `[+]` in view, wheel, collapse (active member stays), rename and regroup, export → import round trip, a pre-groups file, dark scheme |
| `tests/js/workbook-model.test.mjs` | workbook round-trip, no password, hard failures, per-field repair + issue list, caps, storage key |
| `CustomSqlTests`, `tests/js/sql-check.test.mjs` | the Edit SQL guard on both sides: quoted table-function names, backslash escapes in backticks, the table-function allowlist (lists compared across the two files), `FORMAT` / `INTO OUTFILE` ([D136](../decisions/decisions-custom-sql.md#d136--edit-sql-quoted-names-are-names-and-only-listed-table-functions-go-where-a-table-goes)) |
| `QueryGuardTests`, `ConnectPolicyTests` | the guard step-down never drops `readonly=2` on a 452 (D137); the connect host allowlist, link-local refusal and per-address rate limit (D135) |
| `tests/live/data-source-guards-ui.mjs` (app started with `ClickHouse__AllowedHosts__0=ch.internal`) | Change connection A → B → A keeps each server's workbook its own; the Edit SQL editor flags a backtick-quoted `url`; the real server's host refusals on the connect form |
| `tests/js/api-base.test.mjs` | the API base path under a proxy prefix and at the root, `errorMessage` shapes; a 409 fires `connection:check` (also from the CSV export) and no other status does; a hung ping is released by its signal |
| `tests/js/overlays.test.mjs` (browser: `tests/live/session-lost-overlays-ui.mjs`) | `dismissOverlays`: a dialog closes through its own cancel handler, one without a handler is closed outright, the topmost is asked first, a dialog whose close opens a discard confirm still ends up closed, a stubborn one is force-closed after three passes; in the browser: with Edit member colours (from the Color flyout), a Disconnect confirm or a context menu open, the session ending leaves only the connect card, no overlay, and focus on the form |
| `tests/js/connection-health.test.mjs` (browser: `tests/live/session-lost-ui.mjs`) | health states and probe reading; the ping timeout sits between the server's 15 s probe limit and the 30 s interval; in the browser: a 409 on a card action plus a gone session returns to the connect form with the cards cleared within seconds, and a ping that never answers is given up on and the next probe still runs |
| `tests/js/validate.test.mjs` | each parser and its edge cases (blank, `1e3`, `0x10`, IPv6, over-length), `LIMITS` |
| `tests/js/filter-rules.test.mjs`, `toolbar-rules.test.mjs` | `checkFilter` / `checkAdd` / `viewCounts`; tool visibility per chart type |
| `tests/js/viewbar-model.test.mjs`, `resizer.test.mjs` | every chart type has an icon; sort-picker summary; resize width clamping |
| `tests/js/contrast.test.mjs`, `theme-model.test.mjs` (browser: `tests/live/button-states-ui.mjs`) | text contrast on every accent state, including hover and pressed, which are brighter than rest ([D134](../decisions/decisions-buttons.md)); in the browser: computed styles under a real pointer for 12 button kinds — rest < hover ≤ pressed and a visible hover, in light and dark on Signal and Blue |
| `tests/js/edge-resize.test.mjs` (browser: `tests/live/edge-resize-ui.mjs`) | the bottom-edge grip strip, height clamping, remembered heights (corrupt / blocked storage); in the browser: hover, drag up / down, content cap, minimum, reload, double-click reset, `Alt+↑/↓`, collapsed card |
| `tests/live/design-probe.mjs` (a helper, not a test: `designProbe(ev, selector)`) | a component on screen, measured in light, dark and One Dark: near-miss alignment of siblings and nested items, off-scale gaps and uneven rhythm, colours that are not tokens, text contrast, type and radius scale, clipped or ellipsised text, small hit targets. Used by the design check ([design-review.md](../development/design-review.md)) |
| `tests/js/card-height.test.mjs` (browser: `tests/live/card-resize-ui.mjs`) | a Data Source card's list height from a top / bottom edge drag: 8px steps, minimum, content cap, top edge stops at y 0, saved `listHeight` round trip and reset; in the browser: hit strips and cursor, both edges (the other edge stays put), cap, minimum, ↓ key, double-click reset, short table, collapsed card, hover line |
| `tests/js/period-model.test.mjs` | presets and calendar edges, previous / last-year comparison (29 Feb), Date vs DateTime range filter, change / tone / %, row alignment, target |
| `tests/js/parameters-model.test.mjs` | value checks by type / list / range, bound filters read the value (missing → empty), Top N from a parameter (clamped), saved-parameter checks; workbook case: round-trip and orphan references unlinked |
| `tests/js/analytics-model.test.mjs` | reference values, exact linear / quadratic / log fits and R², forecast extension, totals by aggregation |
| `tests/js/confirm-delete.test.mjs` | `confirmDestructive`: one dialog; confirmed → true, the message says it can't be undone and no second dialog follows; Cancel / Esc → false |
| `tests/js/table-calc.test.mjs` | each calculation, blanks, competition rank (Other unranked), along Columns vs Rows partitions, renamed measures, `%` suffix |
| `tests/js/date-parts.test.mjs` | part steps (Date stops at day), labels per part, only grouping parts relabel their own key |
| `DatePartTests` (.NET) | each part → one function; auto / exact untouched; hostile / unknown parts rejected (400) |
| `tests/js/action-model.test.mjs` | link templates: https-only, host required, `{value}` encoded and unable to escape its slot or change the host |
| `tests/js/workbook-model.test.mjs` (P28 case) | field settings round-trip; bad keys / aliases / aggregations dropped and counted |
| `tests/js/workbook-model.test.mjs` (P40 cases) | shared filters round-trip / cap 4 / bad ops dropped; field choices kept, shown field included, junk dropped |
| `tests/js/palette-model.test.mjs` | palettes: `checkNewPalette` (every refusal and its reason, the limits), the Create palette draft edits (add, set, remove, choose; the 25th colour refused), cleaning on open, applying in order |
| `tests/js/theme-model.test.mjs` | **every preset and derived custom accent passes contrast in light and dark**, refusals, the generated chart colours (no red, S ≤ 70 %, ≥ 3:1, distinct), saved-theme checks |
| `tests/js/p36-charts.test.mjs` | waterfall steps (incl. below zero), round maxima, small-multiples grid, fit rules and registration of the seven P36 types |
| `tests/js/gantt-model.test.mjs` | Gantt bars (number / date start, skipped rows, calendar-day lengths across a DST change), axis time, label margin, registration |
| `tests/js/gantt-end.test.mjs` | Gantt length from an end field (numbers, dates, DST), colour slots and groups, `ganttSplit`, click / Colour registration, the `ganttLength` workbook field |
| `tests/js/conditional-model.test.mjs` | scale tints (sequential / diverging, midpoint), **every tint ≥ 4.5:1 light and dark**, data bars from zero, first-match rules |
| `tests/js/scale-model.test.mjs` | table paging plan + progress, Other row, date-grouping plan, zoom past 1,000 categories, canvas mark counts |
| `tests/js/chart-polish.test.mjs` | R² in words, the KPI last-member note, whole-number histogram labels |
| `tests/js/chart-fit.test.mjs` | per-category slots (grouped, horizontal, heatmap), label rotation by pane width (and by the shared width under Fit width), no minimum for pie/scatter/treemap |
| `tests/js/relation-rules.test.mjs`, `table-filter.test.mjs`, `empty-state.test.mjs`, `icons.test.mjs`, `contrast.test.mjs`, `format.test.mjs` | the other pure modules |
| `tests/js/tokens.test.mjs` | no retired token, no hex outside `:root`, dark block redefines the surfaces, no stylesheet reads `prefers-color-scheme`, glass fallbacks cover dark |
| `tests/js/scheme.test.mjs` | Light / Dark only, unknown or retired `"system"` stored values → Light, no OS read in `scheme.js` or `scheme-boot.js`, and `scheme-boot.js` agreeing with `normalizePref` (incl. blocked storage) |

## Smoke and live checks

**Error-contract smoke test.** Each of these returns the documented status and a `{ error }` body:
malformed JSON, an empty body, wrong types, an oversized body, 17 filters, `limit: 0`, a text value on a
number column, and `POST /api/query {}` (400 "'from' is required.").

**Live checks** (the repo has no CI):

- `tests/live/calc-smoke.mjs` tests calculated fields against the shared test ClickHouse server. It
  needs credentials, so it is a manual check; re-run it before every deploy.
- `tests/live/calc-ui.mjs` needs only the dev app.
- `SqlTranslatorTests` (.NET) runs the real translator, so `python3` must be on the `PATH` (the vendored sqlglot is in `src/DashboardBuilder/Tools`). `tests/live/edit-sql-ui.mjs` mocks the translator.
- `tests/live/translate-smoke.mjs` asks a **real ClickHouse** whether the translator's SQL still returns what MySQL's rules say (379 cases, including the `col = col` pairs whose types ClickHouse describes and the window-function, `LPAD`, sub-second `TIMESTAMPDIFF` and outer-join NULL cases), whether 46 typical MySQL queries (joins, CTEs, windows, subqueries, the common functions) translate and run, and measures how many typical ClickHouse queries open in MySQL syntax. It only reads (`SELECT`, `DESCRIBE`, `EXPLAIN SYNTAX`; it sends `join_use_nulls=1` as the app's connection does; `ONLY=<regex>` runs some cases, `SKIP_PART2=1` skips the measurement). Run it after upgrading ClickHouse or sqlglot and before a deploy that touches `Tools/sql_translate.py`: `CH_HOST=… CH_PORT=8443 CH_USER=… CH_PASSWORD=… NODE_EXTRA_CA_CERTS=<ca.pem> node tests/live/translate-smoke.mjs` (read-only; the password is never printed; `PLAIN_HTTP=1` for http). Exit 1 if a case differs.
- `node tests/live/run-ui-all.mjs` starts the dev app once (a free port, or `UI_PORT` when set and free;
  `ONLY=calc,rows` filters) and runs every `tests/live/*-ui.mjs` browser check against it. It then stops
  the app by port and prints a pass / fail line per check. The full run takes more than ten minutes, so start
  it in the background. Run it from the solution root before merging a change to the worksheet; it must end
  `fail=0`.
- `tests/live/model.mjs` holds the setup the checks share. `relateTables` draws a relationship on the canvas
  and is called after two tables load, because a table card with no relationship is held out of the field
  pane once the model has two cards. `NEW_CALC`, `PAGE_CHIP`, `CALC_NAMES` and `CALC_LIST_TEXT` reach
  calculated fields, which live in the sidebar's Calculated fields dialog. They open it only while needed,
  because a dialog left open blocks real mouse and key input.
- `tests/js/calc-limits.test.mjs` keeps the three copies of the calculation limits equal.
