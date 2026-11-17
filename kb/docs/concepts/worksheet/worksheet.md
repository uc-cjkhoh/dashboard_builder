---
components: [src/DashboardBuilder/Features/Calc/, src/DashboardBuilder/Features/Core/, src/DashboardBuilder/Features/Dashboard/]
---
# Worksheet — shelves, crosstab, sort, format, joins

Each worksheet tab is one Tableau-style worksheet: a field pane beside shelves you drag fields onto, and a view that renders the result. A dashboard tab composes worksheets ([tabs.md](../workbook/tabs.md)).

- **Code:** `Features/Dashboard/` — `dashboards.js`, `worksheet-view.js`, `worksheet-render.js`, `render-*.js`, `sheet-plan.js`, `result-model.js`, `filter-rules.js`, `toolbar-rules.js`, `query-runner.js`, `chart.js`, `contrast.js`, `_Dashboard.cshtml`, `dashboard.css`, `QueryController.cs`.
- **Companion docs:** chart types and export → [worksheet-charts.md](worksheet-charts.md). Marks, Filters, Date range & comparison, click-to-filter, Drill and Pages → [worksheet-encodings.md](worksheet-encodings.md).
- **Sheet state shape:** [data-model.md](../../reference/data-model.md#worksheet-sheet).

## At a glance

- **What it is:** one Tableau-style worksheet per tab. Drag fields onto **Columns** / **Rows** (and Marks slots); the view is a chart or a crosstab.
- **One request:** the sheet becomes a single bounded `POST /api/query` (`buildPlan`), run latest-wins with a short-lived cache; limits are rejected, never clamped.

**Sections:** Layout · Shelves & pills · Calculated fields on the worksheet · Drop-time limits · Building the query · Query lifecycle · Cross-table joins · View data · Table view · Sort · Format

## Layout

Data sits on top; view controls sit on the chart ([design/layout.md](../../reference/design/layout.md#worksheet--data-header-and-chart-card)).

1. **Data header** — the **Columns** and **Rows** shelves (full-width lanes, always visible) (a Marks editor opens as a flyout, not in the header). The Marks slots themselves live in the field pane ([worksheet-marks.md](worksheet-marks.md#marks-slots)).
2. **Chart card** — flush (no margin, no radius). Its head is the **view bar**, left to right:
   - field-pane toggle;
   - the one chart-type control (`chartTypePicker`, [worksheet-charts.md](worksheet-charts.md#chart-type-control));
   - sort picker · Format · Analytics · Refresh · **Full screen** · Export · sheet actions (icon buttons with tooltips and `aria-label`s). **Format** (brush icon) and **Analytics** also carry a text label from 1280 px up, icons only below (`VIEW_LABEL_MIN_WIDTH`). Importing a workbook is in the Export menu ("Import workbook…"), not in the bar.

   Below the view bar come the Format card, the result notice and the chart. Full screen and print: [layout.md](../../reference/design/layout.md#full-screen--print).

### Worksheet chrome (P23)

- **No undo:** the app has no Undo / Redo; destructive deletes ask twice instead ([D133](../../decisions/decisions-destructive-actions.md#d133--no-undo-double-confirmation-before-every-destructive-delete)). Typing undo inside the SQL and calculation editors is the text box's own.
- **Sheet actions** (⋯ in the view bar):
  - **Swap Rows and Columns**.
  - **Clear sheet…** — asks to confirm twice (`confirmDeleteTwice`, button **Clear**; skipped when the sheet is empty), keeps the chart type.
  - **Fit** — Standard (a slot per category, the pane scrolls), Fit width, Fit height, Entire view (the fitted axis shares the pane and its labels thin out).
  - **Show title and caption** / **Show filter cards**.
  - Fit and the two toggles carry only a tick at the end of the row (radio-style for Fit); no icon, no extra text.
- **Title and caption** under the view bar — click to edit, `Enter` saves, `Esc` cancels. Empty means the automatic one (the tab name, which follows a tab rename at once — the two always match both ways: renaming the tab replaces a title you had typed (`store.renameTab` clears `sheet.title`), and saving a new title renames the tab (an empty title only goes back to automatic; the title input holds up to 60 characters, the tab-name limit); "sum amount by customers.name · 2 filters"; a histogram says "distribution of orders.qty", a box plot "orders.qty by customers.country"). Printed too.
- **Status bar** at the foot of the chart card: marks · "N × M table" (Table / Text; distinct from the notice line's "N result rows") · measures · the selection · `Updated hh:mm:ss`. The time is when the data was last read from ClickHouse; a cached result keeps the time it was fetched (`fetchCached` stamps `queriedAt`).
- **Print header** (`beginPrint`): title, caption, date range, filters, the notice, the update time and the print time. It also lists each calculated field the view uses, and those it refers to, as `Calculation: Name = formula` (cut at 200 characters; `data-notes.js`).

### Field pane

Beside the data header and chart card, the **field pane** holds, top to bottom: **Marks** (soft `--surface-3` slots; accent wash when set or open; collapsed with a one-line summary of the set slots — see [worksheet-marks.md](worksheet-marks.md#marks-slots)), then a **divider** (`hr.ws-fields__divider`) and a **Fields** title (`h2.ws-fields__title`, same weight and colour as Marks' header, no chevron — it does not collapse) that open the second section: the search box, then **each model table that is in a relationship** (a table card with none is held out — [relationships.md](../data-source/relationships.md#rendering)). **The pane scrolls only as a last resort** (`overflow-y: auto`, no sideways scroll): the tables share the height left under Marks and the search (a short card, e.g. one with fields hidden, keeps its full height; the taller ones split the rest), and each table card (`details.ws-fieldset`) scrolls its own fields with its header pinned (collapsed, or with every field hidden, it shrinks to the header alone); with so many tables that their two-row minimums no longer fit, the pane gets a vertical scroll bar instead of clipping the last cards; an open Marks card is capped at 45 % of the pane and scrolls inside itself on a short window. **Table cards are expandable:** hover a card's bottom border (the 1px border plus the 5px inside it) — it lights with an accent line and the pointer becomes the vertical resize cursor — then click and drag to set its height. A dragged card keeps that height (never under the two-row minimum, never past its content) and stops sharing the leftover space; the other cards still share what is left. Double-click the border to return the card to automatic sizing; with a card header focused, `Alt+↑` / `Alt+↓` resize it in 16px steps. A collapsed card has no grip. The heights are remembered per table in this browser (`localStorage` `dashboardbuilder.fields.heights`), not saved in the workbook. Code: `Core/edge-resize.js`, wired in `Dashboard/dashboards.js`.

- **Resize** by dragging its right edge, or `←`/`→` on the handle.
- **Hide / show** with the first button of the view bar; the worksheet takes the room. It sets `aria-expanded` and is remembered in `localStorage` as `dashboardbuilder.fields.collapsed`, like the sidebar rail.
- **Calculated fields** and **Hierarchies** are not in the pane. While a worksheet is open they are two icons in the sidebar body ([layout.md](../../reference/design/layout.md#sidebar)), each opening a dialog to add, edit or use them (below).
- **Add a field** by dragging it onto a shelf or tool, pressing its **`＋`**, or double-clicking it. The `＋` is the keyboard path; both send measures to Rows and dimensions to Columns. The same double-click and `＋` rule applies to the rows of the Calculated fields dialog.

Style: the fields are the focus. Each table is a solid tile (`.ws-table`: `--line-2` stroke, `--elev-2`) on the quiet `--surface-2` pane. Its fields are flat 32px rows (hover wash, the add `+` on hover), with the type icon tinted by role (`--dim-ink` for dimensions, `--meas-ink` for measures), under sentence-case **Dimensions** / **Measures** labels. The groups share one collapsible design (`field-group.js`: `<details class="ws-group">`, chevron + bold name, 4px between rows, 8px between groups); collapsed groups survive a pane rebuild.

### Field pane basics (P28)

- **Search** at the top filters fields by column or display name; non-matches get `hidden`.
- **Context popup** on a field: right-click, the ContextMenu key, `Shift+F10`, or `Enter` on the focused row. The same keys open the popup on every pill and field row below (`Core/menu.js` `openContextMenu`). It offers:
  - **Rename…** — inline, 1–60 characters. This is a *display name* shown on the field, pills, axes, legends, table headers and the sort picker. The query always uses the real, catalog-validated column. Renamed fields read in italics.
  - **Default aggregation** (numeric fields) — the aggregation a new measure pill starts with.
  - **Hide from the field list**, with a **Show hidden (n)** toggle.
  - **Copy name** (T02-28) puts the display name on the clipboard; **Copy column name** puts the real column when renamed. A calculated field's popup also has **Copy formula** (not for a group).
- Settings are per workbook (`fields` in the file; store `fieldMeta`).

### Data type cast and member labels

The popup also has **Data type** (a query-time cast, `cast`: `text` | `number` | `date`) and **Edit member labels…** (display-only labels). Both are in [field-settings.md](field-settings.md).

## Shelves & pills

- **Columns** and **Rows** each hold **any number** of pills. The shelf sets the crosstab axis: Rows dimensions are the **left stub**, Columns dimensions the **top header**.
- **Reorder** by dragging a pill's grip (⠿) within a shelf or across to the other one. Dropping onto a pill inserts before it; dropping onto empty space appends. Dimension order sets nesting / category order; measure order sets series order.
- **Invariant: measures always sit behind dimensions** on a shelf. `normaliseShelf` re-sorts after every drop, role change or add, keeping relative order within each group.
- **Role** of a newly placed field defaults from its type and name (`defaultRole`, `Dashboard/field-role.js`): a number is a measure, unless its name reads like an identifier (`id`, `*_id`, `orderId`, `*_no`, `*_num`, `*_number`, `*_key`, `*_code`, `*_ref`) — that groups as a dimension, and the field pane lists it under Dimensions ([D96](../../decisions/decisions-dashboards.md)). It can be changed per pill from its popup. `roleOf(f)` resolves a stored pill: its saved role, else numeric → measure, so saved workbooks do not change.
- **Invalid pills.** A pill whose settings can't be sent (a filter with an unparseable value, a column no longer in the catalog, checked against the Data Source's loaded columns and again when they arrive) is **invalid**. It shows a dashed `--danger-line` border, a warning icon and a tooltip with the reason. It is left out of the query and the chart (a notice names it: `orders.qty isn't in shop.orders — left out.`), never silently altered in the saved sheet.

### Pill options

Options are not inline. Right-click a pill (or focus it and press `Enter` / the ContextMenu key / `Shift+F10`) to open its **context popup**; `Esc` closes it and refocuses the pill. `Dashboard/pill-options.js` lists what each pill offers:

- a measure: aggregation radios, **Table calculation…** (opens its editor);
- a number: **Continuous** (measure) / **Discrete** (dimension) radios; any other flippable pill: **Use as dimension / measure**; and **Field choices…**;
- a date dimension: the date part radios with **Finer** / **Coarser**, and the **Show all date labels** tick;
- a filter: its operator radios, **Apply on every dashboard** and the value editor.

The pill itself shows its name (a filter: name, operator and value), the cast tag, and Remove. A measure pill also shows its aggregation before the name ("Sum · orders.quantity") and, when a table calculation is on, its short name after it ("· running total"); the name is cut with an ellipsis and the full text ("Sum of orders.quantity · running total") is the tooltip. The automatic caption names a table calculation too ("sum quantity · % of total by …").

### Aggregation

The menus show plain labels (Sum, Average, Minimum, Maximum, Median, Percentile…, Standard deviation, Variance, Count, Count distinct, Count non-empty, Attribute (single value) — `agg-labels.js`); the saved values (`avg`, `countDistinct`…) are unchanged. A measure pill's aggregation radios offer only what the column's type supports (`aggsFor` in `filter-rules.js`):

| Column type | Aggregations |
|---|---|
| numbers | `sum/avg/min/max/median/percentile/stddev/variance/count/countDistinct/countNonNull/attr` |
| text **and dates** | `count/countDistinct/countNonNull/min/max/attr` |
| otherwise (boolean, compound) | `count/countDistinct/countNonNull` |

- `countDistinct` maps to ClickHouse `uniqExact`.
- Aggregation meanings (median interpolation, sample statistics): [api.md](../../reference/api.md#measure-values-and-aggregations).
- `attr` is the single value of a group, or empty ([calculated-fields-formulas.md](calculated-fields-formulas.md)).
- Changing a pill's role to a type that doesn't support its aggregation resets it and says so.

**Percentile** — numeric fields only. A text column cast to a number counts; uncast text is refused, as for `median`.

- Choosing `Percentile…` in the pill's popup adds a percent box inside the popup, labelled "Percentile for …, 0 to 100". It takes an integer or decimal with up to six decimals and starts at 90.
- The pill keeps the fraction as `p` (0..1; 99.5 is `0.995`) and is named `orders.amount · p90`.
- The measure is labelled `p90 amount` everywhere (chart, table, CSV, Top-N and sort choices; `p99.5 amount`).
- A value outside 0–100 shows "Percentile must be between 0 and 100 percent." (warning icon, `aria-invalid`). It is never stored or sent; the view keeps the last good percentile.
- Two percentiles of one field are separate measures. Leaving percentile drops `p`.
- Percentile is **not** in a field's default-aggregation menu. A calculated pill keeps its own list (use `PERCENTILE([f], p)`).

### Quick table calculations (P27)

A measure pill's **fx** button opens its editor.

- **Calculations:** **Running total, % of total, Difference, % difference, Compound growth** (per-period rate since the group's first value, `(v / v₀)^(1/steps) − 1` in %; blank when the first value is not positive), **Rank** (competition style 1, 2, 2, 4 and highest first by default; an **Order** of lowest first and a **Ties** rule of dense 1, 2, 2, 3 or unique 1, 2, 3, 4 in result order are chosen in the editor; a non-default choice shows in the measure label, e.g. "rank (lowest first, dense)"; Other and blanks get none), **Percentile rank** (0–100%, highest = 100) or **Moving average** (window 2–30, typed or following a number parameter).
- **Along:** Columns, Rows (Auto = Columns when it has dimensions) or **Specific dimensions**:
  - a checkbox per Rows / Columns dimension; the ticked ones run together, the rest restart;
  - unticking all re-ticks all;
  - a same-named dimension is labelled with its shelf and date part;
  - the choice is positional, so reordering dimensions re-points it.
- **Computed in the browser** over the returned rows in sort order, restarting for each member of the other shelf's dimensions. No new query.
- **Display:** the measure is renamed ("sum amount · running total"). Percentages read "23.4%" in the table and charts.
- **Cut-off result:** the info line says "Table calculations use only the rows shown — more exist."
- Code: `Dashboard/table-calc.js`; saved on the pill as `tableCalc`.

### Date parts (P26)

A date dimension pill has a part picker:

- **Auto** — the chart-wide Format → Group dates. A new date pill stays on Auto (not Tableau's Year default, which would collapse a month of data to one point).
- **Exact**.
- **Year / Quarter / Month / Week / Day / Hour** — truncated, continuous.
- **Quarter of year / Month of year / Day of week / Hour of day** — discrete.

**−** / **+** step coarser / finer through year → quarter → month → day → hour. A `Date` column stops at day and offers no hour parts.

- Keys read as "2024", "2024 Q3", "Mar 2024", "Week of 2024-03-04", "Mon", "Q2", "09:00" (`Dashboard/date-parts.js`).
- A part-grouped axis isn't click-filterable.
- Saved on the pill (`datePart`); the server maps it to one whitelisted function.
- **Axis labels:** an **eye** toggle beside the picker picks **Thin out** (default: the date axis fits the pane and labels thin out) or **Show all** (a slot and label per date). Saved as `dateLabels`; `Dashboard/date-labels.js`.

### Field choices (P40)

A pill's **⇄** button opens a *Choices* editor. Drop up to 8 fields there (the shown one included).

- The chart card then shows a **"Columns: show" / "Rows: show"** switcher per such slot, under the view bar.
- Picking a field swaps it into the slot with the same role. A measure keeps its aggregation when the new field supports it, else takes the first one it does.
- Every choice is an ordinary field, validated by the server like any pill.
- Removing the shown choice shows the next. One choice left = an ordinary pill. The slot's only field shows no remove button.
- Saved on the pill (`choices`). The ⇄ turns accent-coloured when set.

## Calculated fields on the worksheet

A calculated field is a pill like any other; where it goes, where it is refused and its error state are in [calculated-fields.md](calculated-fields.md#what-a-calculated-pill-is).

It is not a column. `buildPlan` hands pills to the pure seam `Calc/calc-plan.js` (`wireDim`, `wireMeasure`, `topByRef` / `wireTopBy`, `planTables`), which emits the expanded `calc` tree in place of `db` / `table` / `column`. The tables a calculation reads join the query's table list like any field.

## Drop-time limits

Adding a field that would push a view over a cap is **refused with a toast naming the cap** — never silently dropped. Code: `checkAdd` in `filter-rules.js`; limits in `Core/validate.js` `LIMITS`.

| Cap | Limit |
|---|---|
| Fields per shelf (Columns, Rows, Detail, Tooltip) | 20 |
| Dimensions in one view (shelves + Detail + Shape + a categorical Colour + the drill level) | 12 |
| Measures in one view (shelf measures + numeric Size / Colour / Label / Path / Tooltip) | 10 |
| User filters | 8 |
| Drill levels | 6 |

- **The counts are conservative.** They ignore the chart type, so a stale encoding the current chart doesn't use still counts and can make a drop at the cap refuse. Remove it to free the slot.
- **The server enforces the same view caps** with 400s ([api.md](../../reference/api.md#limits)). It allows more filters than the 8 here because the worksheet appends its own ([limits](../../reference/api.md#limits)).
