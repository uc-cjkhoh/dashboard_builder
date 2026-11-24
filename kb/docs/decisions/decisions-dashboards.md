---
components: [src/DashboardBuilder/Features/Board/board-interact.js, src/DashboardBuilder/Features/Board/board-layout.js, src/DashboardBuilder/Features/Board/board-model.js, src/DashboardBuilder/Features/Core/menu.js]
---
# Decisions — dashboards

Continues [decisions-platform.md](decisions-platform.md) (D1–D25) and [decisions-calculated-fields.md](decisions-calculated-fields.md) (D26–D60, D65–D68, D73).
Behaviour: [tabs.md](../concepts/workbook/tabs.md), [workbook.md](../concepts/workbook/workbook.md). Edit an entry in place when it changes.

### D61 — Worksheets and dashboards are separate tab kinds; workbook format v2
**Tableau-style.** A worksheet is a tab edited on its own. A dashboard is a second tab kind that composes existing
worksheets (and text) on a 12-column snap grid; one worksheet may sit on several dashboards.
- **One ordered list.** The store keeps **one ordered `tabs` list** — `{ id: "ws#n", kind: "worksheet", name, sheet }` and
  `{ id: "db#n", kind: "dashboard", name, widgets }` — so the strip order is the data order.
- **Naming.** Inside the editor, worksheet tabs use worksheet names (not `dashboards`): the event `worksheet:changed` and ids
  `ws#n`. **"Dashboard" means only the composing kind**; `dashboard:changed` signals a change to a dashboard's widgets.
- **Limits are client-side only**, like calculations: the server never sees a dashboard, there is no new endpoint, and D21 stands.
  - 50 tabs of either kind, 12 widgets per dashboard, `w` 2–12, `h` 2–24 (text 1–24), `y + h` ≤ 96, heading ≤ 80, body ≤ 2000.
  - Creation past a limit is refused with a toast.
  - **Import repairs and reports** instead of refusing the file: it clamps into the grid, moves an overlapping widget to the
    first free spot, and drops one that has no worksheet or no room (`Board/board-model.js`, pure and node-tested).
- **Format v2** saves `worksheets`, `dashboards` (widgets point at worksheets by index), `tabs` (the strip order) and `active`
  (`{ kind, index }`).
  - **Why the version bump:** the shape changed, so **an older build refuses a v2 file** rather than opening it and silently
    losing the dashboards.
- **The v1 reader stays for good** (`migrateV1`). Every v1 `dashboards[i]` becomes `worksheets[i]`, the tab order and `active`
  follow, and a valid v1 file opens with identical content and no issues.
  - Autosave writes `dashboardbuilder.workbook.v2|host|port|user`. With no v2 entry it reads the v1 key and **leaves it in
    place** (never rewritten or deleted), so an older build open in another tab keeps working.
- **Rejected:**
  - keeping version 1 and adding a `dashboards` list beside the old one — names would collide with v1's meaning, and an old
    build would drop dashboards without saying so;
  - a second renderer or a per-widget app copy for widgets — one worksheet view serves the tab and the widget
    ([worksheet.md](../concepts/worksheet/worksheet.md));
  - duplicating a dashboard — its widgets would share worksheets and layout; build another instead.

### D62 — The board renders only the active dashboard, through the editor's result cache
Only the active dashboard has live views: leaving it destroys every widget's worksheet view, and showing it rebuilds them.
- **Shared cache.** Widgets run through the **same result cache as the worksheet editor** (`sharedResults`, keyed by the exact
  request). A widget draws what its worksheet tab just ran, and a re-shown dashboard re-queries only what changed or failed.
- **Layout in JS.** Widget positions are computed by the pure `board-layout.js` (not CSS grid). 
- **Why:**
  - Twelve live charts on a hidden tab would hold queries and chart instances for nothing, and "stale" tracking would be extra
    state. Rebuilding from a content-addressed cache is correct by construction.
  - JS geometry is what pointer snapping, the ghost and keyboard moves need, and it makes the layout rules testable.
- **Rejected:** keeping hidden dashboards alive (leaks); a separate cache per widget (the same query would run twice after an
  edit); CSS grid with `grid-column` (no pixel geometry to snap against).

### D63 — Board edits are refused, never repaired; every verdict is pure
A move, resize, keyboard step or panel drop that overlaps a widget, leaves the grid or breaks a size limit is **refused with a
reason and changes nothing** (the golden-rule-3 stance: reject, don't clamp).
- **One verdict.** `explainRefusal` serves the ghost, the drop and the keys.
- **One leniency:** a panel drop's x slides left to keep the default width inside the 12 columns (the pointer stays within the
  widget).
- **Pure modules.** The pointer state machine, snapping, key steps, and text validation are DOM-free modules with node
  tests. `board-interact.js` only turns events into points.
- **No undo:** the board has no history; removing a widget asks once instead ([D133](decisions-destructive-actions.md#d133--no-undo-one-confirmation-before-every-destructive-delete)).
- **Text widgets** default to 12 × 2 (a 1-row cell showed no body), can still be shrunk to 1 row, and open over their
  neighbours while the edit form is open.
- **Why:** a silent relocation (pushing neighbours aside, clamping into the grid) would make a drop land somewhere the user
  didn't aim, and an exact verdict is testable.
- **Rejected:** auto-pushing overlapped widgets down (unpredictable, can run past 96 rows); a CSS-grid drag library (no tokens,
  no node tests, a dependency).

### D64 — One transient dashboard selection filters the other widgets
A mark click in a worksheet widget sets the dashboard's one selection. Every other worksheet widget adds the same bound `=`
that the worksheet's own click selection uses — **only when the selected table is already in its query** (never a join;
otherwise a note).
- **Source widget.** The source is exempt and fades the other marks; a header chip clears the selection.
- **Lifetime.** In memory only. It ends when the dashboard stops being shown, when its source widget is removed, or when the
  source's primary dimension changes.
- Widgets run `interactive: "select"` (select, never drill).
- **Why:** the smallest model that closes cross-sheet filtering without a join graph or an actions UI. A shared table is the
  same requirement Tableau's filter actions have, and the filter stays within the server's cap of 20 and golden rule 3.
- **Detail.** The dashboard selection replaces a target's own click selection only when it applies (otherwise the widget keeps
  its own). The source's fade re-runs the view from the result cache rather than restyling the live chart.
- **Rejected:** forcing a join to reach a widget; saving the selection; multi-select and configurable actions (backlog IDs
  T08-20..24).

### D69 — A named hierarchy is a workbook list a sheet copies from, not a reference
A hierarchy is `{ id, name, levels }` on the workbook. Applying it writes a fresh `sheet.drill` (the same shape the Drill tool
builds).
- **Why a copy:** the drill state machine and the query path are untouched, and a sheet keeps working when the
  hierarchy is renamed, edited or deleted. A live reference would need a missing-hierarchy state on every sheet.
- **Cost:** editing a hierarchy doesn't update sheets that already used it (re-apply it).
- **Levels** are plain columns of one table. A calculated or cast field is refused, because a cast or formula could change
  under a stored level.
- **Limits** are client-side only.
- **No version bump:** the workbook field is optional, the reader ignores unknown fields, and an absent one means none.
- **Dropping a hierarchy** onto a sheet replaces the drill rather than appending, and clears the sheet's mark selection, as
  drilling does.
- **No next-id counter is saved:** sheets copy levels, not ids, so a reused id binds to nothing.

### D71 — Dashboard images are workbook data URLs, not links
An image widget stores its picture as a base64 data URL in the workbook, read from a file picker in the browser.
- **Limits:** PNG, JPEG, GIF or WebP; ≤ 256 KB per file, ≤ 4 per dashboard and ≤ 2 MB of picture data across the whole
  workbook. They are enforced when adding and again on import, which drops whatever no longer fits. Alt text is ≤ 120
  characters and defaults to the file name.
- **Import** re-validates every picture with the same pattern and drops a widget whose source is anything else.
- **Rejected:**
  - a remote `https:` URL — the board would call a third party every time it opens (tracking, availability, mixed trust) and
    the workbook would stop being self-contained, against golden rules 4 and 10;
  - a server-side upload store — it would add persistence the app deliberately lacks (no application database);
  - SVG — a vector file can carry script.
- **Cost:** workbook size (at most 2 MB of pictures in browser storage; a full quota shows a "Not saved — browser storage is
  full" warning, distinct from storage being unavailable), and no in-place replace — remove the widget and add another.

### D72 — Option controls live in a context popup; one chart-type control
A pill, field row or filter shows only what it is. Every option it has (aggregation, role, table calculation, date part and
label policy, field choices, a filter's operator / sharing / value) opens in one reusable popup.
- **How it opens:** right-click, the ContextMenu key, `Shift+F10` or `Enter` on the focused element. The popup is
  `Core/menu.js` `openContextMenu`, a `role=menu` list on `<body>`, so no panel clips it.
- **Why:** inline controls cost width on every pill whether used or not, and hid what a pill *is* behind what it can *do*.
- **Cost:** discoverability — each such element carries the tooltip "Right-click for options".
- **One chart-type control.** The chart-type picker and Show Me were one decision shown twice. The picker is the single control
  (its dimmed items and best-fit icon are Show Me's cues), and picking only sets the type. Show Me's re-layout of Columns / Rows
  is not offered: it was the redundant half.
- **Marks** live in the field pane as a three-column slot grid with no More menu, so every encoding is one click or drop away.

### D74 — Desktop-only: no phone or tablet layouts, no device preview
Decided 2026-11-02 by the owner. The app targets desktop browsers only.
- **What this means:** the board has one layout (the 12-column grid, or a fixed size); there is no narrow-width stacking, no
  Desktop / Tablet / Phone preview, no phone field-pane overlay and no touch-sized targets. Print and full screen stay: they are
  presentation, not small-screen features. Print still lays the widgets out in one column.
- **Why:** the phone layout was judged complete from CSS alone and never run on a device, so keeping it meant carrying an
  unverified claim, and every region paid for rules that desktop users never meet.
- **Rejected:** keeping the CSS "best effort" (untested rules rot); per-device layouts (T08-05), now out of scope.

### D79 — A compound join key is the first pair plus up to three extra pairs
Decided 2026-11-02 (autonomous build). A relationship may match on more than one column pair.
- **Shape:** the relationship keeps `from` / `to` (the first pair, which draws the line) and gains optional `pairs: [{ from, to }]`, column names on the same two tables.
  A file without `pairs` is an ordinary one-pair link, so v2 workbooks open unchanged and the version stays 2.
- **Limit:** 4 pairs in all (3 extra), refused with a 400, never clamped (`ApiLimits.MaxJoinPairs`, `LIMITS.joinExtraPairs`).
- **Columns:** an extra pair's columns follow the one-relationship-per-column rule, so they are pinned and washed like the first pair's.
- **Preview:** a compound key is read as one string of its parts, NULL when any part is NULL (a tuple can't be Nullable), so a NULL part never matches. Numbers are read as Float64 and dates as DateTime64 before stringifying, so same-kind parts of different types still match as the join's coercion does (exact beyond 2^53 is not promised).
- **Query path:** the query endpoint validates names and the pair count only; a kind mismatch is left to ClickHouse.
- **Suggestions:** same name (exact, else ignoring case and `_` `-` spaces) and the same kind; offered in the dialog, never added silently.
- **Rejected:** a `pairs` list that replaces `from` / `to` (every consumer of a link's ends would change at once); keyboard "add to the existing link" by relating
  two more columns of already-related tables (it would change what that gesture means today).

### D80 — Gantt is a result-shaped mark: one dimension, a start measure, a length measure
- **Shape:** one dimension (the rows) and exactly two shelf measures — the first is the start, the second the length. No new endpoint, no new server limit; it draws the ordinary `/api/query` result like the other P36 types.
- **Date start:** a date field used as a measure with Minimum / Maximum comes back as text; Gantt is allowed to read it (`TEXT_VALUE_TYPES`). The length then counts days (fractions allowed) and the axis is a time axis. A number start gives a value axis and a length in the same unit.
- **Not colour alone:** one bar colour; the length is written at each bar's end and in the tooltip with the start and end.
- **Skipped:** a row with no usable start or a negative length is not drawn and is counted in the notice; a zero length is drawn as a thin bar.
- **Rejected for now:** dependencies — see the backlog. A length from an end field and a colour split were built later ([D104](#d104--a-gantt-takes-its-end-from-a-field-splits-by-colour-and-is-a-click-target)); the "one bar colour" and "not a click-to-filter target" lines above are superseded by it.

### D81 — A story is a tab of captioned steps that point at worksheets and dashboards
- **Third tab kind:** `{ id: "st#N", kind: "story", name, steps: [{ caption, target }] }` beside worksheets and dashboards, in the one strip, under the same 50-tab limit. No endpoint and no server limit.
- **Steps point, they do not copy:** a step holds a tab id, so a story shows the worksheet as it is now and a closed worksheet or dashboard removes its steps. Copying a sheet into each step would freeze it and fork the data; a bookmark step (applying a saved view) would mutate a worksheet just by reading a story, so it is left out for now.
- **The stage is static:** a worksheet step draws through `createWorksheetView({ interactive: false })` and the shared result cache; a dashboard step links to its tab, since the board is built around one active dashboard.
- **Saved as an optional `stories` list in format v2**, with steps as `{ kind, index }`. The version stays 2 because every reader that knows only worksheets and dashboards still opens the file; such a build reports the story entries in the tab order as pointing at nothing and drops them. **Downgrade loses stories for good:** that older build's next autosave overwrites the stored workbook without them.
- **Bounds reject, not clamp:** at most 20 steps and 300 characters per caption; an import skips and reports a step with a long caption or a missing target, and drops steps past 20 with a message.
- **The current step is not saved:** it is reading position, like a dashboard's selection.

## D85 — The diverging scale picks its hues from tokens, not a free-hex picker

- **Decision:** `format.colorPair` chooses the diverging scale's two hues from a short list (Orange / Blue, Amber / Violet, Green / Violet). Each end reads a dedicated `--chart-div-<hue>` token at draw time (not a categorical slot, whose order differs per palette), so a pair follows the light, dark and One Dark Pro themes and keeps the app's saturation ceiling (design rule 4). Red is never an end (it means danger).
- **Not built:** a free-hex colour picker and custom palette editing. A typed hex would be a user colour held as workbook data with no theme variant and no saturation or contrast check; that needs its own contrast rule first (see the backlog entry).

## D86 — Aggregate-before-joining is a per-relationship option on a two-table view

- **Decision:** a relationship may carry `aggregateFirst` (and a `filterDirection`, both or single). A worksheet whose one join is flagged groups each table to the key plus the fields the view groups by, then joins and recombines the partial totals, so a sum or count is not repeated by a many-to-many or one-to-many fan-out.
- **Why per relationship, opt-in:** the plain join stays the default and every existing view is unchanged; the author who knows a link fans out chooses the fix. The data-model needs no engine for it, only a query shape.
- **Filter direction:** a filter is applied inside its own table's subquery. "Both" adds a key semi-join to the other table (what an inner join already does, kept explicit so it also holds with an outer join); "single" leaves the other table whole. Not a model-wide setting: it lives on the relationship it concerns.
- **Bounds reject:** only recombinable aggregates (sum, count, count non-null, min, max, average), exactly two tables, no calculation and no top-N. Each is a 400 naming its field, never a silent fallback to the double-counting join.
- **Known limits:** a date part or bucket groups in the outer query over raw-column subqueries (correct, but more intermediate rows); the implicit count is the base table's row count.
- **Rejected for now:** three or more tables (each edge would need its own grain), distinct count / median / percentile (not recombinable from per-key partials), and a per-measure choice.

## D92 — Per-widget notes are on worksheet widgets only, short, and printed in the header

- **Decision:** a worksheet widget carries an optional `note` (at most 300 characters, client-side only, rejected over the limit and never cut), edited inline from a Note button in the widget header. The printed header lists each as "Note on <worksheet>: …" in reading order; the on-widget note is hidden on paper so it is not printed twice.
- **Why worksheet widgets only:** a text widget already is a note, and an image, spacer or button has nothing to explain. A note says how to read a chart, which is what the guidance item asks for.
- **Not built:** the audience / goal planning prompt and a design-consistency check (fonts, colours and sizes across widgets); both stay in the backlog entry.

## D97 — No red in the categorical palette, and a calm dark accent

- **Decision:** the default and One Dark Pro categorical palettes carry no red (hue 345°–12°): default slot 2 is a rose-magenta (`#b8559c` light, `#d98ac2` dark), One Dark's last slot a mauve (`#b8559c` / `#d68fc0`). Red keeps meaning danger only (design rule 7), so colouring by a normal state such as "Shipped" no longer reads as an error. Slot order is unchanged, so slot-bound users (waterfall decrease = slot 6, data bars, bullet) are untouched.
- **Dark accent:** `--accent` (single-measure bars, primary buttons) and categorical slot 1 move from the neon `#c3df5a` to the sage-lime `#a9bd6a` (S ≈ 38 %, contrast kept; `--on-accent` stays `#12130f`). The wash tint behind the glass keeps the lime `--signal`.
- **Kept:** the Colour-blind safe palette keeps its Okabe-Ito vermilion (an opt-in, fixed published set); Muted has none.
- **Guarded by:** `tests/js/contrast.test.mjs` (no red hue, S ≤ 70 %, a calm dark accent).

### D96 — A number that looks like an identifier starts as a dimension

A beginner test found `order_id`, `line_no`, `customer_id` listed under Measures and summed on placement. A newly placed numeric field whose name reads like an identifier (`id`, `uid`, `pk`, `key`, `code`, `*_id`, `*Id`, `*_no`, `*_num`, `*_number`, `*_nbr`, `*_key`, `*_code`, `*_ref`, case-insensitive) now defaults to a dimension (Discrete); the field pane lists it under Dimensions.

- **Only the default changes.** `defaultRole` (`Dashboard/field-role.js`) runs when a field is placed and when the pane is grouped; an explicit Continuous / Discrete choice and every role stored in a workbook are unchanged (`roleOf` still reads a pill's saved role first).
- **Rejected:** guessing from the data (a distinct-count scan per column); a per-field role setting (more UI for the same result — the pill's Continuous / Discrete choice already does it).

## D100 — Shape stays on the scatter family; Size on a line is the marker size

- **Decision:** Shape (a dimension → one symbol per member; a measure too, binned: [D114](#d114--a-measure-on-shape-is-binned-into-at-most-six-symbols-plus-one-for-a-missing-value)) stays a scatter / square / circle channel only, as in Tableau, where Shape belongs to the Shape mark type; it is not added to bar, line, pie or the rest. A line's markers keep their one shape from Shape flyout → Marker shape. A Colour dimension on the scatter family *does* split the points (one series per member, member colours, a legend), also next to Shape on a different field (colour by the Colour member, symbol by the Shape member).
- **Size on a line / area is the marker size** *(the line part is superseded by [D108](#d108--size-a-dimension-steps-marks-edit-sizes-a-lines-own-thickness-text-size-and-size-beside-a-colour-split): a straight line draws its own thickness; an area and a stepped line keep this)*, 6–24 px per point by its share of the data's span. Tableau varies a line's thickness per segment; ECharts draws one width per line series, so the markers carry the Size value (always shown while Size is set) and a Size legend names the field and its range in words. A bar's thickness is a custom series (ECharts has no per-bar width), 6 px at the smallest value up to 80 % of the category band.
- **A colour measure needs one measure on bar, line and area.** Tableau colours every measure's marks by the colour measure; here the measures would then look alike (the palette is what tells grouped bars and lines apart), so several measures give a hint and keep the palette. A Stacked bar and a Combo give a hint too.
- **Not built:** Size on pie / donut (no per-slice meaning; still a hint, see [D108](#d108--size-a-dimension-steps-marks-edit-sizes-a-lines-own-thickness-text-size-and-size-beside-a-colour-split)), a free Shape on other types. A thickness per line segment is built by D108.

## D102 — Heatmap labels draw themselves when they fit; a stack of very different scales is flagged

- **Heatmap cell labels are automatic.** Label flyout → Data labels is a plain checkbox (off by default), so it cannot also mean "hide". Unchecked = automatic: the labels appear when the longest one fits a cell, all or none for the grid (a ragged grid reads worse than none). Checked = forced on every cell, fitting or not. There is no way to hide labels that fit; a third state waits for the tri-state Data labels setting (see the Pie / Donut entry in [charts-and-formatting.md](../development/backlog/charts-and-formatting.md)).
- **The fit rule is an estimate**, 8 px a character plus 8 px of padding wide and 20 px tall at 14 px type (the chart-fit estimate), against the cell read from the live chart (`cellSizeOf`, minus the axis gutters). In the standard Fit a cell is never under 28 × 24 px, so only short labels show on a narrow column; Format → Fit (width / entire) can make cells smaller still.
- **Ink per cell** is `pickInk` against that cell's own colour on the legend's scale (also stepped and diverging), from the surface and ink tokens plus black and white.
- **Trend p-value, polynomial orders and refusals (D103).** The trend models get orders 3 and 4 (`poly3`, `poly4`, joining `poly2`; linear is order 1) by widening the `trend` choice only, with no new workbook field. A polynomial of order d needs d + 2 values: d + 1 values fit exactly, so R² = 1 and no test is possible, and such a line would look like evidence. The p-value is the overall F-test of the regression (all slopes zero), computed in the space the model is fitted in: ln y for exponential and power, y otherwise. It is the one number that is defined for every model and is the slope's t-test for a line. It is omitted rather than invented when it is undefined (no degrees of freedom, a flat series). The distribution is implemented in `stats-dist.js` (Lanczos log-gamma, continued-fraction incomplete beta) and verified against published 5 % critical values, because there is no statistical runtime. A result truncated at its limit or partial is refused outright for the trend and the forecast, with a message, rather than fitted with a notice: an extrapolation over part of the data is a wrong answer that looks right. Reference lines and bands keep the existing notice, since they describe the rows shown and say so.
- **Stacked bar scale notice.** A measure whose largest value is under 2 % of the tallest stack (sum of the absolute values per category) is a sliver a few pixels high. The worksheet notice (icon + words, never colour alone) names up to two such measures and says what to do: chart it on its own or use a Combo chart with a second axis. 2 % is about 6 px of a 300 px plot; nothing is hidden, rescaled or refused. A Stacked bar split by a Colour field is one measure and is not checked.

## D104 — A Gantt takes its end from a field, splits by colour, and is a click target

- **Length or end.** Format → **Length** (`format.ganttLength`: `length` | `end`) says what the second measure is. With End the bar runs from the start to that measure and the length is the difference: calendar days between two dates (clock time kept, a daylight-saving change adds no hour), the plain difference for numbers. Both measures must be the same kind: a date start with a number end skips the row. An end before the start skips the row (a negative length); an end equal to the start is a thin bar. A setting, not a third measure role, because the shelf order is already the meaning (start, then the second) and a Gantt with both a length and an end would be redundant.
- **Absent reads Length and stays off the defaults** (like `markBorderColor`), so v1 workbooks and the frozen golden files round-trip unchanged; an unknown value resets with a note.
- **Colour split.** A categorical Colour field is the last group-by key, as on bar and scatter; `gantt` joins `COLOR_USES`. The rows are the other keys and several bars may share a row (one per member), one custom series per member so the legend and member colours (Edit member colours in the Color flyout) work as elsewhere. A legend click highlights its member: the focused member keeps full strength with the emphasis stroke and the others fade to 35 % opacity, drawn by the Gantt itself on the redraw the click causes, because ECharts does not blur custom marks (a static dashboard widget, which does not redraw, shows only the stroke on the focused member). Show Me and the chart hint count the rows only (`dimsFor`): the Colour key is not a row dimension. Bars of one row overlap if their spans do; nothing is stacked or offset, because a task's phases on one line is the usual reading and an offset would imply a second row. A numeric Colour field (a gradient) is not drawn. The tooltip names the member, so colour is not the only cue.
- **Click-to-filter.** `gantt` joins `CLICK_TYPES`: a bar selects its row's first-key value through the same `selectHandler` as a bar chart (so NULL members, date-grouped keys, casts and calculated dimensions select nothing, and a dashboard's source widget fades the other rows). Several bars on one row select the same value.
- **Not built:** dependencies (arrows between bars) and the density surface stay in the backlog.

## D108 — Size: a dimension steps marks, Edit Sizes, a line's own thickness, Text size, and Size beside a Colour split

- **A dimension on Size gives each member a step**, as Tableau's discrete size: members ordered by value (numbers) or locale (text), a missing member last, spread evenly from the smallest mark to the largest. It is one more group-by (after Detail, before Shape and Colour; the same field already on a shelf, Detail, Shape or Colour groups once) and is added **only where the chart draws it** (scatter family, a one-measure bar, line, area), so a hint chart never pays for an unused key. Treemap (area is a measure), Text / Table (a font size by member means nothing), Stacked and pie / donut get a hint. Order by *member order* means sorted, not first-seen, so the steps do not change when the sort does.
- **Edit Sizes is stored as `format.sizeScale`** `{ smallest?, largest?, vary?, start?, end?, fromZero?, reversed? }` (`vary`, `start`, `end` and the `fromZero` pointer: [D120](decisions-marks.md#d120--edit-sizes-sizes-vary-and-a-typed-start-and-end-value)), off `defaultFormat` (like `ganttLength`): absent = today's drawing exactly. *Smallest / Largest* are whole percentages of the chart's own size range (0–100, smallest below largest) rather than pixels, because the ranges differ per mark (bubble 8–36 px, bar 6 px to 80 % of the band, marker 6–24 px, line 2–12 px, text three steps). *From zero* (now the Sizes vary drop-down: [D120](decisions-marks.md#d120--edit-sizes-sizes-vary-and-a-typed-start-and-end-value)) absent follows the chart (on for bubbles, whose long-standing span is min(0, smallest) to max(1, largest) and is kept as is; off elsewhere; where on for bars, lines, areas and Text / Table the span is min(0, smallest) to max(0, largest), with no floor of 1, so values all below 1 still fill the range); an explicit value is kept either way. *Reversed* gives the largest value the smallest mark (all equal / one member is never reversed). A treemap takes no range (its area is the value; reversing would misread). Invalid saved parts are dropped and reported, never clamped.
- **Line thickness: segment overlay, beside the real line.** A straight line's width varies by drawing one tapered quadrilateral per segment in a silent `custom` series under the line (same name, so one legend entry toggles both; not listed in the tooltip). The real line stays, so the markers, axis tooltip, click-to-filter, analytics, legend and colour gradient are untouched, and a dual axis works (the overlay takes the line's axis). The cost: the overlay is a second series per line and joins between sharply turning segments are not mitred. **Bounded:** it is one polygon per segment and is not sampled like the real line, so above 2,000 points in all the lines together (`LINE_WIDTH_MAX_POINTS`) the markers carry Size instead and a hint says so. A **stepped / jump line** and an **area** keep the marker size of D100 (a segment polygon would misdraw a step and an area has no line of its own); the stepped line says Straight brings thickness back. **Existing sheets with a Size on a straight line now draw thickness instead of marker size** (no stored data changes).
- **Size beside a Colour split** is drawn on bar, line and area (the old hint is only for Stacked, whose segments of one bar cannot take a thickness). Each (category, member) cell has its own value on one scale across the members. Grouped bars are custom series that offset themselves inside the band (`custom` series get no ECharts bar layout); a split bar's bars are therefore narrower, as grouped bars are.
- **Size on Text / Table is the font size in three steps of the type scale** — body 14, lead 16, title 24 px, by thirds of the share — because design rule 5 allows few font sizes and a continuous size would add many. Applied to value cells only (not totals or a collapsed header's combined cell). The Size measure is fetched with the table but is not a column, on screen or in the CSV export (the export drops it, so the file matches the screen; a Text's other Marks measures are left as they were). A paged table shapes its steps over the pages loaded so far.
- **Size on pie / donut stays a hint.** A pie is one mark here (one slice dimension × one measure), so a Size has nothing to compare against; Tableau's meaning (a pie per member of a Rows / Columns dimension, each sized by the measure) needs a panelled pie, which stays in the backlog. The hint now says why.
- **Members of mixed kinds** (numbers and text in one field) sort by locale for every pair, so the order is transitive; numbers sort by value only when every member is a number.
- **Edit Sizes is offered only while the chart draws the Size it holds** (not for a dimension on Text / Table, nor a two-measure bar).
- **Saved sheets draw differently, their data does not change.** A sheet that already had Size set now draws more than before: Size beside a Colour split on bar / line / area (a hint before), a straight line's thickness (marker size before), Size on a Table (ignored and not queried before; now queried and sizing the text) and Size on Text (the Size measure used to show as an extra value column; now removed, sizing the text, and the status line counts one measure fewer; its CSV export drops that column too).
- **Rejected:** replacing the line series with the segment series (loses the tooltip, selection, markers and gradient); free pixel ranges (three units for five marks); sizing the table's text continuously.

## D109 — A colour measure beside several measures, on Stacked and on Combo

- **Every mark of every measure wears its row's colour value** (a bar, a stacked segment, a line marker and stretch, a combo's bars and lines). One gradient legend names the colour measure; the old hint ("with several, the marks of different measures would look alike") goes. Pie, donut, treemap and the point charts were already allowed with one measure on the shelf.
- **Colour no longer names the measure, so another cue does** (golden rule 9): `measureCue(i, markerShape)` gives measure *i* a dash (5 styles) and a marker (4 shapes, from the chosen Marker shape) for lines, and a pattern (none, then 4 surface-coloured decals) for bars; dash and marker cycle at different lengths, so all ten measures a view may hold differ. The first measure stays plain. The cue appears only while a colour measure sits on several measures, so every other drawing is as before. The legend swatch is neutral (`--chart-muted`) with the pattern or marker icon, because no mark wears a series hue any more.
- **Stacked segments of one bar share a colour,** so a 1 px surface stroke separates them unless Border thickness is set. **Rejected:** colouring by measure and ignoring the colour measure (loses what the user asked for); small multiples per measure (Tableau's panes, a different chart); keeping the hint (the work the item asked for).
- **Limits.** Past five measures the dash / bar pattern repeats (the marker differs), so identity then rests on the legend and tooltip names too. (A mark at the exact diverging centre is kept visible by D110's neutral centre.) A comparison period keeps its muted, hatched look.

## D110 — The colour scale starts Automatic (Diverging when the data crosses zero), and Use full colour range

- **Automatic is a third value of `format.colorScale`,** written only on a worksheet the user adds or clears (`freshSheet`, used by New worksheet and Clear sheet); `defaultFormat()` and every file keep `sequential`, so a saved workbook cannot read as Automatic (a file that stored Low → high, or nothing, opens as before). It resolves once per drawing, from the values the scale reads, before any colour is computed (`effectiveScale`; Diverging iff the minimum is below zero and the maximum above it), so nothing downstream sees "auto". Heatmap and the colour-measure types all follow.
- **The Format panel shows the controls of the resolved scale** (centre and hues for Diverging, ramp and pins for Low → high): the drawing reports it through a hook (`onColourScale`) and a change refreshes the panel while Format is open. Until a first drawing it assumes Low → high.
- **Use full colour range** (`format.colorFullRange`, optional, off by default): **off is today's symmetric scale** (the larger side sets both ends, so the smaller side stops short of its end colour); **on gives each side its own span** (the minimum wears the low colour, the maximum the high colour, the centre colour stays on the centre) through a resampled 41-stop ramp (a continuous visualMap spaces stops evenly). Tableau's default is the reverse (checked); ours is off so existing sheets, whose symmetric drawing the setting must not change, stay as they were. A centre outside the data has one side only and stays symmetric. **Stepped scales ignore it** (the checkbox is hidden): steps already wear both end colours, and an asymmetric split would put a step of the wrong hue across the centre (a positive value in an orange step).
- **A visible neutral centre for Automatic.** A smooth Diverging ramp's centre is the surface, so a mark at the centre (value 0) drew in the page colour and read as missing; on a scale that came from Automatic the centre (the legend's middle stop, the full-range ramp's input, every mark) is the surface nudged 15 % toward the ink, as a stepped scale's middle step already is. An explicit Diverging keeps the surface, so saved and explicitly chosen sheets draw as before.
- **Use full colour range on stepped scales is deliberately not offered** (the rationale above), not a gap.
- **Not changed:** a table's conditional-formatting scale keeps its own Orange / Blue pair; a saved Diverging sheet is untouched.

## D111 — Mark opacity multiplies the opacity a mark already has

- **`format.markOpacity`** (whole percent, multiples of 10, 0–100; absent = 100) is kept off `defaultFormat`, removed at 100, and an invalid saved value is reset and reported (never clamped). It is offered on the chart types that draw coloured marks (the types that take a border, plus line, area and small multiples).
- **It multiplies, never replaces,** because marks already carry opacity that means something: a scatter's 0.8, an area fill's 0.18, a comparison series' hatch, and the dashboard's dim for the unselected marks. The pass runs after the selection dim, so a selected mark stays above a dimmed one at any setting. Trend lines, reference lines, bands, labels, axes, legends and the Gantt's length label stay at full strength: opacity never carries meaning and never hides the answer.
- **Where a series style cannot reach:** a Gantt rectangle and the Size line-thickness polygons set their own style, so the builders multiply it; a straight thickness line hides its 2 px stroke below 100 % (the overlay is the line) instead of stacking into a darker core; a treemap tile takes no `itemStyle.opacity`, so its colour is drawn with alpha and its (and a heatmap cell's) label ink is picked against the tile as it shows.
- **0 % is allowed** (Tableau's range): the marks vanish, the axes, legend and tooltips remain. The pass runs only for the types whose Format offers the control (`OPACITY_TYPES`), so a stale setting on a Gauge is ignored; a Waterfall's custom rectangles multiply it themselves.

## D112 — Several fields on Colour: combined members

- **Up to three categorical fields** (`LIMITS.colourFields`, client-side; each is a group-by of the 12) on bar, stacked, line, area, pie, donut and the scatter family; a measure replaces them all, a field replaces a measure, a repeat or a fourth is refused. A Gantt and a Table use the first and say so. The same field already on Shape is grouped once only when it is the one Colour field (as before); with several, each stays a key.
- **A mark's colour is its combination** ("web · DE"): one series, legend entry and member colour per combination, in first-seen order. The legend **highlights** a combination and selects nothing (a combination has no single field to keep or exclude), as a Colour + Shape pair already did.
- **Storage keys are unambiguous.** A combined member is keyed by a JSON array of its raw members, and its field by a JSON array of the fields' keys in order, because a member name may itself contain " · ". Calculated fields get no member colours (as before). The 100-character member key limit applies to the encoding, so very long names cannot be recoloured (the message says so).
- **Import** keeps the categorical fields up to three (a leading measure keeps only itself), drops repeats and mixed measures, and reports what it dropped. A saved sheet with one Colour field is unchanged. The query cap counts every Colour field.
- **Rejected:** a nested legend per field (ECharts has no grouped legend); more than three fields (a legend of the product explodes: three fields of 8, 3 and 2 members is 48 entries); colouring by the first field and splitting by the rest (that is Detail).

## D113 — A Colour field on Pie / Donut splits each slice by member

- **Chosen:** the slice field stays the Columns / Rows dimension; the Colour field is one more group-by, so a slice becomes one **sub-slice per member**, grouped under their slice in the server's order, each member with **one colour across every slice**, the legend listing the members (a click selects the member for one field, highlights for several), a sub-slice named "slice · member" in its label and tooltip, and a click selecting its slice. `pie` and `donut` join `COLOR_USES`, so **a saved pie that already carried a Colour dimension now draws the split** (before it ignored the field; its data does not change).
- **A Colour field equal to the slice field adds nothing** (grouped once; the pie colours by slice as before); on a shelf it is the slice.
- **The Top N cap counts (slice, member) groups** (Format says "Top N (sub-slices)" on a split pie), and the "Other" bucket (which needs one group-by) is not offered while a Colour field is set; a truncated result says so as everywhere.
- **Rejected:** two rings (an inner pie of the slice totals, an outer ring of the members): clearer about the slice but needs two series, two legends and names that collide when a slice and a member share a name; and Tableau's one-pie-per-member panels (the same panelled pie as Size on a pie, still in the backlog). Limit: the slice a sub-slice belongs to is named in the label and tooltip, not drawn as a ring, so with many slices it reads best with Data labels on.

## D114 — A measure on Shape is binned into at most six symbols, plus one for a missing value

- **Chosen:** Shape takes a measure as well as a dimension (scatter family only, as [D100](#d100--shape-stays-on-the-scatter-family-size-on-a-line-is-the-marker-size)). A measure is **not a group-by**: it is the plan's last measure (role `shape`, after the aux measures so no index moves) and its values are cut into **equal-width bins** over every point (`format.shapeBins`, 2 to 6, default 5). Each bin is one series, **the bin number is the symbol**, and the legend names the ranges in words ("10 to 20"). A value on a boundary belongs to the bin above, the largest value to the last bin, flat data is one bin, and a missing value is its own "No value" group on the seventh symbol.
- **Why six, not seven:** the symbol set has seven entries; giving every bin one and a missing value the last means no two groups ever share a symbol (shape is the non-colour channel, golden rule 9). **Why equal-width, not quantile:** the legend can say what a bin means in the measure's own units; quantile bins need a data-dependent cut the legend would have to explain. Tableau has no Shape measure, so the default of 5 is a choice (about the number of shapes a reader can tell apart at a glance).
- **A legend click only highlights** (a bin is not a member to filter on) and the tooltip says the exact value. Cuts follow the drawn result (Top N, filters); they are not stored.
- **Rejected:** hashing every distinct value to a symbol (up to 5,000 groups, symbols repeat); quantile bins; a bin count above 6 with repeated symbols.

## D115 — Edit member shapes: a per-member symbol, stored like member colours

- **Chosen:** `sheet.memberShapes` = `{ [table.column]: { [member]: shapeKey } }`, the same shape, limits (100 members, 20 fields, key lengths) and prototype-free maps as `memberColors`, with the seven shape keys as the only values. The key exists only once a member has a shape; an invalid saved entry is dropped and reported on import. The editor is a Format control like Edit member colours (which now lives in the Color flyout, [D151](decisions-marks.md#d151--the-color-tile-opens-the-colour-controls-format-keeps-the-rest)) (swatch buttons are drawn symbols with a title and `aria-label`, never colour alone); it lists the members the chart drew and shows each member's current symbol.
- **It applies to a Shape dimension only** (a binned measure has bins, not members) and keys on the Shape member's displayed name, so it works in a "colour · shape" pair and when Colour and Shape are one field. Two members may share a symbol: the choice is the user's, and the legend still names each.
- **Rejected:** storing ECharts symbol names (couples the file to the library); a symbol picker per bin (bins are ranges whose symbol is their position).

## D116 — Label marks: a mask over the marks, offered only where it does something

- **Chosen:** Label flyout → Label marks (`format.labelMarks`: absent = All, else `minmax`, `selected`, `highlighted`, `recent`, `ends`) is a pure mask (`labelMask`) over each series' marks, applied in the builders by blanking the label text (or, on a pie, hiding the slice's label and leader line). The control is shown only while labels are drawn and only with the modes that mean something: Line ends on Line and Area, Most recent when the first group-by is a point in time. A stored mode the chart cannot offer **draws every label** and says so (never none), and is kept so it returns with a line chart. Defaults draw exactly as before.
- **Tableau's "Marks to label" mapped:** All, Min / Max (per series, ties take the first, missing values and the Other mark never count), Selected (the dashboard's selection or the worksheet's own click selection; none selected = no label plus a hint), Highlighted (ECharts' emphasis state: hover, or a legend item's highlight shows the whole series; one mark's label on hover uses `focus: "self"`), Most recent (the latest ISO date of the first group-by, read before date parts become labels), Line ends (first and last real point of a line).
- **A long line (past 60 points) has no dots, and an ECharts label sits on its mark's dot:** with a mask on (not Highlighted) the labelled marks get a dot (`showAllSymbol`, the rest `symbolSize` 0), so Line ends / Min & max / Most recent draw where they matter most (the unlabelled marks keep their normal size but are clear, so the hover dot and tooltip behave as on a plain long line). All-marks labels on such a line still draw nothing (backlog).
- **Label position (above / below / left / right) is built for the marks that sit on a point over the plot background:** Line, Area and the point charts (`format.labelPosition`, absent = Automatic, validated like `labelMarks`; `labelPositionsFor`). Ink on the surface has no contrast question there. Bars, stacked segments, combo bars and pie slices keep their own place and the control is hidden. **Not built:** the "inside" positions, which would put ink text on palette colours with no contrast rule.
- **Not offered:** Heatmap, Treemap and the other chart types (their labels follow their own rules, [D102](#d102--heatmap-labels-draw-themselves-when-they-fit-a-stack-of-very-different-scales-is-flagged)).

## D117 — Labels on a point chart split by Shape or Colour: one label per mark, the mask taken across the members

- **Chosen:** a point chart split by a Shape or Colour dimension (or a binned Shape measure) is one scatter series per member; it now draws **Data labels** and a **Label field** like any other point chart, and Label flyout → Label marks and Label position are offered there (the controls of [D116](#d116--label-marks-a-mask-over-the-marks-offered-only-where-it-does-something)). The modes that mean something there are All, Min & max, Selected and Highlighted (no Line ends; Most recent when the first group-by is a date).
- **Min & max is per member** (the lowest and highest Y of each series, as on the Colour split of a bar or line); Selected and Most recent name **result rows**, not an index inside a series, so each point carries its `row` (`scatterGroups`) and `labelMask` takes a `keyOf(series, mark)`; a Label field's text is read per row. A mark with no name of its own (Colour or Shape is the only dimension) is labelled with its member, never blank.
- **Highlighted uses `focus: "self"`** (only then) so one hovered mark shows one label; otherwise the member series keeps `focus: "series"`. With Data labels off and no Label field the series is exactly what it was (no `label` key).
- **A split point chart stays inert unless Label marks is Selected** (and labels are drawn): only then does a click on a mark of a split **Scatter** select its primary-dimension value (editor and dashboard widget alike), so Selected can be chosen without every existing split chart becoming a cross-filter source. With any other mode, no labels drawn, or on Square / Circle (`CLICK_TYPES` has Scatter only) there is no click handler, as before; with no primary dimension on Rows / Columns nothing can be selected and the hint says so. A Label field that is a dimension outside the query gets the unsplit chart's hint.
- **No new cap:** the 5,000-group query cap already bounds the marks (canvas past the usual mark count); labels are text per mark, and Min & max / Selected / Highlighted draw few.
