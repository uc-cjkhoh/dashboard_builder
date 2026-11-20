---
components: [src/DashboardBuilder/ClickHouse/, src/DashboardBuilder/Features/Calc/, src/DashboardBuilder/Features/Connection/, src/DashboardBuilder/Features/Core/, src/DashboardBuilder/Features/Dashboard/, src/DashboardBuilder/Features/Relations/, src/DashboardBuilder/Features/Rows/, src/DashboardBuilder/Features/Schema/, src/DashboardBuilder/Features/Shell/]
---
# API reference

The contract of every HTTP endpoint: routes, request fields, limits, response shapes and error codes.
Read it before calling or changing an endpoint.

The JSON API lives under `/api` (prefixed by `PathBase` when the app runs behind the proxy). Every
endpoint is **read-only** against ClickHouse
([golden rule 1](../development/coding-standards.md#1-the-server-is-read-only-against-clickhouse)).
Controllers are attribute-routed `[ApiController]`s that subclass `Features/ApiControllerBase.cs`. The
SQL each one runs is in [clickhouse-integration.md](clickhouse-integration.md#the-queries-all-read-only).

## Errors

Every failure returns **one JSON shape**: `{ "error": "<sentence>", "field": "<path>?" }`.

`field` is the offending input (`host`, `filters[2].values`, `measures[0]`); it is omitted when there
isn't one. The sentence is user-facing: no CLR (.NET runtime) type names, parser positions, stack traces or
credentials. The client (`Core/api.js`) shows `error` as-is. A non-JSON error body becomes
"Server error (status)." / "Request failed (status).".

| Code | When | Body |
|---|---|---|
| 200 | success | the result |
| 400 | invalid input: model binding (missing field, wrong type, malformed or empty JSON), a [limit](#limits) broken, a filter value that doesn't fit its column, an aggregation the column can't take, an unknown sort column, or (query/stat routes) an unknown identifier or a table not in the query | `{ error, field? }` |
| 404 | unknown database / table / column on the **schema** routes (`UnknownIdentifierException`) | `{ error }` |
| 409 | no connection in this session (`NotConnected`) | `{ error }` |
| 413 | request body over 256 KB | `{ "error": "Request too large." }` |
| 502 | ClickHouse (or the network / TLS) rejected or failed the query — credential-safe message; only the exception *type* is logged | `{ error }` |
| 504 | the query hit the server-side time limit (12 s), or the 15 s HTTP timeout on a connection without it — actionable message, see [guards](clickhouse-integration.md#database-level-guards) | `{ error }` |
| 500 | our own bug — anything else | `{ "error": "Unexpected error (ref <traceId>)." }`; the same ref and exception type are logged |

- **Order of checks:** model binding runs first, so `POST /api/query {}` is **400** "'from' is required."
  even with no connection. A valid body without a connection is 409.
- **Calculated fields in binding:** for [calculated fields](api-calculated-fields.md#rules), only a malformed tree fails
  in binding ("'measures[0].calc' has an invalid value."): an unknown or missing `k`, a missing or wrongly typed
  member, a non-finite number, or nesting past MVC's JSON depth limit of 32 (about 30 levels of tree).
- **Semantic checks run after the 409 gate:** role, limits, label, unknown field and type are checked in
  `RequestRules` / the gateway inside `RunAsync`, as is a plain measure's missing `agg` ("'measures[0].agg' is required.").
- **Machinery:** `ApiBehaviorOptions.InvalidModelStateResponseFactory` (`Features/ApiErrors.cs`) shapes
  binding failures (first error only). `ApiControllerBase.RunAsync` maps validation → 400, unknown
  identifier → 400/404, ClickHouse failures → 502/504 and anything else → 500. `UseExceptionHandler`
  catches whatever escapes a controller. The log category is the controller's full type name
  (`DashboardBuilder.Features.Dashboard.QueryController`, …).
- **Known gap:** an unmatched `/api/*` route returns an **empty-body 404** (no `{ error }`).

## Limits

Inputs are **rejected, never silently clamped or dropped**. The limits are `ApiLimits` in
`ClickHouse/RequestValidation.cs`. The client mirrors them in `Core/validate.js` `LIMITS` and checks first,
so a valid UI never hits these.

| Input | Limit |
|---|---|
| Request body (JSON APIs) | 256 KB → 413 |
| Connect `host` / `user` / `password` | ≤ 253 / 64 / 256 characters; host is a name, IPv4 or IPv6 with no scheme, port or path; `port` required, 1–65535 |
| Row + column dimensions | ≤ 12 in total |
| Measures | ≤ 10 (calculated measures count toward it, as calculated dimensions count toward the 12) |
| Joins | ≤ 10 |
| Filters per query | **≤ 20** (`MaxFilters`). The client allows 8 user filters, and the worksheet appends the shared filters (≤ 4), the drill path (≤ 5), the page, the selection and the date range |
| Collapsed crosstab headers (client-side only) | ≤ 200 keys per axis, a key ≤ 600 characters (`MAX_COLLAPSED` in `Dashboard/collapse-model.js`) |
| Member colours (client-side only) | ≤ 100 coloured members per field, ≤ 20 fields per sheet, member key ≤ 100 characters, colour `#rrggbb` (`LIMITS.memberColors` / `memberColorFields` / `memberField` / `memberKey`); member shapes use the same counts, a value is one of seven shape keys, and Shape bins are 2–6 ([worksheet-marks-shape-label.md](../concepts/worksheet/worksheet-marks-shape-label.md#edit-member-shapes)) |
| `in` / `notin` values | ≤ 500; a filter value ≤ 1000 characters |
| `offset` (rows, `/api/rows` and `/api/unpivot`) | 0–100,000 (`MaxRowsOffset`, mirrored by `LIMITS.rowsOffset`) |
| `limit` (rows) | 1–1000, default 100 (`MaxRowsLimit`, mirrored by `LIMITS.viewRows`); ≤ 200 `columns` (`MaxRowsColumns`); a cell ≤ 1000 characters (`MaxCellLength`, cut not rejected); rows × columns ≤ 50,000 (`MaxRowsCells`, `LIMITS.viewCells`) |
| `limit` (query, box plot, distinct) | 1–5000 (default 50; [D24](../decisions/decisions-platform.md#d24--showing-all-data-bounded-requests-paging-other-date-grouping)) · CSV export 1–100,000 · distinct 1–1000 (default 200) |
| `limit` (profile) | 1–50 top values, default 10 (`MaxProfileTop`); `column` ≤ 1000 characters (`MaxColumnName`); no scan bound (every row is read), a value ≤ 100 characters (`ProfileValueLength`) — mirrored by `PROFILE_LIMITS` in `Schema/column-profile-model.js` |
| `offset` (query) | 0–10,000,000 |
| `having` (query) | filters on aggregated measures (`HavingFilter`: `measure` index into `measures`, `op` `= != > >= < <= between`, `value` or `values [from, to]` plain numbers): ≤ 10 (`MaxHaving`, `LIMITS.having`); bad `op` → 400 `having[i].op`, non-number or From > To → `having[i].value` / `.values`, index outside the view → `having[i].measure`, with `otherBucket` → `otherBucket` ([D84](../decisions/decisions-filters.md#d84--a-filter-on-an-aggregated-measure-having-keeps-groups-after-grouping)) |
| Filter `calc` | a calculated filter: `db` / `table` empty, `column` the label, `calc` a row-level tree (an aggregate, `op: "top"` or a `cast` is 400 at `filters[i].calc` / `.cast`); values bound as for a plain field, coerced by the calculation's type ([D82](../decisions/decisions-filters.md#d82--a-calculated-field-is-a-row-filter-applied-before-grouping)) |
| Filter `op` | also `contains`, `startsWith`, `endsWith` (text columns, value required) and `top` (value 1–1000 + `topBy` measure, optional `bottom`; worksheet query and box plot; the histogram rejects it) |
| `joins[].pairs` | optional extra key pairs (kinds and repeated pairs are not checked here — the real join leaves a mismatch to ClickHouse, which coerces or refuses it; only the dialog and the preview check kinds) `[{ left, right }]` (column names on the join's two tables; ≤ 3, so a join matches on ≤ 4 pairs, `ApiLimits.MaxJoinPairs`) — more → 400 `joins[i].pairs`; a blank name → 400 `joins[i].pairs[k].left` / `.right`; an unknown column → 400 |
| `joins[].aggregate`, `joins[].filterDirection` | `aggregate: true` groups each table to the key before joining ([D86](../decisions/decisions-dashboards.md#d86--aggregate-before-joining-is-a-per-relationship-option-on-a-two-table-view)); `filterDirection` `both` (default) or `single` (else 400 `joins[i].filterDirection`). With `aggregate`: the view must have exactly one join (400 `joins`), no calculated measure / dimension / filter and no `top` filter (400 at that field), and only `count`, `sum`, `min`, `max`, `countnonnull`, `avg` measures (400 `measures[i]`) |
| `joins[].type` | `inner` (default), `left`, `right` or `full` (anything else 400, `joins[i].type`; `top` filters with right/full 400); a join key can't carry `calc` (400, `joins[i].left.calc` / `.right.calc`) |
| `calc` tree (dimension, measure, `topBy`) | depth ≤ 12 (root is depth 1), ≤ 200 nodes (`CalcLimits.MaxDepth`, `MaxNodes`); the label in `column` ≤ 60 characters (`CalcLimits.MaxName`, error at `….column`). Formula ≤ 500 characters and ≤ 20 calculations per workbook are client-only (`CalcLimits.MaxFormula`, `MaxCalcs`; mirrored by `LIMITS.calcFormula`, `LIMITS.calculations`, `LIMITS.calcName` in `validate.js` and by `CALC_LIMITS` in `Features/Calc/calc-types.js`) — the server never sees formula text |
| `latest` (`GET …/columns/{col}/latest`) | `{ latest: "YYYY-MM-DD" \| null }` — the newest day of a date / date-time column (one read-only `maxOrNull`, time-limited); a non-date column is refused (404) |
| `fresh`, `approximate` (query) | booleans — skip the result cache; approximate mode ([D25](../decisions/decisions-platform.md#d25--a-short-lived-server-result-cache-and-approximate-mode)). The response adds `cached` and `approx: { distinct, sample }` |
| `datePart` (a row / column dimension) | `auto`, `exact`, `year`, `quarter`, `month`, `week`, `day`, `hour`, `quarterOfYear`, `monthOfYear`, `dayOfWeek`, `hourOfDay`; date columns only |
| `cast` (dimension, measure, filter, `topBy`) | `text`, `number`, `date`; the column is read as that type (NULL where a value doesn't convert). Unknown word, a calculation, or a pairing with no safe conversion (date → number, number → date) is a 400 at `….cast` / the field |
| `dateBucket` (query) | `auto`, `hour`, `day`, `week`, `month`, `quarter`, `year` |
| Histogram `buckets` | 1–100 |
| `sort.column` | must be a generated `k{n}` / `v{n}` alias for this request |

## Typed filter values

A filter value is converted to its column's category before it is bound. The category comes from the
`DESCRIBE` the validator already runs. A value that doesn't fit is a **400** naming the value and column,
never a ClickHouse 502.

- **number** → plain decimal or exponent (no `1,000`, `0x10`, `NaN`). Bound as `Float64`.
- **date / datetime** → ISO `YYYY-MM-DD` or `YYYY-MM-DD HH:MM[:SS]` (`T` allowed). Bound as `String`. A
  `Date` / `Date32` column **rejects a time component**.
- **boolean** → `true` / `false` / `1` / `0`. Bound as `UInt8`.
- **text** → any value. **compound / other** → 400 ("can't be compared").
- `between` needs both bounds and From ≤ To (number, date).
- `in` and `notin` need ≥ 1 value. `notin` is Exclude and keeps NULL rows.

Temporal values are **ISO everywhere**. Keys, distinct values and box-plot labels use `YYYY-MM-DD` or
`YYYY-MM-DD HH:MM:SS`; a midnight `DateTime` also renders date-only. So what the app shows round-trips as
a filter value.

## Connection

Controller: `Features/Connection/ConnectionController.cs`.

| Method & path | Purpose | ClickHouse |
|---|---|---|
| `POST /api/connection` | validate and store the session connection (host, port, user, password, secure, allowInvalidCert); steps the guard settings down if the server refuses one; failures name their cause ([Connect errors](#connect-errors)) | `SELECT 1` |
| `GET /api/connection` | current connection view — password-free | — |
| `GET /api/connection/ping` | liveness probe → `{ connected, reachable }`; `connected:false` = the session lost its connection; `reachable` = `SELECT 1` succeeded | `SELECT 1` |
| `POST /api/connection/disconnect` | drop the session connection; body `{}` (proxy-safe) | — |
| `DELETE /api/connection` | same, direct to Kestrel only — the `:8443` proxy 403s `DELETE` | — |

## Schema

Controller: `Features/Schema/SchemaController.cs`.

| Method & path | Purpose | ClickHouse |
|---|---|---|
| `GET /api/databases` | list databases | `SHOW DATABASES` |
| `GET /api/databases/{db}/tables` | list tables | `SHOW TABLES FROM {db}` |
| `GET /api/databases/{db}/tables/{table}/columns` | columns `{name, type, category}` | `DESCRIBE TABLE` |
| `POST /api/databases/{db}/tables/{table}/profile` | column profile — see [below](#column-profile) | two bounded `SELECT`s |
| `GET /api/databases/{db}/tables/{table}/columns/{column}/distinct?limit=` | distinct values for an `in` filter / Pages (default 200, 1–1000 else 400) | `SELECT DISTINCT … LIMIT n` |

### Column profile

Body `{ column, limit? }` → `{ column, type, category, rows, nulls, distinct, min, max, top: [{ value, count, cut }] }`.
- It reads **every row** of the table ([D143](../decisions/decisions-performance.md#d143--the-column-profile-reads-every-row)); the result is still bounded
  (one stats row, ≤ 50 top values). A scan that outlasts the connection's time limit is a 504, not a partial answer.
- `distinct` is approximate (`uniq`, non-null). `min` / `max` are given for text, numeric and date columns only.
- In `top`, `value` null means SQL NULL. A value is cut at 100 characters, counted in characters, not bytes
  (`cut`). Values that differ only after character 100 count together. Ties break by value.
- An unknown column or table → 404. The message names the column and its table (`Unknown column "quantity_typo" in shop.orders.`; the name is stripped of control characters and cut at 64).

## Rows

Controller: `Features/Rows/RowsController.cs`. `POST /api/rows` reads the **first rows of one table** — no
aggregation, no `ORDER BY`, no joins. Also read by the Data Source's [data preview](../concepts/data-source/canvas.md#data-preview) (custom SQL as `source`).

| Field | Rule |
|---|---|
| `db`, `table` | required; validated against the live catalog (unknown → 400) |
| `columns` | optional, ≤ 200, each a catalog column (unknown → 400, `columns[i]` blank → 400); order kept. Default: the table's first 200 |
| `filters` | optional `StatFilter`s (`column`, `op`, `value`, `values`, optional `calc`) — the typed rules of the histogram / box plot ([Typed filter values](#typed-filter-values)), ≤ 20, each bound; `top` is a 400; unknown column → 400 |
| `limit` | 1–1000, default 100; outside → 400 (`limit`), never clamped. **rows × columns ≤ 50,000** (`MaxRowsCells`): over it is a 400 on `limit` saying how many rows fit (checked after the default column set is known) |
| `offset` | optional, 0–100,000 (`ApiLimits.MaxRowsOffset`, mirrored by `LIMITS.rowsOffset`); outside → 400 (`offset`), never clamped. Rows to skip: the Data Source preview's pages ([D131](../decisions/decisions-custom-sql.md#d131--the-data-preview-pages-100-rows-at-a-time)). When sent (0 included) a stored table is read with `SETTINGS max_threads = 1`, so consecutive pages follow one order; a `source` (custom SQL) is read as written, and a server that takes no settings gets the offset alone. Absent: the read is unchanged |

Response `{ columns: [{name, type}], rows: [[string \| null]], truncated, limit, columnsTruncated }`:
- Every cell is display text (numbers invariant, dates ISO, arrays compact) or `null` for SQL NULL.
- A cell is cut at 1000 characters plus `…` **inside ClickHouse**, so a huge value never leaves it (SQL:
  [clickhouse-integration.md](clickhouse-integration.md#column-profile-box-plot-raw-rows-and-join-preview)). Arrays, tuples, maps
  and dates read as `toString` prints them.
- `truncated` = more rows matched than `limit`. `columnsTruncated` = the default column set was cut. Errors use the usual `{ error, field? }` shape: 400 for rule breaks and unknown names, 409 not connected,
  502 / 504 ClickHouse.

### Union and unpivot

`POST /api/union` (2–5 tables stacked) and `POST /api/unpivot` (wide columns turned into rows, with an optional `offset` like `/api/rows`) answer in the `/api/rows` shape: [api-union-unpivot.md](api-union-unpivot.md).

### Source columns

Controller: `Features/Rows/SourceController.cs`. `POST /api/source/columns` takes a source definition and answers
`{ columns: [{ name, type, category }], truncated, lossy }` — the columns the Data Source card and the field pane list.
It reads no rows. `lossy` lists the columns read as `Float64` because their types differ with no exact common type.

A **source** (`QuerySource`; `/api/query` carries it as `source`) is `{ kind, db, name, … }`:

| Field | Rule |
|---|---|
| `kind` | `union`, `unpivot` or `sql` (custom SQL, [api-custom-sql.md](api-custom-sql.md)), else 400 (`source.kind`) |
| `db`, `name` | required (`source.db`, `source.name`); `name` ≤ 200 characters (`ApiLimits.MaxSourceName`, mirrored by `LIMITS.sourceName`) — the table name the query's fields carry; never an identifier in SQL |
| union: `tables` | 2–5 distinct, non-blank names (`source.tables`, `source.tables[i]`); unknown → unknown identifier; `table` and `keep` are refused |
| union: `columns` | optional, ≤ 200 distinct non-blank names (`source.columns[i]`); default every column shared by name and kind; none shared → 400 (`source.tables`); one missing from a table is unknown; one of a different kind is 400; the first 200 shared columns are returned with `truncated` |
| unpivot: `table`, `columns`, `keep` | as `/api/unpivot` (2–50 distinct same-kind columns; ≤ 5 distinct kept ones, none also unpivoted), paths prefixed `source.`; `tables` is refused |

`/api/query` with `source`:

- `from` must be `(source.db, source.name)` (400 `from`), and `joins` must be empty (400 `joins`). Every field
  reference names that same `(db, name)`; any other table is a 400 ("Field references a table not in the query.").
- The result shape, limits and caching are the same as for a table query. The definition is part of the cache key.

SQL and rules: [query-sources.md](../concepts/data-source/query-sources.md#sql-shape). A card's own `SELECT` (`kind: "sql"`, `sources` on `/api/query`): [api-custom-sql.md](api-custom-sql.md).

## Relationship preview

Controller: `Features/Relations/RelationsController.cs`. `POST /api/relationships/preview` — the relationship
dialog's suggestion (run as the dialog opens): bounded, read-only match and duplicate counts for one key pair. Joins nothing, writes nothing.

| Field | Rule |
|---|---|
| `from`, `to` | `{ db, table, column }` each, all required (400 at `from.db`, `to.column`, …); catalog-validated (unknown → 400) |
| key kinds | must be joinable and equal: number-number, text-text, date-date, boolean-boolean — else 400 `Can't relate a.x (numeric) to b.y (text) — join keys must hold the same kind of value.` (field `to.column`) |
| `pairs` | optional extra key pairs `[{ left, right }]` of a compound key (≤ 3; 400 `pairs`, `pairs[k].left` / `.right`); each is catalog-validated and kind-checked like the first. The key is the parts joined as strings, NULL when any part is NULL; numbers are read as Float64 and dates as DateTime64 first, so `1.00` / `1` and a Date / DateTime midnight still match |
| `sampleLimit` | optional, 1–1,000,000 (default and cap `MaxSampleRows`): rows read from **each** table; outside → 400 (`sampleLimit`), never clamped |

Response `{ from, to, sampleLimit, sampled }`. Each side is `{ rows, nullRows, keys, matchedKeys, matchedRows, maxDuplicates, avgDuplicates }`
over the rows examined:

- `keys` = distinct non-NULL keys. `matchedKeys` / `matchedRows` = those present on the other side; NULL never matches.
- `maxDuplicates` / `avgDuplicates` = how often a key repeats within the side.
- `sampled` is true when a side reached the bound. The numbers then describe the first `sampleLimit` rows
  of each table, in no particular order. The two slices need not overlap, so match shares hold only
  "within the sample".
- Each table is read twice (its own stats, and the other side's key set) with no `ORDER BY`, so the reads can differ on a table being written to.

A ClickHouse "types can't be compared" error (codes 43, 53, 70, 386) is a plain 400 at `to.column`. Other
errors use the usual `{ error, field? }` shape: 409 not connected, 502 / 504 ClickHouse.

## Query

Controller: `Features/Dashboard/QueryController.cs`. All `POST` with a JSON body.

| Method & path | Purpose | Shape |
|---|---|---|
| `POST /api/query` | worksheet query across joined tables, or over one union / unpivot `source` (below); optional `offset` (paging), `withTotal`, `otherBucket`, `dateBucket` | `QueryRequest` → `QueryResult` (incl. `truncated`, `total?`, `other?`, `bucket?`) — `values` entries are a **number, a string or `null`** (see below) |
| `POST /api/query/export.csv` | CSV of the same plan, up to 100,000 rows (never an Other row) | `QueryRequest` → `text/csv` |
| `POST /api/databases/{db}/tables/{table}/boxplot` | the older single-table box plot (no joins, calculations or casts); the browser no longer calls it | `BoxPlotRequest` → the same result |
| `POST /api/databases/{db}/tables/{table}/histogram` | equal-width bins over one numeric column (whole-number widths for an integer column; the response also says `whole`) | `HistogramRequest` |
| `POST /api/boxplot` | five-number summary of a worksheet-shaped request: exactly one `rowDimensions` entry is the value (a numeric column or a row-level numeric `calc`), at most one `columnDimensions` entry the group; joins, filters (incl. `top`), casts, date parts and a `source` as in `/api/query`; no `measures` or `having` (400 `measures` / `having`); a relationship that totals each table before joining is a 400 on `joins`; `limit` 1–5000 caps the groups | `QueryRequest` → `{ groups, truncated, outliers, outliersTruncated }`; a group is `{ label, min, q1, median, q3, max, lowerWhisker, upperWhisker }` (whiskers = extreme values inside Q1 − 1.5 IQR / Q3 + 1.5 IQR; IQR = interquartile range, Q3 − Q1), an outlier `{ label, value }`, at most 500 (`ApiLimits.MaxBoxOutliers`; `outliersTruncated` when more exist) |

### Measure values and aggregations

**Measure values** (`QueryResultRow.Values`, `IReadOnlyList<object?>`) are a JSON number, a **string**
(`min` / `max` of a text or date column), or `null` (SQL NULL, or `NaN` / `∞` from an aggregate over no
rows). Consumers must not assume numbers — [worksheet-charts.md](../concepts/worksheet/worksheet-charts.md#chart-types).

- **Aggregations:** `count` (rows), `sum`, `avg`, `min`, `max`, `countDistinct`, `countNonNull` (non-NULL
  values of the column, `count(col)`), `median` (linear interpolation between the two middle values, like
  Excel `PERCENTILE.INC`), `stddev` / `variance` (sample; NULL for fewer than two values), `attr` (the one
  distinct non-NULL value of the group, else NULL), `percentile`.
- **Column types:** `sum`, `avg`, `median`, `percentile`, `stddev` and `variance` on a non-numeric column
  are a 400. `count` / `countDistinct` / `countNonNull` / `min` / `max` are fine on any column; `attr` on
  any but a compound column.
- **Result column name:** `<agg> <column>` (`median amount`, `attr status`). A percentile is
  `p<percent> <column>` (`p90 amount`, `p99.5 amount`).
- **`p`:** a **`percentile`** measure carries **`p`**, a finite number 0..1 (JSON `0.9`). It is required
  exactly when `agg` is `percentile`, and refused on any other aggregation or on a calculated measure. A
  missing or out-of-range `p` is a 400 at `measures[i].p` (never clamped); a Top-N `topBy` is checked the
  same way at `filters[i].topBy.p`. `p` reaches SQL only as a bound `Float64` and is part of the cache key.

### Calculated fields (`calc`)

A dimension, measure or `topBy` may carry a `calc` tree; the browser sends only the tree, never formula text. Node kinds, role and typing rules and error wording: [api-calculated-fields.md](api-calculated-fields.md).

### Histogram, single-table box plot and removed routes

The histogram and single-table box-plot requests carry `filters` (`StatFilter`: column, op, value, values), applied with the
same typed rules as the worksheet query. Filters on other tables can't apply to a single-table view, so the client counts them and shows a notice. A `StatFilter` may carry `calc` (a row-level calculation tree, `column` its label; the same wire as a worksheet calculated filter): every field in it must be on the request's own table (else 400), an aggregate or too deep a tree is a 400 at `filters[i].calc`, and it is compiled against that table's columns with its values bound. `POST /api/rows` takes it the same way ([D91](../decisions/decisions-filters.md#d91--a-calculated-filter-on-a-single-table-read-reads-that-table-only)).

There are no single-table `aggregate`, `preview` or `count` routes under `/api/databases/{db}/tables/{table}/`;
a request to them is an unmatched route (404). Raw rows have one home: `POST /api/rows` ([Rows](#rows)).

Request/response models: `ClickHouse/QueryModels.cs`, `StatisticalModels.cs`, `SchemaModels.cs`.

## Page

`GET /` → `Features/Shell/ShellController.cs` renders the one page. Feature assets are served at
`/features/<Feature>/<file>` (`.css`/`.js` only).

### Connect errors

`POST /api/connection` answers a failed connect with a plain message for the cause (never the password or exception text), and the form field it belongs to (any other failure: 502 "Could not connect to ClickHouse. Check the host, port, user, password, and TLS setting."):

| Cause | Status | `field` | Message |
|---|---|---|---|
| host not in `ClickHouse:AllowedHosts` (checked before any network) | 400 | `host` | This server can't connect to that host. Ask the administrator to add it to the allowed ClickHouse hosts. |
| a typed link-local or unspecified address (169.254.x.x, fe80::/10, 0.0.0.0, ::) | 400 | `host` | That address can't be a ClickHouse server. Enter the server's host name or IP address. |
| more than `ClickHouse:ConnectPerMinute` attempts (default 20) from one client address in a minute | 429 | — | Too many connection attempts. Wait a minute, then try again. |
| the account's settings profile refuses `readonly=2` itself ([D137](../decisions/decisions-connection.md#d137--a-writable-account-never-runs-without-readonly2)) | 502 | `user` | This account's settings profile refuses read-only mode (readonly=2), so it can't be used here. … |
| wrong user or password (ClickHouse code 516 / 192 / 193) | 401 | `password` | Wrong user name or password. |
| host or port does not answer (refused, DNS, timeout) | 502 | `host` | Can't reach host:port … / No answer from host:port … |
| TLS on, but the port speaks plain HTTP | 502 | — | … Turn Secure (TLS) off for an HTTP port such as 8123. |
| TLS off but the port speaks TLS; certificate not trusted | 502 | — | … Turn Secure (TLS) on … / … Switch on Trust self-signed certificate … |
