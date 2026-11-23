---
components: [src/DashboardBuilder/Features/Canvas/]
---
# Canvas & entity cards

The **Data Source** view is the drop target where tables become entity cards. It uses the browser's native HTML5
Drag and Drop API, with no library ([D4](../../decisions/decisions-platform.md#d4--vanilla-js--hand-written-css-no-spa-framework)).
Drawing relationships on top of the cards is covered in [relationships.md](relationships.md).

**Code:** `Features/Canvas/`

- `_Canvas.cshtml` — the view markup
- `canvas.js` — drop handling, cards, moving and removing, zoom and pan
- `canvas-zoom.js` — zoom limits, wheel-to-zoom, zoom steps, pan-for-zoom, bring-into-view, fit-all and arrow-key pan maths (pure)
- `empty-state.js` — the empty-state choice (pure)
- `data-preview.js` — the data preview docked under the canvas ([below](#data-preview)); `preview-columns.js` sizes its columns and resizes them from the header
- `canvas.css` — styles

## Canvas ground

- The ground is a 24px dot grid that moves with the cards (pan and zoom, below).
  It is drawn on `.view--model` with `--line-2` dots and `background-attachment: local`. A dot is the centre of its 24px tile, so the tile starts 4px past the 16px gutter and the dots sit on the card lattice (model x, y = 16 + 24k): a card's top-left corner and the free slots land on a dot, at every zoom (`tests/live/canvas-zoom-ui.mjs`).
- Cards snap to the grid's 8px steps.
  The free-slot steps (312 + 144 = 456 across, 312 + 96 = 408 down) are whole numbers of dot cells.
- **Zoom and pan** work only on an empty spot of the ground (the pointer is on `#model-view` itself, not on a card, link or badge). The ground is an open world, not a scroll area: `.view--model` is `overflow: hidden` and has no scrollbars.
  - Dragging the ground pans it by the pointer distance, any distance in any direction, whether or not the cards fill the view, so the user can place the cards where they want them on screen. A drag under 4 px is a click; the cursor is a hand, closed while panning; the pan's release does not count as a click on the ground.
  - The wheel zooms about the pointer, 25 % to 200 %, so the point under the pointer stays still. Ctrl + wheel is left to the browser. The wheel over a card still scrolls that card's column list.
  - A card keeps its model `x` / `y` and size. The view draws it at model position times zoom plus the pan (`left` / `top`, and the CSS `scale` property from its top-left corner). A card drag moves it by the pointer distance divided by zoom, a table dropped from the sidebar lands at the pointer, a table added with its + button takes the first free slot from the top-left of what is on screen, and an already-added table is brought into view (`panToReveal`). If the browser scrolls the hidden view to reveal a focused row, canvas.js folds that scroll into the pan.
  - The dot grid zooms and pans with the cards (`--zoom`, `--pan-x`, `--pan-y`). Links re-measure after every zoom and pan (`canvas:zoomed`); line widths and badges do not scale, only the cards do.
  - Zoom and pan are view state: not saved in a workbook, reset on reload.
- **Overview control** (cards present, start card not showing): one **Fit all cards** icon button, the tab bar's right-most control (`.canvas__fit` appended to `.canvas__bar` by `Canvas/canvas.js`, 16px from the bar's right edge; tooltip "Fit all cards (F)"; shown on the Data Source tab only, so it is off the cards and never moves with the data preview, [layout.md § Sidebar foot](../../reference/design/layout.md#sidebar-foot)). The wheel and the keys do the zooming, so there are no − / + buttons and no percentage readout ([D147](../../decisions/decisions-design.md#d147--the-data-sources-zoom-pill-is-one-fit-button)). A key step is a quarter (×1.25, rounded to a whole percent) about the view centre, within 25 %–200 %.
  - **Fit** (`fitView` in `canvas-zoom.js`) zooms and pans so every card shows, 16px inside the view: as large as fits, never past 100 %, centred where the cards fit, top-left at the margin where even 25 % cannot show them all. It reads each card's rendered height, so it is correct once the column lists have loaded.
  - **Opening a workbook fits** (`fitCanvas()` after the cards and relationships are restored): the fit waits until every card has its columns (a card's height settles then) and the Data Source is on screen, and a pan, zoom or Fit by the user in the meantime cancels it.
  - **Keyboard:** the ground takes focus (`tabindex="0"`, focus ring `--focus`, described by an `sr-only` line). With focus on the ground itself (not a card, row or field, which keep their own keys): arrows pan 64px (Shift: 256px), `+` / `=` and `-` zoom a step, `0` returns to 100 %, `F` fits.
  - Tests: `tests/js/canvas-zoom.test.mjs` (steps, fit, arrow keys); browser checks in `tests/live/canvas-zoom-ui.mjs` (the Fit button, limits, Fit from far away, keys on the ground and not on a card).
- While a table row is dragged over the canvas, the ground takes a faint accent wash and the dashed accent outline.

## Dragging a table onto the canvas

- **Only our chips are accepted.** A sidebar chip's `dragstart` sets `application/x-ch-table` = `{db, table}` with
  `effectAllowed = 'copy'` ([schema-browser.md](schema-browser.md#table-rows)). Because the MIME type is custom,
  the canvas never accepts arbitrary text or files.
- The canvas handles `dragover` (`preventDefault()`, `dropEffect = 'copy'`) and `drop`.
- A drop whose payload isn't `{db, table}` strings is ignored.
- **No duplicates.** A table already on the canvas is not added twice. Instead, the existing card is scrolled into view
  and focused (`tabindex="-1"`), and a toast says so.
- **The `＋` button takes the same path.** The chip's `＋` fallback fires the `table:add` event, which is handled like a drop.
  The new card takes the first free grid slot from the top-left of the view; when that slot is below (or beside) what is on screen,
  the ground pans just enough to show it (`reveal()`), so a card never lands out of sight.
  A dropped table always lands in the shared model: `table:add` switches to the Data Source tab first ([tabs.md](../workbook/tabs.md)).
- **Where a card lands:**
  - A dropped card lands at the drop point.
  - A `＋`-added card goes in the **first free grid slot**, so it never covers another card's title.
    Slots are 312 × 312 cells measured from the 16px view gutter, with a 144px gutter between columns and 96px between rows (room for a link's elbow and badge; across it is wider because a card grows past 312 after it is placed, when its head's buttons and Needs a partner show),
    and as many columns as fit the visible canvas.

## Creating an entity

On drop:

1. Read `{db, table}` and create an `Entity` at the drop point (id `db.table#n`) —
   [data-model.md](../../reference/data-model.md#entity).
2. Fetch the columns with `GET …/columns` (`DESCRIBE`). Each column is tagged with a display category.
3. Render the card with a **loading** status (amber) until the columns arrive.
   A failed fetch shows a **failed** status (red) with **Retry**, never a bare error. When the server **refused** the card (a 400: for example a union saved earlier whose tables share no column) the status shows the server's reason and **Remove card** instead, because asking again would give the same answer.
4. Once the canvas has at least one entity, hide the empty state (`.canvas__empty`) with `hidden`.

## Union and unpivot cards

A union or unpivot ([query-sources.md](query-sources.md)) becomes a card in the first free slot. Nothing in the UI fires `source:add` now (the sidebar dialogs are gone, [D138](../../decisions/decisions-custom-sql.md#d138--union-and-unpivot-are-written-in-edit-sql-not-built-in-the-sidebar)); the browser checks use it, and a saved workbook's cards load through the workbook import.

- It arrives as a `source:add` event, and the Data Source is shown first.
- Its `table` is the source's automatic name. Its columns load from `POST /api/source/columns`.
- It looks like a table card, but without profile buttons or drag handles, because a source takes no relationship.
- One note line under the head says how its columns are matched.
- Its title, column names and note start at the same x as a table card's (the left lane stays empty on both).
- Remove and collapse work as on any card.
- **Removing a card** (✕ in its head, asked twice) takes it out of the model **before** `entity:removed` is emitted (`removeEntity`, `clearAll` in `canvas.js`), so `relations.js` redraws without it: its links go at once, no proposed link is drawn to it, and a card left behind shows or hides *Needs a partner* by the cards that remain (a single card needs none). The card's element fades out afterwards (`inert` meanwhile). Browser check: `tests/live/card-remove-ui.mjs`.

## Empty state

With no entities, the canvas shows **a ghost model**, **one sentence** and **one button**.

- The ghost model is two dashed cards joined by an elbow link with its one / many ends, drawn in tokens and `aria-hidden`.
- The sentence and button are chosen by `emptyState()` in `empty-state.js` (pure).
- The button focuses the control for that step. If the sidebar is collapsed, it expands it first
  (`expandSidebar()`, [layout.md](../../reference/design/layout.md#sidebar)).

| State | Sentence | Button → focuses |
|---|---|---|
| not connected | not shown — the start card shows the connect form instead ([connection.md](connection.md#while-disconnected)); `emptyState()` still returns "Connect to a ClickHouse server to begin." / Connect → `#conn-host` | — |
| no database open | "Open a database in the sidebar." | Open a database → `#db-first` (the first database row) |
| a database open | "Drag a table here from the sidebar to start your data source." | Find a table → `#table-search` |

## The ☰ menu (card actions)

The card head's ☰ button (`.entity__menu`, the `menu` icon, aria-label *Actions for table*, `aria-haspopup="menu"`, `aria-expanded` while open) holds the card's actions ([D129](../../decisions/decisions-relationships.md#d129--a-cards-actions-sit-in-one--menu)):

| Item | Does | Not on |
|---|---|---|
| **Edit SQL** (`edit` icon) | opens the Edit SQL dialog on the card's `SELECT`; Save makes the card read the query | a union or unpivot card |
| **Preview data** (`table` icon, a check item) | opens the [data preview](#data-preview) on this card, or closes it when it already shows this card; ticked while it does | — |

- The menu is the shared context popup (`openContextMenu`, `Core/menu.js`): a `.menu__list.ctx-menu` on `<body>`, placed under the ☰, so canvas zoom never shrinks it and no card clips it. Entries are read at open time.
- ↑ / ↓ move between items; Esc closes it and returns focus to the ☰; Tab, an outside click, scroll or resize close it. Pressing the ☰ again closes it.
- To go back to the table after Edit SQL, press **Reset to default** (in the editor toolbar), then **Save** (in the footer; the dialog's layout: [sql-editor.md](sql-editor.md#at-a-glance)). A card has no right-click menu.
Full behaviour, the SQL guard and what the card does afterwards: [query-sources.md § Custom SQL on a card](query-sources.md#custom-sql-on-a-card).
A card with custom SQL shows a `Custom SQL` note under its head; its profile buttons, View data, the histogram and the relationship suggestion read the card's query (as a derived table, the same one the worksheet uses), and it can be related and joined. A union or unpivot card has no profile buttons.

## Card anatomy

- **Head** (`.entity__head`, on `--surface-2`):
  - The table name first, alone, in weight 600, on the left gutter with the column names. The full `db.table` is its tooltip.
  - The database appears, muted after the name, only when another card holds the same table name from a different database — on both cards, kept in step as cards are added and removed.
  - **Needs a partner** (a label, only while the card is in no relationship) follows the title. At the right end sit, in order, the ☰ menu ([above](#the--menu-card-actions)), the collapse caret and the remove icon. The caret toggles `.entity--collapsed`, leaving only the title bar. Links to a collapsed card meet it at the title bar's vertical centre ([relationships.md](relationships.md#editing--cleanup)). It is a plain label, not a button; [relating-tables.md](relating-tables.md) covers it.
- **Card width** follows the title text plus the ☰ button and the **Needs a partner** label while it shows (`fitWidth(card, title, menu, need)`), from `--entity-min` (312px, the slot width) to `--entity-max` (480px) on `#model-view`
  (`card-width.js`, pure). It also grows to fit the card's column rows: the longest column name (measured semibold) plus the type column plus the row chrome (`rowsWidth`, `ROW_CHROME` 82px, 42px on a union / unpivot card, which has no Profile button). The chrome includes the list's scrollbar, whose width the browser decides (thin, classic or overlay): `measureScrollbar` in `canvas.js` measures it on a hidden `.entity__cols` and sets `--sb-w` on `#model-view` (re-read on window resize), the rows' right padding is `16px − --sb-w`, and `rowsWidth` takes it as `scrollbar`. While it is 16px or less the two cancel, so the card width and the type text's 16px gutter stay the same for an 8px, 10px or overlay (0) scrollbar; a wider one grows the card by the excess, so a name only ellipsises once the card is at the maximum. `renderColumns` records that need and refits the card. Beyond the maximum a title or column name ellipsises, with the full text in its `title`.
  Link anchors read the measured card box, so any width stays correct. When `relations.js` shows or hides the Needs a partner label it emits
  `entity:need` and the card refits before links are measured, so the button never clips a short name ("custo…").
- **Column rows** (`.col-row`) show the name and the **type** (`.col-row__type`), with a **Profile** icon button (`.col-row__profile`, not on a union or unpivot card): hidden at rest, half-strength while the card is hovered or holds focus, full strength on its own row (`schema.css`). Every icon button on this tab — the card's caret, ☰, ✕ and Profile, the sidebar's, the data preview's and the dialogs' — shows hover by colour alone: the icon takes a colour from what the button does — ink to close or move on, accent to open, inspect, edit or refresh, green to add, amber to disconnect, red to remove — with no square behind it ([components.md](../../reference/design/components.md)).
  The type column is one width per card, the longest type label measured (`--type-w`, set by `renderColumns`, capped at 130px), and right-aligned: the Profile icons line up in one column and the types end flush with the head's ✕. The card widens to fit the longest name beside it (see Card width above).
  - The type is the column's **ClickHouse type** in muted text at the row's end (no chip): `UInt64`, `Nullable(String)`, `Decimal(18, 4)`. `LowCardinality(…)` wrappers are left out, because they are a storage encoding, not the data type: `LowCardinality(Nullable(String))` shows `Nullable(String)` (`cardType`, `Canvas/column-type.js`). Past 130px the label ends in an ellipsis. The full type and the category are its tooltip.
  - Rows sit on a 16px gutter at both edges, so the left space equals the right and names line up under the head's title.
  - A row is a drag handle for relationships ([relationships.md](relationships.md)).
  - A column in a relationship is pinned to the card's key strip, and its name turns accent.
- **No rows on the card.** The column list scrolls inside the card, up to 240px tall; a short table is only as tall as its columns. Rows show in the [data preview](#data-preview) under the canvas.
- **Resize the list from either edge.** An 8px strip inside the card's top and bottom edge (`.entity__resize`) shows an `ns-resize` cursor and a 2px
  accent line on hover. Dragging it sets the list's height (`entity.listHeight`, applied as `--list-h` on `.entity--sized`):
  - the bottom edge moves the bottom; the top edge moves the top and keeps the bottom in place (the card's `y` changes, never below 0);
  - heights step on the 8px grid, from 64px (about two rows) up to the list's full content height, so it never shows empty space;
  - double-click either edge to go back to the default 240px; the bottom strip is also a keyboard separator (focus it, ↑ / ↓ in 8px steps);
  - hidden while the card is collapsed, loading or failed; links re-route while dragging (`entity:moved`), and a saved workbook keeps the height.
  - The maths is `card-height.js` (pure, `tests/js/card-height.test.mjs`); the browser check is `tests/live/card-resize-ui.mjs`.
  A table's rows are previewed from its chip in the schema browser ([schema-browser.md](schema-browser.md#row-preview)).
- **Look:** a solid card with depth.
  - `--line-2` stroke and a `--card-rim` highlight on the head's top edge.
  - Shadow `--elev-card` (a tight contact shadow plus a wide soft one), `--elev-card-hover` on hover and `--elev-16` while dragging.

## Data preview

The first rows of one card, in a panel docked under the canvas (`data-preview.js`), so a table, or what a card's Edit SQL now returns, can be checked without leaving the Data Source.

- **Open** it with **Preview data** in a card's ☰ menu. The same item on the card it shows closes it; on another card it switches. Saving Edit SQL opens it on that card too ([D128](../../decisions/decisions-custom-sql.md#d128--saving-edit-sql-shows-the-cards-rows-in-the-data-preview)).
- **Motion:** it opens with the view fade and **leaves with an exit** (the panel drops 8px and fades over `--dur-exit`, `inert` meanwhile); the ground takes its height back and the links re-measure when the exit ends. A reopen during the exit keeps the panel (`syncRun`, latest wins). Removing a card likewise fades the card out before it leaves ([motion](../../reference/design/motion-accessibility.md#motion)).
- **What it reads** (`entityRowsQuery`, `Rows/rows-model.js`, pure): 100 rows a page, the first 100 when it opens ([D131](../../decisions/decisions-custom-sql.md#d131--the-data-preview-pages-100-rows-at-a-time)).
  - A table card reads `POST /api/rows`. A card with custom SQL sends its query as `source`, so the rows are the query's.
  - A union or unpivot card reads `POST /api/union` or `/api/unpivot` with its saved definition.
  - Every paged read sends `offset` (page × 100; 0 on page 1). The same bounded, read-only reads as the schema browser's row preview, plus that offset.
- **Pages** (`pageState`, `canPage`, `pageFromInput`, pure; tested in `tests/js/rows-model.test.mjs`): **‹ Page [n] ›** in the head (`.ds-preview__pager`, a `nav` labelled *Pages of rows*), left of Refresh.
  - **Go to a page:** the page number is a field (`#ds-preview-page`, `.ds-preview__page-input`, *Page number*; its text is selected on focus). Type a page and press Enter, or type and leave the field. A whole number from 1 to 1,001 (`MAX_PAGE`; spaces and thousands commas allowed) reads that page; anything else is refused, never clamped: the field turns `aria-invalid` and the panel's notes say "Enter a page from 1 to 1,001." (warning icon + text, `role="alert"`) until it is edited. Escape puts the shown page back. A number typed while a page loads is dropped for the page loading.
  - **Previous** (`chevron-left`, *Previous 100 rows*) is off on page 1; **Next** (`chevron-right`, *Next 100 rows*) is off when the read found no row after this page (`truncated` false) or the next page would start past row 100,000 (`LIMITS.rowsOffset` / `ApiLimits.MaxRowsOffset`).
  - A click while a page loads is ignored (the buttons keep the last page's state). A focused button that turns off hands focus to the other one.
  - **Refresh keeps the page**; another card, Edit SQL Save and a SQL change (`entity:sql`) go back to page 1.
  - A page past the end (the table shrank) reads "No rows on this page", Previous still on.
  - **A union card has no pager** (it is hidden): each of its tables gets a share of one read, so there is no single row order to page through. It shows its first 100 rows as before.
  - Columns keep their width from page to page: a column's automatic width only grows while paging the same card (`widthMemory().auto`), and a SQL change measures afresh.
  - **Order:** a stored table or unpivot is read on one thread (`SETTINGS max_threads = 1`) so page 2 starts where page 1 ended; a card's custom SQL is read as written, so give it an `ORDER BY` for a fixed page order. Rows can shift if the table changes between pages.
- **Head:** the card's name (`db.table`; a union or unpivot by its own name), then the summary ("Rows 1–100 — more exist", "Rows 101–137", "No rows"; a union keeps "First 100 rows — more exist"), prefixed **Custom SQL ·** for a card with a query. Then the pager, Refresh, Export CSV (the rows shown: this page) and close (✕, its ink on the 16px gutter).
- **Table:** the rows dialog's table (`rowsTable` in `Rows/rows-dialog.js`), drawn lighter in this panel only ([D130](../../decisions/decisions-custom-sql.md#d130--the-data-preview-is-a-light-grid-with-resizable-columns); the rows dialog and View data keep their look). Cells cut at 1000 characters get the dialog's note. The table scrolls inside the panel; the page never scrolls.
  - **Header:** one sticky line of column names, highlighted so it reads apart from the rows: `--surface-3` fill, bold (700) `--ink` names, a `--line-2` rule under it. The ClickHouse type is not shown in the header: the card above lists it, the header's tooltip reads *name · type*, and a screen reader reads it (the type span is visually hidden).
  - **Rows and columns:** hairline rules between rows and zebra stripes (every second row `--surface-2`, so a row is easy to follow across); the row under the pointer tints `--surface-3`. A 1px line between every two columns runs from the header to the last row (`--line` in the body, `--line-2` in the header), so each column reads as its own lane and the border to drag is always visible. NULL in muted italics.
  - **Numbers** (`UInt*`, `Int*`, `Float*`, `BFloat16`, `Decimal*`, through `Nullable` / `LowCardinality`; `isNumericType`) are right-aligned with tabular figures, header included. The first column stays left-aligned, so the rows start on the 16px gutter under the title.
  - **Widths:** each column starts as wide as its widest cell, 48px to 320px (`autoWidth`), measured after the web fonts load and while the panel shows. Every cell, header included, is measured as text to the subpixel, plus its padding and its 1px column rule, with the number classes already on (tabular figures change the width), so a value never ends in an ellipsis below the 320px cap. The table is only as wide as its columns, not stretched across the panel. Widths sit in a `<colgroup>` with `table-layout: fixed`.
  - **Resize a column:** hover the right border of its header (an 8px `.rows-table__grip` inside the column line; a 2px accent line on hover, drag or focus; `col-resize` cursor) and drag; the column follows the pointer px for px. On the focused grip (a `separator`, `aria-valuenow`) ← / → step 8px, Shift five steps. Double-click or Delete goes back to the automatic width. 48px to 600px — the same handle, steps and bounds as a worksheet table's columns (`nudgeWidth`, `table-columns-model.js`).
  - **Widths are view state:** kept per card and column name for the session (`widthMemory`), so Refresh and an Edit SQL re-read keep them; dropped when the card is removed; never saved in the workbook.
- **Stays current:** it re-reads when that card's SQL changes (`entity:sql`, both "using your SQL" and "back to the table"), and Refresh re-reads by hand. The latest request wins: switching card, Refresh or close cancels one in flight. Errors show inline in the panel.
  - **While it reads:** a first open or another card shows "Loading rows…". A re-read of the card on screen (another page, Refresh, a SQL change) keeps its rows, summary and notes in place: the rows area turns `aria-busy` and the table dims to half after a 150ms beat (`--dur-fast`, so a quick read never flickers), until the new rows replace it.
  - **Notes** (a cut-cell note, a page-number error) sit between the head and the table with 8px above and below; a re-read swaps only the cut-cell note.
- **Shown only on the Data Source** with a card picked, and not while the connect form covers the model. It closes when its card is removed or the connection drops.
- **The card it shows** has a 2px accent outline (`.entity--previewed`), and **Preview data** is ticked in its ☰ menu (`aria-checked`, a check mark). The panel title names the card as well, so colour is never the only sign.
- **Layout:** a sibling of `#model-view` in `main.canvas` (`.ds-preview`), so the ground shrinks above it: pan, zoom, free slots and reveal never reach under it. It is 288px tall by default. Drag its top edge (`.ds-preview__grip`, a separator) or use ↑ / ↓ in 16px steps; double-click for the default. It is held between 120px and the height that leaves the ground 160px. The height is `--ds-preview-h` on `main.canvas`, view state only (reset on reload). The how-to pill and the keyboard hint above it lift by the panel's height while it is open (`--rel-foot` on `main.canvas`), which also keeps them clear of a toast. The rows scroll with the app's thin themed scrollbar. Opening, closing and resizing re-measure the links (`canvas:zoomed`).
- **Tests:** `entityRowsQuery` in `tests/js/rows-model.test.mjs`; the column helpers (numeric types, automatic width, drag and key steps, width memory) in `tests/js/preview-columns.test.mjs`; the browser check (open, switch, close, pages 1–3 with Next / Previous / Enter, a typed page (3, 9 past the end, 1002 refused, Escape), focus at the last page, Refresh on page 2, page 1 on another card, no pager on a union, the light grid, a column drag, ← / →, width kept over Refresh, double-click and Delete back to automatic, sticky header, a dark-theme screenshot, Save and Reset in Edit SQL, every number cell shown whole, the how-to pill above the panel while a toast shows, panel resize, a union card, remove, other tabs) is `tests/live/data-preview-ui.mjs`; the motion (a new link arrives and resumes across a redraw, a removed card and a closed preview exit, reduced motion drops all three) is `tests/live/data-source-motion-ui.mjs`.

## Moving & removing

- **Moving:** drag a card by its **head**. This uses pointer events, a separate gesture from dragging a chip with drag and drop.
  The entity's `x, y` snap to 8px steps and update, and `entity:moved` fires so links re-route.
- **Removing** a card removes its relationships. It **always** asks twice (`confirmDeleteTwice`, button **Remove**: "Remove shop.orders and its relationship(s)?" or "Remove shop.orders from the canvas?", then "Really remove shop.orders? This can't be undone." with **Remove for good**; [D133](../../decisions/decisions-destructive-actions.md#d133--no-undo-double-confirmation-before-every-destructive-delete)), then toasts "Removed shop.orders.". There is no undo; add the table again.
  If a half-drawn link was waiting on that card, it is cancelled (no dangling "undefined" toast).

## Join keys

There is no join-key setting. A column is a join key because a relationship uses it.

- Dragging one column onto another creates the relationship ([relationships.md](relationships.md)), and the card pins both columns to its key strip.
- An entity takes part in as many relationships as it has free columns.
