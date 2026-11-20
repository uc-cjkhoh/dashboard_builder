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
  The dialog **grows out of that Profile button and folds back into it** on Escape, X or Close ([motion-accessibility.md](../../reference/design/motion-accessibility.md#motion), `openColumnProfile(…, origin)`); the button is passed in by the card's click handler, and without one (or under reduced motion) the dialog just appears.
  The request is `POST /api/databases/{db}/tables/{table}/profile` ([api.md](../../reference/api.md)), read-only.
- **Title and subtitle:** the title is the column name; the subtitle reads `database.table · type · role` (the ClickHouse type as it is; *measure* for numeric, else *dimension*
  — the worksheet's rule). The dialog lists name, type and role nowhere else.
- **Two panels:** the body is **two equal panels** split by one vertical 1px `--line` rule — **Statistics** on the left; **Most frequent values (Top 10)**, then a numeric column's **Distribution**, on the right (`.col-profile__panels`, `.col-profile__panel`). Each opens with the same 57px heading bar (`.col-profile__panel-head`, 14px semibold, a hairline under it), so the rules line up across the divider, and the panels are the same height (the shorter one has empty space under it). Below 44rem of body width the right panel goes under the left, split by a horizontal rule.
- **Figures** (left panel, `section` named "Figures"): a **ruled two-column grid** that runs the full width of the panel: 1px `--line` rules between the cells, the same rule as the one under the heading. Each cell has 16px top and bottom and 24px side padding, so labels share the 24px gutter of the head, the foot and the headings.
  The figures come in **groups** (`.col-profile__group`, each a subgrid of the grid, `--rows` set by `column-profile-dialog.js`), two to a row and padded with an empty ruled cell to a full row: the counts (Rows, Distinct (approx.), Null value, the count of NULL rows as a plain number: no percentage and no note), then Min and Max (numeric and date columns), then the numeric summary. Min sits under Rows and Max under Distinct, so every vertical rule lines up.
  **The two figures on a row are the same height** and each one's text is **centred vertically** in its cell: the grid has `auto` rows and every group lays its tiles on it as a subgrid, so a row is as tall as its tallest tile. Every figure is one label over one value, so in practice every row is the same height.
  Below 28rem of body width the grid becomes one column, every figure on its own ruled row (`--n`, the tile count, sets how many rows a group spans; the empty cells are hidden).
  **A figure is never clipped** — no ellipsis, no hidden overflow. The rules, in order:
  1. When Min or Max is over 18 characters they **stack**, each on the full width of the panel (`.col-profile__group--stack`).
  2. A group (the counts; Min and Max; the summary) whose longest figure is over 12 characters steps **every** figure in it from 24px to 16px (`--fs-lead`, `.col-profile__tile-value--long`), so one row never mixes sizes.
  3. As the last resort a figure wraps anywhere (`overflow-wrap: anywhere`) and its cell grows; the full text is also in the cell's `title`.
- **Numeric summary:** a numeric column adds its own group of figures under Min and Max, on the same two columns: **Mean**, **Median (approx.)**, **Std. deviation** (sample), **Q1 (approx.)** and **Q3 (approx.)** — one scan with the rest ([clickhouse-integration.md](../../reference/clickhouse-integration.md#column-profile-box-plot-raw-rows-and-join-preview)).
  The quartiles are approximate (`quantile`, the box plot's function) and say so in their label. Figures are short (`formatNumber`: whole numbers from 10,000, one decimal from 100, two from 1, three significant digits below 1, exponent form at extremes), so a float never trips the long-figure rules.
  A figure the server cannot give (one non-null row has no standard deviation) leaves its tile out; the group is padded with empty ruled cells to a full row, and below 28rem they are hidden. There is no Sum (it wraps silently on 64-bit integers). Text and date columns have no summary.
- **Distribution:** a numeric column with at least one non-NULL value gets a **Distribution** section in the right panel, under the values (56px of bars; it sits there, not under the figures, because the left panel is the taller one and the dialog would otherwise scroll; the bars are 56px, not taller, so that the Top 10 plus its **Other values** band and the chart still fit the dialog's fixed height without a scrollbar): 20 equal-width bars, each as tall as its count against the fullest bin (up to 56px tall, `--r` top corners, `bar-rise` motion),
  the first and last value under them and "Fullest bin: 10–19, 20 rows (77%)" in words. One colour (`--accent`), as bright as the bin is full: `--k` runs 0 (emptiest bin) to 1 (fullest), mixed 20%–80% into `--surface` (`toneOf` in `column-profile-model.js`); the caption names the fullest bin, so colour is never the only cue. Every bar has a `title` and a visually hidden "range: n rows (share)" for assistive tech (the bar is `aria-hidden`).
  An integer column's bins read as integer ranges ("10–19"). It is the worksheet's histogram endpoint (`POST .../histogram`, custom SQL as `source`), requested in parallel with the profile and aborted with it; it reads every row like the profile.
  It has its own states inside the section: "Reading the distribution…", an icon + sentence on failure (a timeout is reworded; the figures above stay), "There are no values to chart.". Not yet: a distribution for date columns (the endpoint is numeric only), a log scale, a choice of bin count.
- **Most frequent values (Top 10)** (right panel; the heading carries the limit): up to 10. Each is a band of at least 32px: the label, the count and its share of all rows sit on a tint that fills the band from the left in proportion to the share. When the column has more than 10 groups, an 11th band, **Other values** (italic, like (NULL) and (empty)), carries every row outside the Top 10 (`rows − Σ top counts`, `summarize().other`), so the counts always add up to **Rows**; it is left out when the Top 10 already cover every row. It is not part of **Copy values**. Each share is rounded on its own, so the printed percentages can differ from 100% by a rounding step.
  - NULL reads *(NULL)* and an empty string reads *(empty)*, in italic, so neither is mistaken for the text "NULL".
  - A value over 100 characters is cut to 100 and marked with a trailing … (the server's cut); a long label wraps inside its band, which grows, and never ends in an ellipsis of its own.
  - One colour, never the only cue (the text carries every figure): every band is the accent mixed 10%–38% into `--surface-2`, brighter the more frequent the value — `--k` is its count's place between the smallest and the largest of the listed counts (all equal: full). The leader (the most frequent real value) is told apart by its bold label, not a second colour; NULL and empty bands use the same tint (the italic label says what they are). Red is never used here (red means danger).
    The labels keep ≥ 4.5:1 on the brightest tint (38%) in light, dark and One Dark (probe `contrast` empty).
- **Honesty about what was read:**
  - Every row is read: the figures describe the whole table, with no row cap and no sampling warning ([D143](../../decisions/decisions-performance.md#d143--the-column-profile-reads-every-row)).
    A table too big to scan within the connection's time limit fails with a 504 and a message, never a partial figure.
  - Values are compared by their first 100 characters (a note says so when one was cut), so values differing only later count together.
  - Distinct is an estimate.
  - A share never rounds a partial share up to 100%, and tiny ones read "<0.1%".
- **Copy name** copies the column name. **Copy values** copies the plain top values, one per line (NULL, empty and cut values left out).
  Both use `navigator.clipboard` and say so in a toast, or report that the browser blocked it.
- **Layout:** a **golden rectangle**, width : height = 1.618 : 1 (`--phi`), the same size for every column. The height is the base: `--ph = min(800px, 92vh, (100vw − 32px) ÷ 1.618)`, `height: var(--ph)`, `width: calc(var(--ph) × var(--phi))` — 1294 × 800 in a window 900px or more high and 1326px or more wide, 1042 × 644 in a 700px-high window, and always inside the window. Under 900px of window width the ratio is dropped (a phone is too small for it): the dialog is as wide as the window (at most 960px) and as tall as its content, up to `min(92vh, 840px)`. **No card:** the body is the dialog's `--surface` with no padding and no wash; its content runs the full width and height of it,
  as the two panels above — left **Statistics** (the figures), right **Most frequent values** (a 16px / 24px padded list) and, for a numeric column, a **Distribution** section under a hairline.
  **Head and foot take no fill of their own**: they sit on the dialog surface, parted from the body by the neutral 1px `--line` rule on the edge that faces the body.
  In the foot the Copy buttons are the ordinary `.btn` fill (hover brighter than rest in every scheme) and Close stays the solid accent. The foot wraps **whole buttons**, never their labels (`white-space: nowrap`): at 420px Close drops to a second line on the right.
  Head, body and foot share one 24px side gutter (the X glyph sits on it); each panel body and the distribution section have 16px top and bottom padding. A warning note, when there is one (a value was cut), is a `--warn-bg` strip across the top of the body with a
  1px `--warn-line` rule under it, so the caveat comes before the figures it qualifies. Each frequent-value band is a `--surface-2` strip with the accent tint above; the leader (the most frequent real value, not NULL or empty)
  has a bold label. The content fades in once (no rise). Below 44rem of body width the panels stack and below 28rem the figures reflow to one column. Text always carries a `title` with the full text.
  With no rows the block is the reason alone, across both panels' width.
  **No scrollbar at a normal window:** the fullest profile (a numeric column: ten summary figures, ten values and the distribution; the right panel needs 635px of body) fits the 800px dialog (648px of body), so nothing scrolls in a window 860px high or more (measured at 900px). A column with very long figures (a Decimal(76, 38) that stacks Min and Max) overflows by 11px there. In a shorter window the dialog shrinks, keeping its ratio, and, like the stacked narrow layout, the body scrolls inside it (the page never scrolls). A text or date column fills less of the same rectangle, so there is empty space under its panels. Moving a block between the panels is the lever if a block is added: keep the two panels about the same height.
- **States:** "Reading every row…" while loading (closing cancels the request; Copy values stays disabled until figures arrive, and when the top values are all NULL, empty or cut its tooltip says why).
  A failure (404 / 502 / 504) shows icon + message in the dialog only (no toast: it would say the same thing twice). A timeout (504) is reworded by `profileFailure`:
  the server's advice (a filter, a lower Top-N, fewer fields) is for worksheets, so the dialog says the profile reads every row and a very large table can run past the limit,
  and on a custom SQL card adds "Narrow the query with Edit SQL, then profile again." **Esc**, X or Close close it.
  **Nothing to show** always says why, as a neutral icon + sentence (`summarize().reason`, `.col-profile__reason`; the warn strip stays for the cut-value caveat):
  - *No rows* — the block is the reason alone, with no figures (zeros would mislead): "This table has no rows, so there is nothing to profile."; on a custom SQL card "The query returns no rows, so there is nothing to profile. Check its filters in Edit SQL." Copy values is disabled with the tooltip "No values to copy: there are no rows".
  - *Every row NULL, empty or both* — the figures and the band(s) stay, and a line under the list reads "Every row is NULL, so there are no values to list and no Min or Max." (or "empty", "NULL or empty").
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
