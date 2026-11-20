---
components: [src/DashboardBuilder/ClickHouse/ConnectionRegistry.cs, src/DashboardBuilder/ClickHouse/ClickHouseGateway.cs, src/DashboardBuilder/ClickHouse/AggregateJoin.cs, src/DashboardBuilder/Features/Connection/_Connection.cshtml, src/DashboardBuilder/Features/Connection/connection.js]
---
# Terminal plan: several connections on different platforms

**Status: terminal plan. Shelved by the owner on 2026-11-20 before any design doc or code. It is not scheduled and is not a to-do: it is deliberately absent from the [backlog index](index.md) file table and recommended order.** The product stays ClickHouse-only with one connection per session ([out-of-scope.md](out-of-scope.md), [connection.md](../../concepts/data-source/connection.md)). This file keeps the analysis so a later decision to reopen it starts from the findings, not from zero. If the owner reopens it, move it into the backlog proper and write the design doc first.

## The request

- Several connections open at once, each **ClickHouse or MySQL**; other platforms possible later.
- Listed in the sidebar at `section#conn-section.sidebar__section.sidebar__section--conn`, one row per connection: platform, health dot, edit, disconnect, and an add button.
- Every table of every connection usable wherever a table is usable today: canvas, relationships, worksheets, Edit SQL, including JOINs **across connections**.
- One SQL query can reference tables of several connections, written Trino-style as `connection.schema.table`. Reference for syntax and functions: Apache Trino core.
- Data size: millions of rows typically, billions occasionally.

## What the code does today

- One connection per session: `ConnectionRegistry` stores a single `ClickHouseConnectionInfo` under one session key.
- One shared data source in the browser (entities and relationships); every worksheet reads from it.
- The server is ClickHouse-specific: `ClickHouseGateway` (about 1,800 lines) builds ClickHouse SQL for aggregates, joins and calculations, quotes identifiers by the ClickHouse rules and sets `readonly=2`.
- MySQL exists only as an input dialect of Edit SQL, translated to ClickHouse SQL by `Tools/sql_translate.py` (sqlglot). There is no MySQL driver.
- Edit SQL forbids the `mysql()` table function and its relatives ([D105](../../decisions/decisions-custom-sql.md#d105--edit-sql-free-text-select-on-a-data-source-card-the-one-exception-to-rules-2-and-3)).

## What the request forces

- **No database joins across servers.** Something has to move rows between connections; that choice shapes everything else.
- **A platform driver per connection** is needed in every approach: list schemas and tables, quote identifiers, run a read-only query with a timeout, map types. It generalises today's gateway.
- **Golden rules 1 to 3 need a MySQL form.** MySQL has no per-query `readonly=2`; the equivalent is a read-only session or transaction plus a statement time limit, and a `LIMIT` on every query.
- **Rule 4 (credentials in the session only)** rules out any design that stores or forwards passwords to another service.
- **Rule 3 (bound every result)** means a join too big to run is rejected with a reason, never silently truncated.

## Approaches considered

| | Approach | For | Against |
|---|---|---|---|
| A | Run Trino as the engine; each connection is a catalog | Exact Trino syntax; the only option that joins two billion-row tables | A JVM service to run; D2 says no other server; passwords sit in Trino's catalog config (breaks rule 4) |
| B | **Push down, then join in the app** (the preferred option) | No new service; credentials stay in the session; handles big-to-small joins at billions of rows | Cannot join two large tables when neither side can be filtered or aggregated down; a planner to build |
| C | ClickHouse pulls from MySQL with `mysql()` | Least code | ClickHouse needs a network path to MySQL and receives its password in the query text; reverses D105; ClickHouse-only; no third platform |

## Option B in detail

Two connections: `ch` (ClickHouse, `analytics.events`, about 3 billion rows) and `my` (MySQL, `crm.customers`, about 200k rows).

```sql
SELECT c.country, count(*) AS n, sum(e.amount) AS revenue
FROM ch.analytics.events e
JOIN my.crm.customers c ON c.id = e.customer_id
WHERE e.ts >= DATE '2026-01-01' AND c.plan = 'pro'
GROUP BY c.country
ORDER BY revenue DESC
LIMIT 20
```

1. **Parse and check.** sqlglot's Trino dialect parses the text. Each connection prefix is matched to a session connection; every schema, table and column is validated against that connection's live catalog; anything but a `SELECT` is rejected.
2. **Split into scans**, one per connection, with only the needed columns and filters: `ch` reads `customer_id, amount, ts` where `ts >= '2026-01-01'`; `my` reads `id, country` where `plan = 'pro'`.
3. **Size each scan** with a capped, time-limited filtered `count()`.
4. **Pick a strategy** (table below).
5. **Fetch the small side** from its own source (here 38k MySQL rows).
6. **Ship it to the big side** as a ClickHouse external table and run the whole join there:
   ```sql
   SELECT c.country, count() AS n, sum(e.amount) AS revenue
   FROM analytics.events e
   INNER JOIN _t1 c ON c.id = e.customer_id
   WHERE e.ts >= '2026-01-01'
   GROUP BY c.country ORDER BY revenue DESC LIMIT 20
   ```
7. **Return** about 20 rows; nothing large passes through the app.

### Strategies, tried in order

| # | When | What happens |
|---|---|---|
| 1 | One side is small after its filters (under a cap) | Ship it to the big side's database and join there |
| 2 | The small side is only a filter | Send its keys as `IN (...)` (semi-join) |
| 3 | Neither side ships, but the big side shrinks when grouped by the join key | Pre-aggregate at its source, then join in an embedded in-memory engine (DuckDB, no disk, no service) |
| 4 | None of the above | Reject with the reason, e.g. "`ch.events` has about 2.1B rows and `my.customers` about 40M after filters; add a filter or aggregate one side" |

### Behaviour around it

- An **Explain** view shows which piece ran where, the row counts and the strategy.
- The visual builder uses the same planner: a relationship between entities of two connections plans like the SQL above; charts and tables do not change.
- Each piece is translated from Trino to the source's dialect (sqlglot). A function with no equivalent at a source (for example `approx_distinct` on MySQL) cannot be pushed down; it runs in the embedded engine after the fetch, which works only if that scan is small. The supported Trino subset would be listed in the docs.

### Sidebar sketch

```
Connections                          [+ Add]
● ch   ClickHouse  ch.example:8443   ✎  ⏻
● my   MySQL       db.example:3306   ✎  ⏻
```

## Unverified, to settle before any commitment

- Whether ClickHouse accepts external tables (HTTP multipart external data) under `readonly=2`. A spike on the test server settles it; strategy 1 depends on it.
- The caps: staged rows (about 1M) and staged bytes (about 256 MB) are guesses, not measurements.
- How session storage holds several connections, and how a workbook names a connection without storing credentials (a workbook never stores credentials).
- The MySQL read-only guard in detail (read-only transaction, `max_execution_time`, `LIMIT`).
- Whether Edit SQL takes Trino syntax beside, or instead of, the MySQL / ClickHouse toggle ([sql-syntax.md](../../concepts/data-source/sql-syntax.md)).

## Reopening checklist

1. Owner decision: scope (SQL only, or canvas and worksheets too) and approach.
2. Spike: external tables under `readonly=2`; sizing queries on both platforms.
3. Design doc with the golden-rule changes (1 to 4) and a new decision record.
4. Update [out-of-scope.md](out-of-scope.md), [overview.md](../../architecture/overview.md) and [connection.md](../../concepts/data-source/connection.md) when it ships.
