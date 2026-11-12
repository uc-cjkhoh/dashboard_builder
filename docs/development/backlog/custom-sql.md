---
components: [src/DashboardBuilder/Tools/sql_translate.py, src/DashboardBuilder/ClickHouse/CustomSql.cs, src/DashboardBuilder/ClickHouse/SqlTranslator.cs, src/DashboardBuilder/Features/Canvas/sql-dialog.js, src/DashboardBuilder/Features/Core/sql-roundtrip.js]
---
# Backlog: Edit SQL and the MySQL syntax

What the Edit SQL dialog ([sql-editor.md](../../concepts/data-source/sql-editor.md), [query-sources.md](../../concepts/data-source/query-sources.md#custom-sql-on-a-card)) and its MySQL ⇄ ClickHouse switch ([sql-syntax.md](../../concepts/data-source/sql-syntax.md), [D105](../../decisions/decisions-custom-sql.md), [D106](../../decisions/decisions-custom-sql.md#d106--mysql-syntax-in-edit-sql-translated-to-clickhouse)) still do not do. Format: [index.md](index.md#how-to-read-an-entry). Entries run by priority: **silent wrong results first, then loud failures, then gaps, then operations.**

**Measured against** ClickHouse 26.8.36.3 (the test server) with `tests/live/translate-smoke.mjs`: 31 MySQL → ClickHouse cases match MySQL's documented results; 8 of 19 typical ClickHouse queries open in MySQL syntax, 11 in ClickHouse syntax. There is no MySQL server, so "MySQL's result" is its documented behaviour.

## Decision to settle

- **How a saved ClickHouse query that filters on text opens.** Today it opens in **ClickHouse syntax** with a warning when its MySQL form would not mean the same (a string comparison, `IN`, `LIKE`, a division, a renamed column, a refused function): 11 of 19 typical queries. The alternative is to open them in MySQL (the requested default) and accept that an edit then makes the comparison ignore case — a one-line change in `keepsMeaning()` (`Canvas/sql-dialog.js`). New cards and anything written in MySQL are unaffected. Settle it, then edit [D106](../../decisions/decisions-custom-sql.md#d106--mysql-syntax-in-edit-sql-translated-to-clickhouse) in place.

## Silent differences (no error, different rows or values)

- **Text semantics beyond a literal comparison** (priority P1; effort L) — Partial: `=`, `!=`, `IN`, `NOT IN` against a text literal and `LIKE` ignore case as MySQL does; division by zero is NULL. Open, all silently ClickHouse's behaviour: a comparison between **two columns** (a join on text — the commonest case difference left), `<` / `>` / `BETWEEN` on text, **grouping, sorting and `DISTINCT` on text** (MySQL treats `'A'` and `'a'` as one value), accent-insensitivity and other collations, implicit conversions (`'1' = 1`), MySQL's SQL modes. Needs: the column types, which the translator does not have (they could be read with `DESCRIBE` of the referenced tables), and a decision on cost, because every rewrite costs the primary key on a large table (filters can run into the 12 s limit). Spec: [sql-syntax.md](../../concepts/data-source/sql-syntax.md#limitations).
- **Translation verified on one ClickHouse version** (priority P1; effort S) — Partial: `tests/live/translate-smoke.mjs` re-runs the 31 cases and the round-trip measurement against any server (it already showed `age('hour')` is wrong on 26.8). Open: run it on the oldest ClickHouse the app must support, record the minimum version, and add it to the deploy checklist for any change to `Tools/sql_translate.py` or a ClickHouse upgrade.

## Loud failures (an error or a refusal that blocks the query)

- **MySQL-only constructs passed through unchanged** (priority P2) — Open: `STR_TO_DATE`, `LAST_DAY`, `JSON_UNQUOTE`, `UNIX_TIMESTAMP`, `@var := …`, `SQL_CALC_FOUND_ROWS`, `STRAIGHT_JOIN`, `WITH RECURSIVE`, and `LIKE … ESCAPE` (ClickHouse has no `ESCAPE`) reach ClickHouse as written; it may refuse them or read them differently. `FOR UPDATE` is refused and `USE INDEX` is dropped silently. Each needs a mapping or a refusal with a reason, and an exact-output test.
- **Refusals that could become translations** (priority P2; effort S) — Open: `DATE_ADD` / `DATE_SUB` with a column as the amount (`INTERVAL n DAY`) could become `d + toIntervalDay(n)` (the interval forms are confirmed to run); `TIMESTAMPDIFF` with MICROSECOND; `||` stays refused on purpose (it is OR in MySQL and concatenation in ClickHouse) unless a per-query choice is added.

## Gaps on a custom-SQL card

- **Features that read the catalog table** (priority P2; effort M) — Open: column profile, View data, the histogram and *Check this join* are unavailable over a card with custom SQL (each says so). They would need the same `sources` derived table the worksheet query uses.
- **Union and unpivot cards** (priority P3) — Open: Edit SQL is disabled on them (they are built from their dialogs and have no SQL of their own).
- **Small rules** (priority P3) — Open: a table without a `db.` prefix resolves against the connection's default database; a new query must keep the columns the card's relationships use, but their types are not re-checked; the inner query is bounded only by the 12 s limit and the outer `LIMIT` (no `max_rows_to_read`).

## Round trip and the ClickHouse → MySQL display

- **Round-trip false alarms** (priority P2; effort M) — Partial: a query written in ClickHouse opens in MySQL only when the way back reports no meaning-changing repair, ClickHouse accepts it with the same columns, and `EXPLAIN SYNTAX` reads both texts the same way ([sql-syntax.md](../../concepts/data-source/sql-syntax.md#the-round-trip-check)). Known false alarms: a plain ascending `ORDER BY` (the `NULLS FIRST` added on the way back changes nothing, because the way to MySQL kept ClickHouse's NULL order with a `CASE` key) and `currentDatabase()` → `CURRENT_DATABASE()`. Genuine but avoidable: `count()` → `COUNT()` renames the output column.
- **ClickHouse-only syntax shown as MySQL** (priority P3) — Open: ClickHouse-only functions have no MySQL form and are upper-cased or renamed (`toDate` → `TODATE`, `arrayJoin` → `EXPLODE`); `PREWHERE` / `FINAL` / `SAMPLE` are refused; `WITH TOTALS` comes out garbled; `LIMIT n BY` gets an unrelated rewrite; array indexes shift. Mitigated: such queries open in ClickHouse syntax, and unchanged text is never re-translated.

## Operations

- **The translator process** (priority P3; effort M) — Open: it needs Python 3 on the server (without it MySQL syntax is switched off, 503); each conversion starts a process (about 0.1–0.4 s; at most 4 at once, 10 s limit), so typing in MySQL syntax is slightly delayed — a long-lived worker would remove the start-up; Python writes `__pycache__` beside the vendored library; sqlglot is pinned at 30.31.0 and upgraded by hand ([live-service.md](../../operations/live-service.md#sql-translator-mysql-syntax-in-edit-sql)); a stored query does not change when the translator is upgraded until the card is saved again.
- **Fidelity details** (priority P3) — Open: MySQL 5.7 / 8.4 / MariaDB are not told apart; the auto-formatter's dialects differ slightly from the translator's (and can print `x:: String`); a ClickHouse refusal of a translated query has no marker (its positions belong to the other text), and a query with a `/* */` comment cannot be marked in ClickHouse syntax either; one query of at most 10,000 characters.
- **Editor** (priority P3) — Open: the editor script (240 KB) loads on first use and the formatter (320 KB) on the first Format; if they cannot load, a plain text area with no highlighting, folding or checks takes over; Tab indents (Ctrl+M switches it to move focus).

## Built, not backlog

Recorded here so nothing is re-opened by mistake: `||` refused; `DATEDIFF`, `TIMESTAMPDIFF` (whole units; hours through elapsed seconds because `age('hour')` is wrong on 26.8), `DATE_ADD` / `DATE_SUB`, `LIKE` → `ILIKE`, text comparison rewrite, `DIV` by zero; the three-part round-trip check; `DESCRIBE TABLE (subquery)` and `EXPLAIN SYNTAX` confirmed on the real server.
