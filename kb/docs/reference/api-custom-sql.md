---
components: [src/DashboardBuilder/Features/Rows/SqlController.cs, src/DashboardBuilder/ClickHouse/SqlTranslator.cs, src/DashboardBuilder/ClickHouse/CustomSql.cs, src/DashboardBuilder/Features/Rows/SourceController.cs, src/DashboardBuilder/ClickHouse/RequestValidation.cs, src/DashboardBuilder/ClickHouse/ClickHouseGateway.cs, src/DashboardBuilder/ClickHouse/JoinPreview.cs]
---
# API: custom SQL on a card

`kind: "sql"` sources and the `sources` list on `/api/query`. The rest of the API: [api.md](api.md); the source shape shared with union and unpivot: [api.md § Source columns](api.md#source-columns).

A card's own `SELECT` ([D105](../decisions/decisions-custom-sql.md#d105--edit-sql-free-text-select-on-a-data-source-card-the-one-exception-to-rules-2-and-3)) uses the same source shape with `kind: "sql"`:
`{ kind: "sql", db, name, sql }`. `name` is the card's table name; `db`/`name` are never identifiers in SQL. `tables`, `table`, `columns` and `keep` are refused (`source.sql`).

- `POST /api/source/columns` with it answers the columns the query returns (`DESCRIBE TABLE (query)`, no rows read). `truncated` is false and `lossy` empty.
- `/api/query` (and CSV export) takes `sources: [QuerySource]` — custom SQL only (`sources[i].kind`), at most `ApiLimits.MaxJoins + 1` (`sources`), one per table (`sources[i].name`), and never beside `source` (400 `sources`). Wherever the query names `(db, name)` — `from` or a join side — it reads the derived table, so a custom-SQL card **can be joined**. Field references are checked against the query's columns (unknown → 400).
- The text: `sql` ≤ 10,000 characters (`ApiLimits.MaxCustomSqlChars`, mirrored by `LIMITS.customSql`), one `SELECT` / `WITH` statement, no `;`, no `SETTINGS`, no trailing `FORMAT name` (a column called `format` ending an `ORDER BY` is fine), no `INTO OUTFILE`, balanced brackets. A table function goes where a table goes (after `FROM` / `JOIN`, or a comma in a `FROM` list) only if it is in `AllowedTableFunctions` (`numbers`, `numbers_mt`, `zeros`, `zeros_mt`, `generate_series`, `generateSeries`, `generateRandom`, `values`, `view`, `merge`, `null`), and an outside-reading one (`BlockedFunctions`: `url`, `file`, `s3`, `remote`, `mysql`, …) is refused anywhere. A name in backticks or double quotes is checked like a bare one, and a backslash escapes inside every kind of quote, as ClickHouse reads it ([D136](../decisions/decisions-custom-sql.md#d136--edit-sql-quoted-names-are-names-and-only-listed-table-functions-go-where-a-table-goes)). Any breach is a **400 `source.sql`** with a plain sentence.
- **ClickHouse's message is returned** for a problem with the query itself (syntax, unknown column / table / function — an unknown aggregate or window function too, code 63 —, wrong types, access denied), trimmed to one line of at most 400 characters without version or stack — the one place a ClickHouse message reaches the client ([D105](../decisions/decisions-custom-sql.md#d105--edit-sql-free-text-select-on-a-data-source-card-the-one-exception-to-rules-2-and-3)). Anything else is the usual generic 502 / 504.
- The `sources` list is part of the result-cache key.

## Translate

`POST /api/sql/translate` (`Features/Rows/SqlController.cs`) — the Edit SQL dialog's syntax switch ([D106](../decisions/decisions-custom-sql.md#d106--mysql-syntax-in-edit-sql-translated-to-clickhouse)).
Body `{ sql, from, to }`; `from` and `to` are `mysql` or `clickhouse`, and different (400 `from`). `sql` is required and ≤ 10,000 characters (400 `sql`). Answer `{ sql, warnings, changes }`: `warnings` is a list (at most 5) of plain sentences about differences the translation cannot remove (text comparisons now ignore case and can be slower; the dialog shows them and they never block anything); `changes` (at most 10 names: `ilike`, `case-fold`, `div-null`, `nulls-first`, `window-null`, …) lists the repairs that make the ClickHouse query mean something other than the same text read as ClickHouse, which the browser uses to decide how to open a query.

- Needs a connected session like every endpoint (409 otherwise). It reads no rows and runs no SQL; for a MySQL → ClickHouse query that compares two columns it also has ClickHouse `DESCRIBE` them (up to 6 probes, run in parallel) to learn whether they are text — see [sql-syntax.md](../concepts/data-source/sql-syntax.md#limitations).
- **400 `sql`** when the text can't be read, is ambiguous (`||` in MySQL text) or has no faithful equivalent (compound intervals, a non-numeric interval amount, unmapped units): a plain sentence, plus `line` (1-based), `col` (1-based, end of the offending token) and `start` (0-based column) when the translator can say where. Two statements: "Only one query can be translated." Over 10 s: "The translation took too long."
- **503** `{ error }` when the server has no Python 3 or no vendored library, when the translator stopped unexpectedly (a broken pipe to python), or when all its slots are taken for 5 seconds ("The SQL translator is busy. Try again in a moment."; at most 4 translations run at once, `SqlTranslator`'s own gate, so a flood never queues without bound); the dialog then switches MySQL off.
- The result is **not** trusted: it goes through `CustomSql.Clean` when described or saved, like any custom SQL.
- Details, the limits of the translation and how it runs: [sql-syntax.md](../concepts/data-source/sql-syntax.md).

## Syntax

`POST /api/source/syntax` (`Features/Rows/SourceController.cs`) takes the same custom SQL source as `/api/source/columns` and answers `{ syntax }`: the query as ClickHouse reads it (`EXPLAIN SYNTAX`, which prints functions as calls with names resolved and the layout gone, so two texts that print the same mean the same). Custom SQL only (400 `source.kind`); the same text rules as the columns (400 `source.sql`), ClickHouse's own words for a query problem, and no rows read. The dialog compares two of these to tell whether a MySQL round trip kept a query's meaning ([sql-syntax.md](../concepts/data-source/sql-syntax.md#the-round-trip-check)).


## Reads over a custom-SQL card

`POST /api/rows`, `POST /api/databases/{db}/tables/{table}/profile`, `POST /api/databases/{db}/tables/{table}/histogram` and `POST /api/relationships/preview` (`from.source`, `to.source`, each end on its own) take an optional `source`: `{ kind: "sql", db, name, sql }`, the card's query. The server describes the guarded text, then reads it as the derived table `(<sql>)` instead of the catalog table (`ClickHouseGateway.ReadableAsync`). Columns, filters and key kinds are validated against the **columns the query returns**; every limit, bound value, quote, time limit and `readonly=2` is unchanged. With no `columns`, View data returns the query's first 200.

Refused (400): `source.kind` when it is not `sql` (a union or unpivot), `source.name` when `db` / `name` differ from the table in the request (for profile and histogram the URL's), `source.sql` for the guard's messages, ClickHouse's own refusal, "The query returns no columns.", more than 200 columns, or a repeated column name. On the join preview the paths are prefixed `from.source.*` / `to.source.*`. The histogram reads the query three times (min, max, buckets); the join preview's per-end `LIMIT` bounds output rows, not the query. Code: `RequestRules.ValidateSqlSource`.
