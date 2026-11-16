---
components: [src/DashboardBuilder/Features/Dashboard/, tests/live/]
---
# Worksheet charts — types, rendering, export

What the worksheet can draw and how. Shelves and the base query are in [worksheet.md](worksheet.md); encodings in [worksheet-encodings.md](worksheet-encodings.md).

## At a glance

- **23 chart types**, picked from one chart-type control in the view bar. A field mapping a type can't draw shows a **hint**, never an error.
- **One query path for most types:** the bounded `POST /api/query`. The histogram has its own endpoint; the box plot sends the same plan to `POST /api/boxplot`.
- **ECharts is vendored and only `chart.js` touches it.** Table, Text and KPI are native DOM. Colours come from `--chart-*` tokens.
- **Every category is labelled;** the pane scrolls instead of squeezing. Big charts zoom and switch to canvas.
- **Analytics** (reference lines, bands, trend, forecast, totals) are computed in the browser over the returned rows.
- **Export:** SVG, PNG, CSV (up to 100,000 rows) and Print / PDF.

**Sections:** Chart types · Chart type control · Analytics · Orientation · Query paths · Rendering · Export

## Chart types

Pick a type from the view bar's **Chart** picker or from [the chart-type control](#chart-type-control). Code: `CHART_TYPES` in `Dashboard/viewbar-model.js` (23 types).

An invalid field mapping shows a friendly **hint**, never an error (e.g. "A point chart plots two measures (X and Y) — add a second measure"). The rules live in `Dashboard/show-me-rules.js` (`CHART_NEEDS` / `chartIssue()`) and are shared with the chart-type menu, so the two never disagree.

| Type | Needs | Notes |
|---|---|---|
| Bar | ≥1 measure | grouped at ≥2 measures. A colour measure shades each bar; Size varies each bar's thickness (one measure) — [worksheet-marks.md](worksheet-marks.md#colour-size-and-shape-by-chart-type-t03-19-t03-20-t03-21-t01-21) |
| Stacked bar | ≥1 measure | Measures stacked on very different scales: a measure whose largest value is under 2 % of the tallest stack gets a line in the worksheet notice (icon + words: it is almost invisible; chart it alone or use a Combo) — rule in `stack-scale-model.js` ([D102](../../decisions/decisions-dashboards.md#d102--heatmap-labels-draw-themselves-when-they-fit-a-stack-of-very-different-scales-is-flagged)) |
| Line / Area | ≥1 measure | Path can reorder vertices. A colour measure (one measure) colours the markers and the line by value; Size scales each marker |
| Pie / Donut | 1 dimension + 1 measure | legend-labelled slices; measure → angle; a colour measure shades the slices, a Colour field splits each slice by member ([worksheet-marks-colour.md](worksheet-marks-colour.md#a-colour-field-on-pie--donut)); Size has no meaning here. Data labels writes "name: value" on each slice, plus its percent when there are up to 6 slices |
| Scatter | 2 measures (X, Y) | Size, continuous Colour, a Colour dimension (one series per member) and Shape apply (Shape takes a dimension, or a measure binned into symbols: [worksheet-marks-shape-label.md](worksheet-marks-shape-label.md)). Both axes fit the data (they do not start at 0) |
| Combo (dual-axis) | 2 measures | The 1st measure as bars; the rest on a right axis as a line (Format → **Right-axis marks**: Line, Bars or Area). Always vertical. Format → **Synchronise axes** shares one range |
| Square / Circle | as scatter | scatter builder with a symbol override (same fitted axes) |
| Heatmap | 2 dimensions + 1 measure | Single-hue token colour scale. Format → **Shape**: **Squares** (cells) or **Circles**. Circles are scatter marks on the same category grid: 80 % of the smaller cell side, 6–48 px, re-sized with the pane. Cells without a value draw no circle. Circles are coloured by the same value legend; tooltip and Reverse palette behave as for squares; the cell banding is dropped. **Value labels** (14 px) draw themselves when the longest one fits a cell (about 8 px a character plus 8 px, and 20 px tall; a circle's diameter is its cell), so the grid shows all its labels or none; they are read from the live chart on every draw, so resizing the pane shows or hides them. Format → Data labels forces them on every cell. Each label's ink is picked per cell colour (`pickInk`) ([D102](../../decisions/decisions-dashboards.md#d102--heatmap-labels-draw-themselves-when-they-fit-a-stack-of-very-different-scales-is-flagged)) |
| Treemap | 1–2 dimensions + 1 measure | nested rectangles sized by the measure, or by the Size measure (then the shelf measure is the label's second line); a colour measure shades the tiles |
| Histogram | 1 numeric field | equal-width bins; own endpoint. A whole-number column (Int / UInt) bins on whole-number widths and the axis reads "3" or "3–4" (never "1–1.4"); the response carries `whole` |
| Box plot | 1 numeric field, a column or a row-level calculation (+ optional group dimension, from any related table) | Q1 / median / Q3, whiskers at the 1.5 IQR (interquartile range) fences, outlier points beyond them (hollow rings, ≤ 500); `POST /api/boxplot` |
| Waterfall | ≥1 dimension + 1 measure | Each value is a change from the running total, then a **Total** bar. Increases `--chart-cat-1`, decreases `--chart-cat-6`, total muted — legend-named, and each step labelled with its sign. May run below zero (drawn as a custom series) |
| Funnel | 1 dimension + 1 measure | Stages widest first, each labelled with value and % of the first. Label ink picked per stage |
| Gauge | 1 measure, no dimension | Arc from 0 to Format → **Target** (else a round maximum). Value and "% of target" written in the middle |
| Bullet | 1 measure (+ ≤1 dimension), + an optional 2nd measure, + Format → **Target** | Per member: the value bar over three bands (< 50 %, 50–75 %, 75–100 % of target) with the target tick. Format → **Target field** picks the view's second (or later) measure as the target, so each member has its own target (the tooltip shows it and the %). With no field, the fixed **Target** number applies to every member. With neither, a hint |
| Gantt | 1 dimension + 2 measures (start, then length or end) | One horizontal bar per member, first on top, from the first measure (start) to start + the second (the length) — or, with Format → **Length = End**, to the second measure read as the end (the length is then end − start). A date start (a date field used as a measure with Minimum / Maximum) draws a time axis and a length counts days; with End the second measure must be a date too. A number start draws a value axis. The length is written at each bar's end and the tooltip shows start → end and the length. The date axis shows the time too when the bars carry one and span under three days; whole days are calendar days (a daylight-saving change keeps the clock time). The right margin grows to fit the widest length label. A categorical **Colour** field draws a bar per row and member (a row with several members shows several bars on its line), one series per member in its palette or member colour, with a legend that highlights (the other members fade) and selects the member (Format → Edit member colours lists them); the tooltip names the member, so colour is never the only cue. Without Colour the one-item legend is not a toggle. A **Size measure** sets each bar's thickness (6 px to 80 % of the row slot, Format → Edit Sizes applies; a Size dimension is a hint), see [D123](../../decisions/decisions-marks.md#d123--gantt-bar-size-from-size-a-measure-sets-each-bars-thickness). A bar click selects its row's primary-dimension value (click-to-filter, [D104](../../decisions/decisions-dashboards.md#d104--a-gantt-takes-its-end-from-a-field-splits-by-colour-and-is-a-click-target)); on a dashboard the source widget fades the other rows. Rows without a valid start, with a negative length (End: missing or before the start), or whose end is not a finite date or number are skipped and counted in the notice; a zero length is a thin bar. A numeric Colour field is not drawn |
| Sankey (flow) | 2 dimensions + 1 measure | Flows from the first dimension's members to the second's. Non-positive flows are skipped. A member on both sides stays two nodes |
| Small multiples | 2 dimensions + ≥1 measure | A mini line chart per member of the **first** dimension (at most 24 panels, with a notice), the second along each x axis, one shared y scale |
| KPI | measures | big number per measure; with a dimension, an inline SVG **sparkline** of the trend, and the number is the **last member's**, not a total: the note under it names it ("SUM QUANTITY", then "Vietnam · last of 6") |
| Text | — | renders the crosstab text grid |
| Table | — | the crosstab ([worksheet-table-view.md](worksheet-table-view.md#table-view--a-true-rows--columns-crosstab)) |

### Text measure values

- `min` / `max` of a text or date field return a **string**. An aggregate over no rows returns `null`.
- Only **Table, Text and KPI** can show a string value. Any other chart type shows a hint: "Min/Max of a text or date field shows as Table, Text or KPI — switch the chart type, or use Count."
- Null values render as "—".

### The P36 types (Waterfall, Funnel, Gauge, Bullet, Sankey, Small multiples, Gantt)

- All seven run on the ordinary `/api/query` result.
- Sizing: Waterfall scrolls like a bar chart; Bullet and Gantt grow down the left (one slot per row); Funnel, Gauge, Sankey and Small multiples always fit the pane.
- Gantt is a click-to-filter target (a bar selects its row); the others aren't.
- Code: `renderP36` in `render-special.js`; builders in `chart.js`; pure helpers `waterfallSteps`, `niceMax`, `multiplesGrid` and `Dashboard/gantt-model.js` (bars, split, Size shares and thickness; unit-tested).

### Measures and dimensions

- No dimensions at all → KPI tiles.
- Scatter / combo / stacked read the first two measure pills. A shelf already holds any number of measures, so there is no separate 2nd-measure shelf.

## Chart type control

One control picks the chart type. The view bar's picker (icon + name, e.g. **KPI**) opens a two-column menu of every type. Show Me's cues are folded into it, for the fields **already on the sheet**. Code: rules in `Dashboard/show-me-rules.js` (pure, unit-tested); counts per candidate type in `showMeCounts` in `dashboards.js`.

- **Dimmed types.** A type the fields can't draw is dimmed, with the reason as its tooltip. It is still pickable; the chart then shows the hint. The first matching rule wins:
  1. Min/Max of a text or date value → only Table / Text / KPI.
  2. A discrete Colour split on bar / stacked / line / area needs exactly one measure (scatter-family Colour splits need the usual two). With one it is valid, since the split renders before the rule table.
  3. Histogram / box plot need a numeric field.
  4. Then `CHART_NEEDS`.
- **Best fit.** The best fit carries the Show Me icon (tooltip "Best fit for these fields"), only if it is valid and Columns / Rows aren't empty. It is chosen from the dimensions on Columns / Rows (plus a drill level); encodings don't steer it:
  - none → nothing;
  - text Min/Max → Table;
  - ≥ 3 dims → Table;
  - 0 dims → Scatter at 2 measures, else KPI;
  - a date dimension → Line;
  - 1 dim → Bar;
  - 2 dims + 1 measure → Heatmap;
  - otherwise Table.
- **Picking.** The current type is ticked. Picking sets the type in one commit (one undo step); Columns / Rows stay where they are.

## Analytics (P21)

The view bar's **Analytics** button opens a card, like Format (`analyticsPanel`, `sheet.analytics`). Everything is computed in the browser over the rows returned (`Dashboard/analytics-model.js`, unit-tested). Over a cut-off result the info line says "Analytics use only the rows shown — more exist."

### Adding items

On Bar / Line / Area the card opens with a row of **items**: Reference line, Band, Trend line (and Forecast on Line / Area).

- **Drag** an item onto the chart, or **press** its button (keyboard). It switches on at a default (Average, Mean ± 1σ, Linear, 3 steps), and the selects below show and edit it.
- An item already on is shown pressed, with a check after its label (each item has its own icon). Pressing it again switches it off. A drop on an item already on changes nothing.
- A drop is accepted only while the card is open (`analyticsDrop`).
- Focus returns to the pressed item after the re-render.
- Code: items and defaults are `itemsFor` / `addItem` / `removeItem` in `analytics-model.js`. Items write the ordinary saved `sheet.analytics` shape.

### Bar / Line / Area

- **Reference line** — Average, Median, Minimum, Maximum or a Constant. Drawn dashed and labelled "Average: 16".
- **Band** — shaded and labelled with its rule. Its ends are typed **from / to** numbers, **Mean ± 1σ** / **± 2σ** (sample standard deviation, ≥ 2 values), or a percentile range **P25–P75** / **P10–P90** (linear interpolation), or **Percentiles** with typed low and high percentiles (start P5–P95; `0 < low < high < 100`, an invalid pair is refused with a message, the box returns to the stored value and the band is left as it was, never clamped; with one row the band has zero width, like the presets; a saved workbook is checked the same way and an invalid band is reset).
  - Choosing Typed range draws nothing until two different numbers are typed.
  - With too few values (or typed ends that are equal) there is no band, and an info line says why.
  - A σ / percentile band's label says "(shown rows)".
- **Which measure (line and band).** They read the measure chosen in **of**: any measure on the shelf, shown when there are two or more. A non-default choice is named in the label ("Average (sum discount): 35"). They read the rows shown, with the "Other" remainder left out.
- **Trend** — Linear, Logarithmic (`a + b·ln(x+1)`), Exponential (`a·e^(b·x)`), Power (`a·(x+1)^b`) or Polynomial (2nd, 3rd or 4th order: `a + b·x + c·x² …`, solved on x scaled to 0..1 and shown in x), on one measure in category order (the first, or the one chosen under **trend of** when two or more measures are shown; the choice also moves the forecast); x is the category's position (the first is 0). Exponential and power are fitted as a straight line through ln y, and their R² is measured on the original values. Drawn dotted and named at its end with R², the p-value and sample size ("Trend · good fit (R² 0.86) · p < 0.001 · n = 9"); the series name, with the formula ("y = 15.2·e^(0.251·x)", minus written "−", a negative exponent in parentheses), is in the tooltip. R² is measured on the original values, the scale the chart shows. If the fit would give a non-finite point the line is dropped; when a forecast was asked for, the info line says it is not drawn either. Exponential and power need every value above zero: otherwise no line is drawn and an info line says so (blanks are skipped, never counted as zero). A polynomial of order d needs at least d + 2 values (d + 1 would interpolate exactly and prove nothing), a straight line or the others at least 2: otherwise no line is drawn and an info line names the count. **A cut-off result is not fitted:** when the result is truncated at its limit or partial, no trend and no forecast is drawn and an info line says the fit would describe only the rows shown (reference lines and bands still draw, with the "Analytics use only the rows shown" line).
- **p-value** — the F-test of the whole fit (all slopes zero), shown as "p = 0.046" or "p < 0.001" (`pWords`; `stats-dist.js`, no statistical runtime). For exponential and power it is the test on the straight-line fit of ln y. It is left out when it is undefined: no degrees of freedom left (2 points on a line, d + 1 on a polynomial) or a flat series. A perfect fit shows "p < 0.001".
- The trend label puts R² in words, keeping the number: "poor fit (R² -0.12)" (below 0.1 poor, 0.4 weak, 0.7 moderate, else good; `fitWords`). Reference-line and band labels sit on a surface backing above their line.
- **Forecast** (Line / Area) — 3, 6 or 12 steps that extend the trend (linear if none is picked) into "Forecast +1 …" categories.

### Table / Text

- **Grand totals** — a Total column when Columns has dimensions, a Grand total row when Rows has.
- **Subtotals** — after each first-level Rows group, with ≥ 2 Rows dimensions and the measures across the top.
- Totals use each measure's aggregation (`combine`): sums and counts add; min / max take the min / max. An average, a distinct count or a table calculation shows "—" rather than a wrong number.

## Orientation

`chartOrientation(sheet)` follows Tableau:

- A **dimension on Rows** (and none on Columns) renders **horizontal** bars: category down the left, first on top.
- A dimension on Columns renders vertical (the default).
- `buildCartesian` swaps the axes for bar / stacked / line / area.
- Row-dimension facets / small multiples are not supported.

**Line style** (Format; Line, Area, Combo; also the dashed comparison lines, not the trend line):

- **Straight** — point to point.
- **Step** — each value holds until the next category, then changes.
- **Step (centred)** — a connected step that changes half-way between two categories (stored as `jump`).
- Code: `format.lineStyle`; ECharts `step` `end` / `middle` via `lineStep`.

**Line pattern** (Format; Line, Area, Combo lines; `format.linePattern` `dashed` | `dotted`, absent = solid):

- **Solid, Dashed, Dotted** apply to the plain measure lines: a line, an area's border (not its fill), a combo's line and area-marks series, every measure alike (colour and the legend still name them).
- **Solid wherever the dash would carry or lose meaning:**
  - a straight line whose own thickness follows a Size field (the thickness is drawn as polygons a dash cannot break up) while it has at most 2,000 points; past that the markers carry Size, so the pattern applies and Line markers is the disabled control (the panel reads the point count the chart last drew);
  - several measures under a colour measure, where each measure's own cue dash names it (the cue wins).
  The control is then **disabled, reads Solid and its title says why**; a stored choice applies again once the cause goes.
- **Comparison lines** stay dashed and faded; beside a Dashed or Dotted main line they take a dash-dot so the two still differ without colour. Reference lines and bands are analytics and never patterned; the trend line stays dotted (with its end label), and beside a Dotted main line it takes the dash-dot too, so the two differ by more than colour.
- Both controls are disabled with a reason on a combo that draws no lines (one measure, or Right-axis marks = Bar).
- Code: `Dashboard/line-style-model.js` (`effectivePattern`, `lineDash`, `comparisonDash`, `lineControlSpecs`), drawn in `buildCartesian`; the controls are wired by `Dashboard/line-controls.js` (`wireLineControls`); [D119](../../decisions/decisions-marks.md#d119--line-pattern-and-line-markers-on-the-marks-card).

**Line markers** (Format; Line, Area, Combo lines; `format.lineMarkers` `selected` | `all` | `none`, absent = Automatic):

- **Automatic** — a dot on every point up to 60 points (or whenever Marker size is set); a longer line shows none.
- **Selected** — a dot only at the **click-selected marks**: every series' point at a selected category (the worksheet's click selection in the editor, the board's cross-filter selection on a dashboard widget; independent of Label marks). **No selection = no markers** (stated in the control's title), except a lone value, which keeps its dot. Every other point keeps a clear (transparent) dot so a click can select it and hover shows it; a long line gets only the selected dots, and a big canvas chart skips LTTB sampling as for All. Offered only where a mark can be selected (a dimension that is a real column). An export shows the dots of the selection at export time ([D124](../../decisions/decisions-marks.md#d124--line-markers-selected-dots-only-at-the-click-selected-marks)).
- **All** — a dot on every point however long the line (ECharts is told not to thin them, and a big canvas chart skips its LTTB sampling so no point, and no marker, is dropped; the point cap bounds the work).
- **None** — no dots. A **lone value** (no neighbour to draw a line to: a one-point line, a point between gaps) keeps its dot so no value disappears. Hover still shows the point's dot and the tooltip (axis pointer); Data labels still draw, on dots filled and bordered `transparent` (not opacity 0, which a label would inherit) that come back in the mark's colour on hover. Its title notes that Marker size and Marker shape then have no other effect.
- **A marker that is data stays** (under Selected and None): Size on a stepped line or an area sizes the markers (D108), and a colour measure beside several measures gives each measure its own marker; the control is **disabled, reads All and says why**.
- Code: `Dashboard/line-marker-model.js` (`markerPlan`, `isolatedPoints`), `lineMarkersSpec` in `render-cartesian.js`, `clearDots` in `chart.js`. Browser checks: `tests/live/line-pattern-ui.mjs`, `tests/live/line-selected-ui.mjs`.

### Dual axis, marker size, marker shape and mark borders

- **Right-axis marks** (combo only; `format.secondaryType` `line` | `bar` | `area`, default `line`) — draws every measure after the first on the right axis as lines, bars or a filled line. Bars on the right axis sit beside the left bars. The line style applies to line and area.
- **Synchronise axes** (combo, and Line / Area with Dual axis on; `format.syncAxes`, default off) — gives both value axes the same `min` / `max`. Off, each axis scales on its own.
  - The range covers all the measures' finite values, rounded out to a 1 / 2 / 5 × 10ⁿ step.
  - It includes 0 for the combo (its first measure is bars) and for an area chart, but not for a line chart.
  - Null, NaN and non-numbers are skipped. No data leaves the axes automatic. All zero gives 0–1.
  - Code: `syncRange` in `Dashboard/axis-sync-model.js`.
- **Dual axis** (Line and Area; `format.dualAxis`, default off) — with two or more measures, draws every measure after the first on a right value axis, in the chart's own mark (lines, or filled lines). Code: `dualAxisOn` in `Dashboard/axis-sync-model.js`.
  - Titles: the right axis is titled with the names of the measures on it (`rightAxisTitle`); the left with the first measure (or Format → Y title). The legend names every series. A long right-axis title is cut with an ellipsis (the legend lists every measure).
  - **Synchronise axes** appears with it (a line chart's shared range need not include 0; an area chart's does). Right-axis marks is combo only.
  - Which axis: comparison lines ride their measure's axis. The reference line and band sit on the series of the measure they read (Analytics → of), so a right-axis measure's line is drawn on the right scale. The trend and forecast follow the measure chosen under **trend of** (the first by default) and sit on the left axis.
  - With a dimension on Rows (horizontal chart) the Dual axis checkbox is disabled and the chart keeps one axis.
  - Not built: scatter, independent mark types per measure, a user-set axis range.
- **Marker size (px)** (`format.markerSize`: blank = automatic, else a whole number 4–40) — out-of-range input is refused with a toast, never clamped. It sets the point size of:
  - scatter / square / circle marks when no Size field is mapped (default 14, shape scatter 12);
  - line / area / combo markers (default 8, which also keeps the dots on a long series; a Size field overrides it per point on an area or a stepped line, while a straight line's Size varies its thickness and keeps this size);
  - the circle heatmap (otherwise 80 % of the cell).
  - It is not offered on squares heatmaps or on charts without point marks.
- **Mark border** (`format.markBorder` `none` | `thin` (1 px) | `medium` (2 px) | `thick` (3 px), default `none`) — strokes marks in the chosen border colour (default the muted chart ink, `--chart-muted`; all follow light and dark).
  - **Border colour** (`format.markBorderColor` `muted` | `ink` | `surface` | `accent`, optional, absent reads `muted`) — a palette token resolved per theme (`borderInk`); the Format field shows only while a border is set. It is not a free colour (see backlog: palette editing).
  - Applies to bars (also stacked, combo, colour-by-category and the Other bar), scatter / shape points, line markers, heatmap cells, pie / donut slices, treemap tiles, funnel steps, histogram bins, box plot boxes, waterfall and Gantt bars, the bullet's value bar and Sankey nodes (gauge has no marks, so no border). Custom-drawn shapes (waterfall, Gantt) take a stroke (`strokeOf`); the rest an ECharts border.
  - `none` keeps the default look: the heatmap, pie, treemap, funnel, histogram and Sankey keep their surface-coloured gaps, and the box plot its series-coloured outline. A chosen border replaces that edge (`edgeOr`).
  - Code: pure mapping in `Dashboard/mark-style-model.js` (`markBorder`, `borderInk`, `edgeOr`, `strokeOf`, `BORDER_TYPES`, `markerSizeOr`, `markerSizeError`).
- **Marker shape** (line / area / combo; `format.markerShape` `circle` | `square` | `diamond` | `triangle`, default `circle`) — sets the symbol of the line markers (`markerSymbol` maps to the ECharts symbol). The shape is the same on every series of the sheet.
- Both Format cards and the dashboard widgets read the same sheet `format`, so non-interactive views draw the options too. Browser check: `tests/live/charts2-ui.mjs`.

## Query paths

- **Standard types** (bar … treemap, KPI, table) all use the one bounded `POST /api/query`. Heatmap and treemap pivot its 2-dimension result in the browser (`renderHeatmap` / `renderTreemap` in `render-special.js`; pivots in `result-model.js`).
- **Histogram** is a single-table shape with its own endpoint (`POST …/histogram`). It bypasses `buildPlan` (`runStat`) and reads the first numeric field. Bins default to 20; the server rejects a count outside 1..100.
- **Box plot** is `buildPlan` with the first numeric field as the one row dimension (never aggregated) and the first other field as the one column dimension (`Dashboard/box-plan.js`, `runBox`), sent to `POST /api/boxplot`. Joins, filters (Top-N, calculated, dashboard selection), calculated fields, data type casts, and a union / unpivot source all work as in other charts. A calculation with an aggregate, or a non-numeric one, is refused with a message. Over a one-to-many join the box counts every joined row, so quantiles are row-weighted. Filters on other tables, shared filters and a dashboard selection now apply through the joins (the old single-table box plot ignored them). An aggregate-before-joining relationship is refused. Measure filters don't apply (the line says so). The group count is Top-N, else 5000.
- SQL for each: [clickhouse-integration.md](../../reference/clickhouse-integration.md#the-queries-all-read-only).

## Rendering — the ECharts adapter

### Library and theming

- **Apache ECharts** is vendored at `Features/Core/vendor/echarts.min.js` and loaded as a classic global script **before** the module graph ([D13](../../decisions/decisions-platform.md#d13--charting-via-self-hosted-apache-echarts-svg-renderer-themed-from-tokens)).
- **`chart.js` is the only module that touches ECharts.**
  - `renderChart(container, spec)` maps a result to an option and manages **one live instance per container** (SVG renderer). The palette order and member colours are per-container state too.
  - `disposeChart()` tears the instance down before every repaint.
  - It dispatches by family: `buildCartesian`, `buildPie`, `buildScatter`, `buildScatterShapes`, `buildHeatmap`, `buildTreemap`, `buildHistogram`, `buildBoxplot`.
- **Table, Text and KPI are native DOM**, not ECharts.
- **Themed from tokens.** `chart.js` reads `--chart-*` via `getComputedStyle`. Text wears ink tokens; marks wear the series colour ([design/tokens.md](../../reference/design/tokens.md#chart-tokens)).
  - It re-renders the active chart on `scheme:changed`, when light / dark is flipped ([tokens.md § Light and dark](../../reference/design/tokens.md#light-and-dark); listener in `dashboards.js`).
  - Treemap tile labels pick their ink per tile with `contrast.js`.
- **Resize.** A `ResizeObserver` on the chart host calls `instance.resize()` (sidebar drag, window). The host is absolutely positioned to fill the padded `.ws-chart` pane, so ECharts always has a definite size.

### Category axes and sizing

- **Every category is shown and labelled — the pane scrolls instead of squeezing.**
  - `chartFit` (`Dashboard/chart-fit.js`, pure) gives each category a slot: 28px along a bottom axis (wider for grouped bars: 12px per bar), 24px down a left axis. It sets the host's `--chart-min-w` / `--chart-min-h`.
  - A chart with more categories than fit (e.g. 50 customers on a narrow pane) keeps that size and `#ws-chart` scrolls: sideways for vertical bars / lines / area / combo / histogram / boxplot, down for horizontal bars, both for a heatmap.
  - Category axes label every category (`interval: 0`, no `hideOverlap`). Bottom labels turn upright when they can't sit side by side (re-checked on resize). Bottom labels truncate at 160px (an upright one at about 40 % of a short pane, 48px at least — `rotatedLabelCap`, so a small dashboard widget shows "Philip…" instead of clipping), left labels at 200px; the tooltip carries the full name.
  - Pie, donut, treemap and scatter have no category axis and always fit the pane.
- **Fit** (P23, `format.fit`) — `applyFitMode` drops the minimum width / height (and the zoom) on the fitted axis. Its labels then thin out (`hideOverlap`) instead of forcing a slot each.
- **Big charts.**
  - Past **1,000** categories an axis stops growing. A themed **zoom slider** (plus wheel / drag in the plot) shows a pane-width window of categories at a time (`addZoom`).
  - Past **1,500** marks the chart draws on **canvas** instead of SVG. Bars use ECharts' large mode (unless a bar carries its own colour) and lines use LTTB sampling, so peaks survive (`tuneForSize`).
  - Canvas charts skip the entrance animation.

### Date axis labels

Only when the chart's first dimension is a date. Code: `Dashboard/date-axis.js` (pure), wired in `chart.js` `dateAxisLabels`.

- **Shortening.** Datetime labels are shortened to what varies across the data: midnight-only reads as dates, one day as times, one year drops the year, zero seconds drop. Other text is left alone.
- **Thin out** draws only as many labels as fit the measured text width (canvas `measureText` in the axis font) plus 8px.
  - Labels are spread evenly with the **first and last always shown** and none touching; end labels hang inward. A left axis needs 18px a label.
  - When ticks land a day or more apart, the time of day is dropped.
  - A bottom axis that can't hold three horizontal labels turns them upright.
  - Works on the left axis of horizontal bars too, and is re-planned on resize.
- **Show all** keeps every label, shortened.
- The tooltip keeps the full value.

### Special marks and clicks

- **Comparison series** (`compare: true`, P35) don't make a chart multi-series; the measure keeps the brand colour. A line is dashed and faded; a bar muted and hatched (an ECharts `decal`). The legend names each — [worksheet-encodings.md](worksheet-encodings.md#date-range--comparison).
- **Other mark:** `otherIndex` colours the "Other (N more)" bar / slice with `--chart-muted`.
- Chart clicks are forwarded to the worksheet for click-to-filter and drill ([worksheet-encodings.md](worksheet-encodings.md#click-to-filter)).

## Export

The view bar's **Export** menu (`exportControl`, icon button) also holds **Print / PDF…** ([layout.md](../../reference/design/layout.md#full-screen--print)).

- **SVG** — serialises the rendered `<svg>` element (`instance.getDom()`). `renderToSVGString` exists only on SSR (server-side rendering) instances, so it is not used.
- **PNG** — rasterises that SVG through a canvas (`exportChart` in `chart.js`).
- **When SVG / PNG are offered:** only when a chart instance exists; Table / KPI / Text export CSV instead. A canvas chart exports PNG from the canvas, and SVG by redrawing the same option off-screen as SVG.
- **CSV** — posts the same bounded worksheet plan to `POST /api/query/export.csv`.
  - It asks for the **whole result**: up to 100,000 rows, no Top-N, no paging, no Other row (same date grouping as the view).
  - Serialised by `CsvUtil`: RFC-4180 quoting plus a **formula-injection guard** (a leading `= + - @` is prefixed with `'`).
- Histogram and box-plot data have no CSV export (their result is bins / five-number summaries, not rows).
