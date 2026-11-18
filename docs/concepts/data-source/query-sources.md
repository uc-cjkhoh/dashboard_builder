---
components: [src/DashboardBuilder/ClickHouse/SourceSql.cs, src/DashboardBuilder/ClickHouse/CustomSql.cs, src/DashboardBuilder/Features/Canvas/canvas.js, src/DashboardBuilder/Features/Canvas/sql-dialog.js, src/DashboardBuilder/Features/Canvas/sql-editor.js, src/DashboardBuilder/Features/Core/source-model.js, src/DashboardBuilder/Features/Rows/SourceController.cs, src/DashboardBuilder/Features/Rows/union-dialog.js, src/DashboardBuilder/Features/Rows/unpivot-dialog.js]
---
# Union and unpivot as a data source

A **union** stacks 2–5 tables. An **unpivot** turns wide same-kind columns of one table into `Field` / `Value` rows.
Either is a card on the Data Source that worksheets read like a table.
**No UI creates one any more:** the sidebar buttons were removed ([D138](../../decisions/decisions-custom-sql.md#d138--union-and-unpivot-are-written-in-edit-sql-not-built-in-the-sidebar)); write the same thing in **Edit SQL** ([recipes](#union-and-unpivot-with-edit-sql)).
This page describes the cards a **saved workbook** can still hold.

**Code:**

- `Features/Core/source-model.js` — the pure rules
- `Features/Canvas/canvas.js` — the card
- `Features/Rows/union-dialog.js` / `unpivot-dialog.js` — the former sidebar dialogs; nothing loads them now ([backlog](../../development/backlog/custom-sql.md#gaps-on-a-custom-sql-card))
- `Features/Rows/SourceController.cs`
- `ClickHouse/SourceSql.cs` — the derived table

## At a glance

- **Existing cards only.** A saved workbook's union or unpivot card has an automatic, non-editable name.
- **Union columns** are the ones every table shares by name and kind, after `Source table`; types widen to an exact type where one exists, else `Float64` with a warning.
- **Reads alone:** a source can't be joined or related to another table, and View data, profile and histogram are unavailable over it; a box plot can read it.
- **Cost:** sources are read in full; the 12 s time limit and the table / column caps are the only bounds.

## Naming one

- **Name.** The name is automatic and not editable: `Union: a + b` or `Unpivot: sales`, cut to 200 characters (`LIMITS.sourceName`).
  - If a table of the database or a card on the canvas already uses the name, it gets ` 2`, ` 3` … (`takenNames`, `uniqueName`).
  - The name is the entity's `table`, so every field reads `db.<name>.column` unchanged and labels read `Union: a + b.region`.
- **Columns** come from `POST /api/source/columns` ([api.md § Source columns](../../reference/api.md#source-columns)).
- A union with more than 200 shared columns lists the first 200 and says so in a toast.

### Union columns

- `Source table` comes first (text; the table's name).
- Then come the columns **every table has with the same name and kind**. This is the preview's rule, stated on the card ("Columns shared by name and kind."). **Compare columns** on a union card (`Canvas/union-diff.js`, rules in `unionMismatch`, `Core/source-model.js`) reads each table's catalog columns and lists what the union leaves out: columns only some tables have (and which), and columns every table has but of unlike kinds. Read-only and client-side; it sends no query.
  There is no renaming or manual alignment.
- A shared column already called `Source table` makes ours `Source table_`.

**How types are combined:**

1. Types are compared **without** `Nullable` / `LowCardinality`.
2. When the base types are equal (`Int64` and `Nullable(Int64)`, `Bool` and `Nullable(Bool)`), nothing is cast.
   The column is declared `Nullable` if any table's is.
3. When they truly differ:
   - numbers are read as the widest **exact** type.
     Integers of one signedness take the widest width. Signed with unsigned takes the next signed width (`UInt64` + `Int64` → `Int128`, `UInt128` → `Int256`).
   - text is read as `String`;
   - dates are read as `DateTime64(3)`.
4. Only when no exact type exists does a numeric column fall back to `Float64`.
   That happens with a `Decimal` in the mix, a 64-bit integer beside a float, or `UInt256` beside a signed type.
   The card then shows a second line, "Types differ: read as Float64, large values may round." (`lossy` in the columns response).
5. A compound column of differing types is a 400.

### Unpivot columns

- The kept columns come first, then `Field` (text; the column's name) and `Value`.
- `Value` has the unpivoted columns' kind. Its type is theirs if equal after dropping `Nullable`, else the union's rules above.
- A column already named `Field` / `Value` makes ours `Field_` / `Value_`.
- Unlike the preview, `Value` keeps its kind, so it aggregates (sum, avg …) and filters like a column of that kind.

## Union and unpivot with Edit SQL

Both are plain `SELECT`s, which a table card's **Edit SQL** accepts ([the guard](#custom-sql-on-a-card) allows `UNION ALL` and `ARRAY JOIN`).
Add any one table of the result to the Data Source, open its ☰ → **Edit SQL**, and save the query.
The card keeps that table's name, shows `Custom SQL`, and — unlike a union or unpivot card — can be related and joined.
MySQL syntax (the default) and ClickHouse syntax both work; the unpivot below uses `UNION ALL` in MySQL and `arrayJoin` in ClickHouse.

- **Union** — a literal for the source column, the shared columns by name, one `SELECT` per table:
  ```sql
  SELECT 'orders_2024' AS `Source table`, id, region, amount FROM shop.orders_2024
  UNION ALL
  SELECT 'orders_2025' AS `Source table`, id, region, amount FROM shop.orders_2025
  ```
  Write a `CAST` where a column's type differs between tables (`toInt128(n)`, `toFloat64(n)`): nothing is widened for you.
  Any number of tables, and tables of other databases (`db.table`), work.
- **Unpivot** — one `SELECT` per column, in MySQL syntax:
  ```sql
  SELECT id, 'q1' AS `Field`, q1 AS `Value` FROM shop.sales
  UNION ALL
  SELECT id, 'q2', q2 FROM shop.sales
  ```
  Or, in ClickHouse syntax, read the table once:
  ```sql
  SELECT id, tupleElement(p, 1) AS `Field`, tupleElement(p, 2) AS `Value`
  FROM shop.sales ARRAY JOIN [('q1', q1), ('q2', q2)] AS p
  ```
  `Value` keeps the type the query gives it, so it aggregates like a column of that kind.
- **Differences from the old cards:** no table or column cap beyond the guard's (10,000 characters, 200 columns); no automatic shared-column pick or **Compare columns** — name the columns yourself; the query runs as written, so give it an `ORDER BY` for a fixed page order.

## Reading one

- **Like a table.** The sheet plan ([worksheet.md](../worksheet/worksheet.md)) sends `source` (the definition) beside `from` = `{ db, table: name }`.
  Every field reference names the same `(db, name)`.
  Dimensions, measures, filters (including Top-N), sort, date grouping, paging, Other, approximate distinct counts, CSV
  export and the plan cache all work as for a table.
- **Reads alone.** A view that mixes a source with another table is refused in the view with
  "A union or unpivot can't be combined with another table yet — use only its own fields in this view." (`sourceProblem`).
  - The server refuses a source with `joins` (400 `joins`).
  - A source card takes no join keys and no relationship; dropping a table column on its rows says so.
  - A saved workbook's source entity carries no keys.
- **Filter member lists** (`in`, Pages, member labels, groups) use a one-dimension `/api/query` over the source (limit 201, `distinctPlan`)
  instead of the table `distinct` endpoint.
- **Not available over a source** (each says so, and nothing is sent):
  - **View data** (raw rows of one table);
  - column **profile** (no button on the card);
  - **histogram** (a single-table endpoint);
  - the approximate-mode 10 % sample (the source is read in full).

## Cost limit

A source query reads every source table in full, so a wide unpivot or a union of large tables multiplies the scan.
An unpivot reads its table once, via `arrayJoin`, but forms up to 50 rows per source row.

- The only server-side bound is `max_execution_time` (12 s).
  That bound is absent when the connection's profile refuses settings ([sharp-edges.md](../../development/sharp-edges.md#clickhouse)).
- The 50-column unpivot cap and the 2–5 table union cap are the only extra limits. No row-read guard is added.

## Saved with the workbook

An entity of a source is saved as `{ id, db, table: name, x, y, joinKeys: [], source }`, where `source` is
`{ kind: "union", db, name, tables, columns? }` or `{ kind: "unpivot", db, name, table, columns, keep }`
([data-model.md](../../reference/data-model.md#workbook-file)).

On open:

- `cleanSource` re-checks the source against the same limits, and checks that `db` / `name` match the entity.
  One that fails (including a name over 200 characters) is skipped with an import issue.
- A second entity with the same `db.table` as another (a source named like a real table) is skipped, as any duplicate is.
- A saved relationship that ends at a source is dropped with an issue.
- The columns are fetched again from the server, so a table that has since changed shows its current columns.

## SQL shape

The query is read-only and bounded like every worksheet query: the statement keeps its `LIMIT` (page + 1), the 12 s time limit and `readonly=2`.
The source is a derived table read as `t0`:

- Union: `FROM (SELECT {us0:String} AS `Source table`, `a`, toInt128(`n`) AS `n` FROM `db`.`t1` UNION ALL SELECT {us1:String} AS … FROM `db`.`t2`) AS t0`.
- Unpivot: `FROM (SELECT `k`, tupleElement(`__up`, 1) AS `Field`, tupleElement(`__up`, 2) AS `Value` FROM (SELECT `k`, arrayJoin([({uf0:String}, `q1`), ({uf1:String}, `q2`)]) AS `__up` FROM `db`.`t`)) AS t0`.

Safety rules:

- Every database, table and column is catalog-validated (`DESCRIBE`) and quoted by `Identifier` only.
- The union's table labels and the unpivot's field names are **bound** `String` parameters (`us#`, `uf#`).
  They are sent with every statement of the request: page, total, Other.
- Statements that reuse only part of the request (the auto date-grain probe) carry the parameters of their `FROM` too.
- The helper alias prefix grows until no table column starts with it.

## Custom SQL on a card

A Data Source card's ☰ menu → **Edit SQL** ([D105](../../decisions/decisions-custom-sql.md#d105--edit-sql-free-text-select-on-a-data-source-card-the-one-exception-to-rules-2-and-3)).
Unlike a union or unpivot, the card **stays an ordinary table card**: it can be related and joined, and keeps its `db.table` name.
Only its rows change: they come from the user's own `SELECT`.

- **Opening it.** **Edit SQL** in the card head's ☰ menu (`.entity__menu` in `Canvas/canvas.js`, [canvas.md § The ☰ menu](canvas.md#the--menu-card-actions)) opens the dialog; the card has no right-click menu. A union or unpivot card has no SQL of its own, so its menu has no Edit SQL.
- **Dialog** (`Canvas/sql-dialog.js`, **Edit SQL · table**): written in **MySQL** (the default) or ClickHouse syntax, chosen in the footer ([sql-syntax.md](sql-syntax.md)); a tall code editor on the card's current query, or for a table the default `SELECT` of every column, quoted, one per line (`defaultSql()`) — highlighting, syntax checking, auto-indent, bracket matching, Format and folding: [sql-editor.md](sql-editor.md). **Reset to default** refills the table's own `SELECT` (read from the catalog, not from the query's columns). **Format**, **Cancel**, Esc, and **Save** (Ctrl+Enter too). While you type, a clean query is also described by ClickHouse (debounced, no rows read) and the status line says how many columns it returns.
- **Save** sends the text to `POST /api/source/columns` as `{ kind: "sql", db, name: table, sql }`. A refusal (syntax, unknown column, a rule of the guard) appears under the text in ClickHouse's own words and **nothing on the card changes**. The default text saved unchanged is a no-op on a table card; on a custom-SQL card, saving the table's default `SELECT` goes back to the table (below).
- **After a good save** the card shows the query's columns, with a `Custom SQL` note under its head (`.entity__note--sql`) and the class `entity--sql`; rows have no profile button. `entity:sql` clears the cached columns and filter members of that table; open worksheets redraw.
- **Relationships are protected.** A new query must still return every column the card's relationships use; if not, Save is refused naming them (`lostKeys()`), and going back to the table is refused the same way (in the dialog) if the table lacks one.
- **Back to the table:** **Reset to default** then **Save** (`backToTable()`): the text matches the table's own `SELECT`, so the card reads the table's columns and drops `customSql` (toast "back to the table"); no confirm, since Save is the confirmation and Cancel undoes nothing.
- **Worksheets.** `buildPlan` adds `sources: [sqlWire(…)]` for every table in `from` or a join that has custom SQL (`sqlSourcesFor()`), so the server reads the query as that table. The member list of a filter on such a column comes from a one-dimension query (`distinctPlanSql()`); the field pane's columns from `/api/source/columns`.
- **Saved** as `customSql` on the entity (always ClickHouse SQL; plus `customSqlMysql`, the MySQL text it was written as, when it was); on open it is re-checked for type and length (`cleanCustomSql()`), the columns are fetched again from the server, and its catalog check is skipped (the pills' columns are the query's).
- **Not available over it:** column profile, View data, the histogram, and the relationship suggestion (they read the catalog table); each says so.

**SQL shape.** The checked text becomes a derived table where the query names the table: `FROM (SELECT … ) AS t0 [LEFT JOIN `db`.`other` AS t1 ON …]`, or as a join side `JOIN (SELECT … ) AS t1`; aggregate-before-join wraps it like a table. No parameter is bound for it. Approximate (sampled) reads skip a custom-SQL base table.

**The guard** (`ClickHouse/CustomSql.cs`, unit-tested in `CustomSqlTests`):

- one statement that starts with `SELECT` or `WITH`; ≤ 10,000 characters (`ApiLimits.MaxCustomSqlChars`, `LIMITS.customSql`); `--`, `#` and `/* */` comments are stripped (a trailing `--` cannot swallow the closing bracket); one trailing `;` is dropped, any other is refused;
- brackets must balance and never close early, so the text cannot leave its wrapper;
- no `SETTINGS` clause, so `readonly=2`, the time limit and result limits cannot be changed from inside;
- no table function that reads outside ClickHouse's own tables: `url`, `file`, `s3`, `remote`, `mysql`, `postgresql`, `mongodb`, `redis`, `jdbc`, `odbc`, `sqlite`, `executable`, `input`, `hdfs`, `cluster` and similar (`CustomSql.BlockedFunctions`); a *column* called `url` is fine;
- words inside quotes (`'…'`, `"…"`, `` `…` ``) are never checked;
- the columns come from `DESCRIBE TABLE (query)`; a repeated name or more than 200 columns is a 400 on `source.sql`.

Unqualified tables in the text resolve against the connection's default database; qualify them (`db.table`) to be sure.

## Not built

Listed in [data-model.md](../../development/backlog/data-model.md):

- joining a source to another table, or a relationship from a source;
- manual column alignment and rename for a union;
- editing a union or unpivot in place (a table card's SQL is editable — see above);
- Show rows / profile / histogram over a source;
- unions across databases.
