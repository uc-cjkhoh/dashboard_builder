---
components: [src/DashboardBuilder/Features/Core/format.js, src/DashboardBuilder/Features/Dashboard/conditional-model.js, src/DashboardBuilder/Features/Dashboard/contrast.js, src/DashboardBuilder/Features/Dashboard/render-table.js, src/DashboardBuilder/Features/Dashboard/scale-model.js, src/DashboardBuilder/Features/Dashboard/viewbar-model.js, src/DashboardBuilder/Features/Dashboard/worksheet-view.js]
---
# Worksheet table view — crosstab, paging, sort, format

The Rows × Columns table view and the formatting that applies to every view. Layout and shelves: [worksheet.md](worksheet.md).

## Table view — a true Rows × Columns crosstab

`crosstabTable()` (`render-table.js`) pivots the flat grouped rows in the browser (ClickHouse has no `PIVOT`).

- **Layout:** Row-shelf dimensions form the nested **left stub** (rowSpan-merged repeats). Column-shelf dimensions form the nested **top header** (colSpan). Measures are the **cell values**.
- **Measure-name band:** it sits on whichever shelf holds the measures. On Columns it runs across the top; on Rows down the left, transposing the grid. Measures on both → a note, falling back to the top band.
- **Colour:** a Colour dimension adds a free extra top-header level.

### Conditional formatting (P37)

Format → Conditional formatting, in the Table and Text views. Set per measure, keyed by column + aggregation, so it survives shelf reorders.

- **Cells:**
  - **None**;
  - **Colour scale** — Low → high (surface → `--chart-div-high`), or **Diverging** (`--chart-div-low` ← surface → `--chart-div-high`, the pair the chart scale uses) around a **Midpoint**. Auto midpoint = 0 when values straddle it, else the middle;
  - **Data bars** — from zero; negatives extend left in `--chart-cat-6`.
- **Rules:** up to **5** rules "value op threshold → Good / Bad / Warning / Note". A new rule starts with an empty threshold ("Type a value") and applies to nothing, and shows no key entry, until a value is typed. The first match wins and overrides the scale or bar for that cell. Rules wear the status tokens **and an icon** (✓ / error / warning / info).
- **Contrast:** scale tints top out at 85%, and each cell's ink is picked for ≥ 4.5:1 (`contrast.js`).
- **Key:** above the table, showing each scale's low / high (and centre) and each rule. While pages are still loading it says "Scales and bars use the N rows loaded so far."
- **Include totals:** a per-measure check box under the Cells row (`format.conditional[key].totals`, stored only while on). Its total cells (grand-total column, subtotal rows, grand-total row and where they cross) are coloured by that measure's scale, bars and rules exactly like the other cells, and their values count when the scale's range is found ([D122](../../decisions/decisions-marks.md#d122--include-totals-in-the-colour-encoding)). Off, a total is plain, as before.
  - **Availability:** it is disabled, with its reason as tooltip and description, when the measure's total has no value (an average, median, distinct count, percentile or table calculation: "A total of an average, median or distinct count has no value here"), when Grand totals and Subtotals are both off ("Turn on Grand totals or Subtotals"), when the layout draws no total ("No total is drawn in this layout"), or when the measure has no scale, bars or rule ("Pick a colour scale, data bars or a rule first"). A saved "on" stays clearable in the first three cases, with a note saying why nothing is coloured. Setting Cells to None with no rules clears it.
  - **A total is bigger than a cell,** so ticking it can make the cells paler: the Format note says "Totals are larger than single cells, so cells may look pale" while a scale or bars are on.
  - **Totals that read "—"** (an average, median or distinct count has no combined total in the browser; a collapsed header while rows are still loading) are never coloured and add nothing to the range; a measure with no total value at all is not named in the key. A total keeps its bold look, separator and `xt-total` classes; its ink keeps >= 4.5:1; a rule on a total keeps its tone, icon and tooltip.
  - **Key:** "Totals included" (or "Totals included: sum(amount)" when only some measures include them), only while a total of an included measure is really coloured. While pages are still loading it reads "Scales, bars and totals use the N rows loaded so far": the totals are those of the loaded rows, as shown.
- Code: rules and the Include totals gate in `Dashboard/conditional-model.js` (`totalsIncluded`, `totalsGate`, `totalsDrawn`, `totalCombinable`, `extentWithTotals`, `nextConditional`; unit-tested); the total cells in `render-table.js` (`totalValues`, `totalCell`).

### Totals and column order

- **Grand totals** and **Subtotals** are in Format for Table and Text (and in Analytics): one setting, `analytics.totals`.
- Column headers list their members in ascending order, like the rows, unless the sort is on a measure (then the query's order); a saved descending sort gives descending headers.

### Paging

Every row is shown, a page at a time.

- The table asks for 500 rows plus the total (`withTotal`). When the pane scrolls within 400px of its end, the next 500 load (`offset`), and the crosstab redraws from all loaded rows.
- The notice line reads "Result rows 1–500 of 12,345 — scroll to load more", then "12,345 result rows".
- Loaded pages are kept while only presentation changes. Refresh or any plan change starts over.
- Code: `runTable` in `worksheet-view.js`; rules in `scale-model.js`.

## Sort

The view bar's **sort picker** (`sortControl`) shows the current order (`↑ customers.name`).

- Its menu lists the in-play fields ("Sort by") and **Ascending / Descending**.
- Default: ascending by the first field (`sortSummary` in `viewbar-model.js`).
- With nothing on the shelves it is disabled.
- It sets the query `ORDER BY` on the field's generated alias (`k{n}` / `v{n}`). The server then appends the remaining dimension keys ascending, so the crosstab layout stays stable.

## Format

A collapsible **Format** card (`formatPanel`, state on `sheet.format`) changes presentation without touching the query — except Top-N.

| Setting | Effect |
|---|---|
| Number format | auto / compact / currency / percent + decimals (0–3 in the UI; a workbook may carry up to 10). Currency adds a **Symbol** choice: $ (default), €, £, ¥, RM, S$ or Custom… (a new custom symbol is 1–3 visible characters, validated in the box; a stored symbol of up to 8 characters, as import has always accepted, is kept and shown as custom; `currency-model.js`) |
| Date format | for date-like dimension labels |
| Top-N | Caps the chart query's `LIMIT`: All, 5, 10, 20, 50, 100, or **= a number parameter** (P32, clamped to 1–5000). **All** (the default) asks for up to 5000 groups. A set value keeps that many in sort order, so ascending and descending show different groups when there are more. A one-dimension bar / pie / donut / treemap then adds an **Other (N more)** mark (muted ink, not clickable) aggregating the rest. Also sets the histogram bin count |
| Target | KPI: a goal for the first measure — progress bar + "% of target" ([worksheet-encodings.md](worksheet-encodings.md#date-range--comparison)). Gauge: the arc's maximum. Bullet: the target tick and bands ([worksheet-charts.md](worksheet-charts.md#chart-types)) |
| A fall is good | with a Date range comparison: a fall shows as good (`--up`), a rise as bad |
| Conditional formatting | Table / Text: colour scale, data bars and rules per measure ([Table view](#table-view--a-true-rows--columns-crosstab)) |
| Approximate (faster) | `uniq` distinct counts and, on a table with a sampling key, a 10% sample ([exact vs sampled](../../reference/clickhouse-calculations.md#aggregates-exact-and-approximate)); median, percentile, standard deviation, variance and ATTR are estimates, and the info line says so. Labelled on the info line ([D25](../../decisions/decisions-platform.md#d25--a-short-lived-server-result-cache-and-approximate-mode)) |
| Fit | Standard / Fit width / Fit height / Entire view (also in the ⋯ sheet actions) |
| Group dates | Charts: group the first date/time dimension by Auto (default — exact when ≤ 400 values, else the finest grain with ≤ 400 buckets), Exact, Hour, Day, Week, Month, Quarter or Year. A grouped axis isn't click-filterable |
| Legend | show / position |
| Data labels | on / off |
| Colour-by-category | single-measure bar: colour each bar by its category |
| X / Y axis titles | name the **physical** axes (X = bottom, Y = left); ≤ 80 characters |

Number and date formats also drive the crosstab and KPI tiles through the shared `Core/format.js` (`makeValueFormatter` / `makeCategoryFormatter`), so every view reads identically.
