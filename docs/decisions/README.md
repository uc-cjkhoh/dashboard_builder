---
components: []
---
# Decisions & rationale

The "why" record: each architecture or design decision, its reason, and what was rejected. When a
decision changes, **edit its entry in place** (and the doc it affects) in the same change. To resolve an
open question, promote it to a decision.

## Where each decision lives

| Decisions | File |
|---|---|
| D1–D25, D88, D90 (worksheet background shade; the box plot is a worksheet-shaped request) | this file |
| D105 (Edit SQL: a free-text `SELECT` on a Data Source card, the one exception to rules 2 and 3), D106 (MySQL syntax in Edit SQL, translated to ClickHouse) | [decisions-custom-sql.md](decisions-custom-sql.md) |
| D26–D60, D65–D68, D73 (calculated fields, parameters, member labels, groups, split / unpivot) | [decisions-calculated-fields.md](decisions-calculated-fields.md) |
| D61–D64, D69, D71–D72, D74, D79–D81, D85–D86, D92, D96 (a number that looks like an identifier starts as a dimension), D97, D100, D102, D103, D104, D108 (dashboards, hierarchies, option controls, desktop-only, compound join keys, Gantt, stories, diverging hue pair, no red in the categorical palette, Shape on the scatter family only and Size as the line marker size, heatmap cell labels and the stacked-scale notice, trend p-value / polynomial orders / refusal on a cut-off result, Gantt end field / colour split / click-to-filter, Size from a dimension / Edit Sizes / a line's own thickness / Text size / Size beside a Colour split) | [decisions-dashboards.md](decisions-dashboards.md) |
| D109–D113 (a colour measure beside several measures, on Stacked and on Combo; the Automatic colour scale and Use full colour range; mark opacity; several fields on Colour; a Colour field on Pie / Donut) | [decisions-dashboards.md](decisions-dashboards.md) |
| D114–D117 (a measure on Shape, binned; Edit member shapes; Label marks; labels on a point chart split by Shape or Colour) | [decisions-dashboards.md](decisions-dashboards.md) |
| D118 (the Marks card follows Tableau except where the app has no uploads, no maps or no contrast rule yet), D119 (Line pattern and Line markers), D120 (Edit Sizes: Sizes vary and a typed start and end value), D121 (tooltip behaviour: Show tooltips, command buttons, Responsive or On hover), D122 (Include totals in the colour encoding), D123 (Gantt bar size from Size) | [decisions-marks.md](decisions-marks.md) |
| D70 (recent connection sources), D89 (start screen: recent workbooks — withdrawn), D98 (Secure and Trust as visible switches; the certificate note waits), D99 (the connect form lives on the start card) | [decisions-connection.md](decisions-connection.md) |
| D82 (calculated fields as row filters), D84, D87 (a filter on an aggregated measure, `HAVING`; its range slider), D91 (a calculated filter on a single-table read), D95 (View data reads the first measure's table) | [decisions-filters.md](decisions-filters.md) |
| D83 (groups on whole-number and true/false fields), D94 (a NULL label on a group field) | [decisions-calculated-fields.md](decisions-calculated-fields.md) |
| D75–D77 (`NULL`, `IN` / `BETWEEN`, keyword `IF`), D78 (`MAKEDATE`, `DATENAME`), D93 (`FISCALYEAR`, `FISCALQUARTER`), D101 (date literal `#2024-01-31#`, `IN` over dates, boolean `=`), D107 (regular expressions) | [decisions-logic.md](decisions-logic.md) |

## Open questions

| # | Question | Leaning |
|---|---|---|
| **O1** | Should workbooks persist on the server (shared across browsers/users)? | Browser persistence is decided ([D21](decisions-platform.md#d21--workbooks-persist-in-the-browser-not-on-the-server)). Server-side storage only with accounts — see [platform.md](../development/backlog/platform.md). |
| **O2** | Where are multiple saved connections stored? | One active connection per session, not saved. Later: named profiles **without** persisting passwords server-side. |
| **O3** | How far does dashboard composition go? | Worksheets and dashboards are separate tab kinds and a dashboard's data is built ([D61](decisions-dashboards.md)); the board canvas and its editing are built ([D62](decisions-dashboards.md), [D63](decisions-dashboards.md)); composition would revisit O1 only if dashboards were shared. |
