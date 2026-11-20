---
components: [src/DashboardBuilder/Features/Canvas/, src/DashboardBuilder/Features/Core/, src/DashboardBuilder/Features/Rows/, src/DashboardBuilder/Features/Schema/]
---
# Schema browser — database tree

The schema browser sits in the sidebar, below the Connection tile. It is one **tree** of the connected server's databases,
each opening to its tables, with one search box above it. It previews rows and feeds the canvas.

**Code:**

- `Features/Schema/` — `SchemaController.cs`, `_Schema.cshtml`, `schema.js`, `tree-model.js`, `schema-model.js`, `table-filter.js`, `schema.css`
- `Features/Rows/` — the preview dialog

## At a glance

- **Open a database** to see its tables; several can be open at once. Drag a table row onto the canvas (or press its `＋`).
- **Search** filters the whole tree: database names and table names, across every database.
- **Preview rows:** the eye button shows a table's first 20 rows, read-only, with CSV export.
- **Profile a column:** a card row's Profile button summarises every row of the column.
- **Union and unpivot** have no sidebar buttons; write them in a card's **Edit SQL** ([query-sources.md](query-sources.md#union-and-unpivot-with-edit-sql)).
- **Safety:** a database name is checked against `SHOW DATABASES` before it is used in SQL.

## The tree

- **Rows.** A database is a 32px button row: chevron, database icon, name (semibold) and, when it has any, the **number of its tables on the canvas** (`.db-row__count`, with a tooltip). Its tables are the chip rows below it, one 24px indent in (the chevron and its gap), so a table's icon and name sit exactly under its database's icon and name.
  The rows have different icons (database, table, System), so nothing relies on colour.
- **Filling it.** On `connection:changed` (connected), `schema.js` lists the databases from `GET /api/databases` (`SHOW DATABASES`). A database's **tables are listed when it first opens**
  (`GET /api/databases/{db}/tables`, `SHOW TABLES FROM {db}`) and kept until the connection changes: a closed database costs no request.
  While listing, the database shows "Loading tables…"; a failed listing shows "Could not list tables." (the server's reason as the tooltip) with **Retry**; an empty one says "No tables."
- **Latest wins.** `schema.js` keeps an `epoch` that every connect, disconnect and database reload bumps; a database listing or table listing that answers after that is dropped, so a slow answer from a server the user has left (or from a previous reload) never fills the tree, and the same-named database of the new server is never shown the old server's tables. Browser check: `tests/live/schema-latest-ui.mjs` (the first server's `shop` tables answer after the user connected to a second server).
- **System databases last.** `system`, `INFORMATION_SCHEMA` and `information_schema` sit in one closed **System** group after the user databases (`splitDatabases` in `schema-model.js`). The group's count is the tables from them on the canvas; opening it shows the databases, each opening in turn.
- **What starts open.** The databases open when this server was last used (`initialOpen` in `tree-model.js`), plus any database that already has a card on the canvas.
  A server with no memory opens its first user database. A deliberately empty open set is respected.
- **Remembered per server.** The open databases and the System group are kept in this browser (`localStorage` key `dashboardbuilder.open-databases`, names per host/port/user, at most 20 servers and 50 databases each, no secrets; `rememberOpen` / `recallOpen`).
- **Cap.** A database draws its first 200 tables, then a **Show all N tables** button (`capRows`).
- **Several databases at once.** Tables from different databases can share the canvas. A card's database appears muted after its table name on **both** cards the moment two cards share a table name from different databases, and goes again when the twin is removed (`syncDbLabels` in `canvas.js`).
- **Empty canvas.** The Data Source's empty state reads "Open a database in the sidebar." (button focuses the first database row, `#db-first`) until one is open, then "Drag a table here…" ([canvas.md](canvas.md#empty-state)). `schema.js` reports the open count with `schema:open`.

## Table rows

- **Rows.** Each table is a **table chip** (icon + name) under its database. The tree scrolls internally.
- **Drag.** Each chip is `draggable="true"` and writes the `application/x-ch-table` payload `{db, table}` on `dragstart`.
  The drop side is in [canvas.md](canvas.md#dragging-a-table-onto-the-canvas).
- **`＋` button.** The non-drag fallback on each chip. It and the preview eye sit at the row's right end, quiet (`--ink-3`) at rest and full ink on hover / focus, so they are always visible and keyboard reachable. It dispatches `table:add` `{db, table}`, which `canvas.js` consumes exactly like a drop.
  **On the canvas:** a chip whose table already has a card (`.table-chip--placed`) shows a **check** in place of the `＋`, drawn in the success green (`--ok-ink`, at rest and on hover), with the label
  "<table> is on the canvas — show it" and the tooltip "On the canvas — show it"; pressing it shows that card. Kept in step on `entity:added` / `entity:removed`, along with the database counts.
- **Keyboard.** The tree is **one Tab stop** (roving tabindex; the last focused row keeps it). Rows are `role="treeitem"` in a `role="tree"` with `aria-expanded` on databases.
  - **Up / Down / Home / End** move between the visible rows (`listStep()` in `table-filter.js`, pure), keeping a table's eye or `＋`.
  - **Right** opens a closed database, or steps into an open one. **Left** folds an open database, or steps out to the database that holds the row. On a table, Left / Right switch between its eye and `＋` (Left from the eye goes to the database).
  - **Enter / Space** on a database toggles it; on `＋` adds the table.
- **Search.** A search box (`#table-search`, `maxlength` 100) above the tree filters it (`filterTree` in `tree-model.js`, case-insensitive substring).
  - A database whose own name matches keeps all its tables; otherwise only matching tables show, and a database with none drops out. Matches show open (a database can still be folded during one search; that is not remembered).
  - The **first** query lists every non-system database's tables, 4 at a time (`runLimited`), with "Searching all databases…" meanwhile.
  - System databases are not searched until the user presses **Include** next to "System not searched."; databases already listed are always searched.
  - **Enter** adds the table when exactly one row is left; **Down** moves into the tree; **Esc** clears the box. When nothing matches, "No matches." shows.
  - Clearing the box restores the tree as it was.
- **Look and tooltips.**
  - Icons are inline SVG (`Core/icons.js`).
  - A **grip** (`.table-chip__grip`) appears on hover / focus as the drag affordance.
  - The chip's tooltip says "Drag <table> onto the canvas"; the `＋` button's says "Add to the canvas (or drag the table)" (both change once the table is on the canvas).
  - Chips are tier-2 glass controls ([tokens.md](../../reference/design/tokens.md#controls-on-glass--three-tiers-and-a-state-ladder)).
  - The sidebar's headings ("Connection", "Databases and tables") are screen-reader-only; the tiles say what they are.

## Row preview

- **Opening it.** A **preview button** (eye icon, `.table-chip__peek`, `aria-label` "Preview rows of <table>") sits on each chip, quiet at rest. It opens the **rows dialog** (`Rows/rows-dialog.js`).
- **What it shows:** the first **20** rows of the table, read-only, with no ordering (the first rows in storage order).
  - Request: `tableRowsRequest` in `Rows/rows-model.js` → `POST /api/rows` ([api.md § Rows](../../reference/api.md#rows)).
  - A sticky header shows each column's **name and its ClickHouse type** exactly as the server reports it (`UInt64`, `LowCardinality(String)`, `Decimal(10, 2)`), with the same type in its tooltip. Then the rows follow.
- **The dialog** is a native `<dialog>` labelled by its title ("<table> — first rows", with the `db.table` beneath).
  - **Esc**, the X or Close closes it. Closing also cancels a request still in flight.
  - The dialog is up to 1200px wide (never wider than the viewport minus 32px); the table scrolls inside it (max 80vh), sideways only when the columns need more; the page never scrolls.
- **Cells and limits:**
  - A SQL `NULL` cell reads *NULL* in italic muted text, distinct from an empty string.
  - A cell longer than 1000 characters is cut with an ellipsis. When any cell was cut, the dialog says so
    ("Some cells were cut at 1000 characters; the CSV export has the cut text too").
  - At most the table's first 200 columns show (the footer says "first N columns").
  - The footer states "N rows" or "First N rows — more exist".
- **Export CSV** saves the rows shown, with RFC 4180 quoting. A cell starting `= + - @` is prefixed with `'`, like the server's `CsvUtil`.
- **Failure:** a 400 / 502 / 504 shows its message in the dialog and a toast; the export stays disabled.
- **Reuse:** the same dialog serves the worksheet's *View data* ([worksheet-query.md](../worksheet/worksheet-query.md#view-data)).
  Canvas entity cards still show no rows ([canvas.md](canvas.md)).

## Column profile / field details

- **Opening it.** Each field row on a canvas entity card has a **Profile button** (`.col-row__profile`, histogram `profile` icon,
  `aria-label` "Profile <column>"; half-shown on every row while the pointer or focus is in the card, full on the row itself).
  It opens the **profile dialog** (`Schema/column-profile-dialog.js`, rules in `column-profile-model.js`).
  The request is `POST /api/databases/{db}/tables/{table}/profile` ([api.md](../../reference/api.md)), read-only.
- **Title and subtitle:** the title is the column name; the subtitle reads `database.table · type · role` (the ClickHouse type as it is; *measure* for numeric, else *dimension*
  — the worksheet's rule). The dialog lists name, type and role nowhere else.
- **Figures:** Rows, Distinct (approx.) and Null share (the percent, and "n null rows" under it) in one cell, on three tracks; Min and Max for numeric and date columns sit under them on the same tracks, behind a hairline.
- **Most frequent values:** up to 10. Each is a 32px band: the label, the count and its share of all rows sit on a tint that fills the band from the left in proportion to the share.
  - NULL reads *(NULL)* and an empty string reads *(empty)*, in italic, so neither is mistaken for the text "NULL".
  - A value over 100 characters is cut with an ellipsis.
  - The tint is neutral (red means danger); the text carries every figure.
  - The NULL and empty tints are lighter than value tints, so they read as absences, not values.
- **Honesty about what was read:**
  - Every row is read: the figures describe the whole table, with no row cap and no sampling warning ([D143](../../decisions/decisions-performance.md#d143--the-column-profile-reads-every-row)).
    A table too big to scan within the connection's time limit fails with a 504 and a message, never a partial figure.
  - Values are compared by their first 100 characters (a note says so when one was cut), so values differing only later count together.
  - Distinct is an estimate.
  - A share never rounds a partial share up to 100%, and tiny ones read "<0.1%".
- **Copy name** copies the column name. **Copy values** copies the plain top values, one per line (NULL, empty and cut values left out).
  Both use `navigator.clipboard` and say so in a toast, or report that the browser blocked it.
- **Layout:** 720px wide. The dialog, header and footer are solid; the body carries the app's `--wash` over `--bg` and holds two solid `--surface` cells lifted by `--elev-card`:
  **Figures**, then **Most frequent values** (full width). A warning note, when there is one (a value was cut), is a third cell above them so the caveat comes before the figures it qualifies;
  it is a solid warn-toned strip with a 1px warn border. Each frequent-value band is a flat `--surface-2` strip; the leader (the most frequent real value, not NULL or empty)
  has a bold label and a stronger tint. Head, body and foot share a 24px side gutter (the X glyph sits on it); body padding 24px, 8px between cells.
  Below 640px the figures use two tracks. Cut text carries a `title` with the full text.
- **States:** "Reading every row…" while loading (closing cancels the request; Copy values stays disabled until figures arrive, and when the top values are all NULL, empty or cut its tooltip says why).
  A failure (404 / 502 / 504) shows icon + message in the dialog only (no toast: it would say the same thing twice). A timeout (504) is reworded by `profileFailure`:
  the server's advice (a filter, a lower Top-N, fewer fields) is for worksheets, so the dialog says the profile reads every row and a very large table can run past the limit,
  and on a custom SQL card adds "Narrow the query with Edit SQL, then profile again." **Esc**, X or Close close it.
- Not yet: sort order and semantic-role editing (see the backlog).

## Safety

`{db}` is validated against `SHOW DATABASES` (ordinal match) before it is quoted into `SHOW TABLES FROM`.
An unknown or hostile name → **404** before any SQL is built
([golden rule 2](../../development/coding-standards.md#2-never-interpolate-an-identifier-you-havent-validated)).

## Union and unpivot

The sidebar ends with the table list; it has **no Union or Unpivot buttons** ([D138](../../decisions/decisions-custom-sql.md#d138--union-and-unpivot-are-written-in-edit-sql-not-built-in-the-sidebar)).
Stacking tables and turning columns into rows are `SELECT`s, so they are written in a card's **Edit SQL**:
recipes in [query-sources.md § Union and unpivot with Edit SQL](query-sources.md#union-and-unpivot-with-edit-sql).
A union or unpivot card saved in an earlier workbook still opens and reads as before.

Splitting a text field is in [calculated-fields-formulas.md § Text functions](../worksheet/calculated-fields-formulas.md#text-functions).
