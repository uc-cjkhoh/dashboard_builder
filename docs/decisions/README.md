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
| D1–D25, D88, D90 (worksheet background shade; the box plot is a worksheet-shaped request) | [decisions-platform.md](decisions-platform.md) |
| D140 (the Data Source's next step leads: a card's ✕ rests muted, the key strip has no fill), D142 (the relationship dialog says in words what the link does; no Relationships card; D141 was withdrawn and is not reused), D145 (Edit SQL's code uses three hues; the verdict's colours stay the verdict's), D146 (one Appearance card replaces the mode menu and the theme dialog), D148 (the Appearance card has no System mode) | [decisions-design.md](decisions-design.md) |
| D139 (content-hash asset URLs cached for a year; shared ClickHouse HTTP clients), D143 (the column profile reads every row), D144 (Edit SQL opens at once and checks a fresh query at once) | [decisions-performance.md](decisions-performance.md) |
| D105 (Edit SQL: a free-text `SELECT` on a Data Source card, the one exception to rules 2 and 3), D106 (MySQL syntax in Edit SQL, translated to ClickHouse), D128 (saving Edit SQL shows the card's rows in the data preview), D130 (the data preview is a light grid with resizable columns), D131 (the data preview pages 100 rows at a time), D136 (quoted names are names; only listed table functions go where a table goes), D138 (union and unpivot are written in Edit SQL, not built in the sidebar) | [decisions-custom-sql.md](decisions-custom-sql.md) |
| D26–D60, D65–D68, D73 (calculated fields, parameters, member labels, groups, split / unpivot) | [decisions-calculated-fields.md](decisions-calculated-fields.md) |
| D61–D64, D69, D71–D72, D74, D79–D81, D85–D86, D92, D96 (a number that looks like an identifier starts as a dimension), D97, D100, D102, D103, D104, D108 (dashboards, hierarchies, option controls, desktop-only, compound join keys, Gantt, stories, diverging hue pair, no red in the categorical palette, Shape on the scatter family only and Size as the line marker size, heatmap cell labels and the stacked-scale notice, trend p-value / polynomial orders / refusal on a cut-off result, Gantt end field / colour split / click-to-filter, Size from a dimension / Edit Sizes / a line's own thickness / Text size / Size beside a Colour split) | [decisions-dashboards.md](decisions-dashboards.md) |
| D109–D113 (a colour measure beside several measures, on Stacked and on Combo; the Automatic colour scale and Use full colour range; mark opacity; several fields on Colour; a Colour field on Pie / Donut) | [decisions-dashboards.md](decisions-dashboards.md) |
| D114–D117 (a measure on Shape, binned; Edit member shapes; Label marks; labels on a point chart split by Shape or Colour) | [decisions-dashboards.md](decisions-dashboards.md) |
| D125 (the relationship dialog suggests a cardinality, with its evidence, as it opens), D126 (many links: a lane each, ordered to cross least; focus on hover; badges only on demand), D127 (a table pair holds one relationship; related in few steps), D129 (a card's actions sit in one ☰ menu), D132 (no Relate to another table item or table picker; Needs a partner is a label) | [decisions-relationships.md](decisions-relationships.md) |
| D118 (the Marks card follows Tableau except where the app has no uploads, no maps or no contrast rule yet), D119 (Line pattern and Line markers), D120 (Edit Sizes: Sizes vary and a typed start and end value), D121 (tooltip behaviour: Show tooltips, command buttons, Responsive or On hover), D122 (Include totals in the colour encoding), D123 (Gantt bar size from Size), D124 (Line markers Selected) | [decisions-marks.md](decisions-marks.md) |
| D134 (hover and pressed are brighter than rest in every scheme) | [decisions-buttons.md](decisions-buttons.md) |
| D133 (no Undo anywhere; every destructive delete asks twice through `confirmDeleteTwice`) | [decisions-destructive-actions.md](decisions-destructive-actions.md) |
| D70 (recent connection sources), D89 (start screen: recent workbooks — withdrawn), D98 (Secure and Trust as visible switches; the certificate note waits), D99 (the connect form lives on the start card), D135 (the connect form reaches only allowed hosts, rate-limited), D137 (a writable account never runs without `readonly=2`) | [decisions-connection.md](decisions-connection.md) |
| D82 (calculated fields as row filters), D84, D87 (a filter on an aggregated measure, `HAVING`; its range slider), D91 (a calculated filter on a single-table read), D95 (View data reads the first measure's table) | [decisions-filters.md](decisions-filters.md) |
| D83 (groups on whole-number and true/false fields), D94 (a NULL label on a group field) | [decisions-calculated-fields.md](decisions-calculated-fields.md) |
| D75–D77 (`NULL`, `IN` / `BETWEEN`, keyword `IF`), D78 (`MAKEDATE`, `DATENAME`), D93 (`FISCALYEAR`, `FISCALQUARTER`), D101 (date literal `#2024-01-31#`, `IN` over dates, boolean `=`), D107 (regular expressions) | [decisions-logic.md](decisions-logic.md) |

## Open questions

| # | Question | Leaning |
|---|---|---|
| **O1** | Should workbooks persist on the server (shared across browsers/users)? | Browser persistence is decided ([D21](decisions-platform.md#d21--workbooks-persist-in-the-browser-not-on-the-server)). Server-side storage only with accounts — see [platform.md](../development/backlog/platform.md). |
| **O2** | Where are multiple saved connections stored? | One active connection per session, not saved. Later: named profiles **without** persisting passwords server-side. |
| **O3** | How far does dashboard composition go? | Worksheets and dashboards are separate tab kinds and a dashboard's data is built ([D61](decisions-dashboards.md)); the board canvas and its editing are built ([D62](decisions-dashboards.md), [D63](decisions-dashboards.md)); composition would revisit O1 only if dashboards were shared. |
