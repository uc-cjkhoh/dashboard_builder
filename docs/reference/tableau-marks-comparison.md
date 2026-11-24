---
components: [src/DashboardBuilder/Features/Dashboard/mark-channel-model.js, src/DashboardBuilder/Features/Dashboard/size-scale-model.js, src/DashboardBuilder/Features/Dashboard/colour-scale-model.js, src/DashboardBuilder/Features/Dashboard/label-marks-model.js, src/DashboardBuilder/Features/Dashboard/toolbar-rules.js, src/DashboardBuilder/Features/Dashboard/tooltip-behaviour-model.js, src/DashboardBuilder/Features/Dashboard/tooltip-model.js]
---
# Marks card compared with Tableau

Where the Marks card matches Tableau's and where it does not. Source: Tableau Desktop help, read 2026-11-13: [Control the Appearance of Marks in the View](https://help.tableau.com/current/pro/desktop/en-us/viewparts_marks_markproperties.htm) and its [Color Palettes and Effects](https://help.tableau.com/current/pro/desktop/en-us/viewparts_marks_markproperties_color.htm) sub-page. Tableau's Labels page returned 404 and was not read: the Label rows use the earlier comparison behind [D116](../decisions/decisions-dashboards.md#d116--label-marks-a-mask-over-the-marks-offered-only-where-it-does-something). Our behaviour: [worksheet-marks.md](../concepts/worksheet/worksheet-marks.md), [worksheet-marks-colour.md](../concepts/worksheet/worksheet-marks-colour.md), [worksheet-marks-shape-label.md](../concepts/worksheet/worksheet-marks-shape-label.md). Work still to do is in [backlog/charts-and-formatting.md](../development/backlog/charts-and-formatting.md); deliberate differences are [D118](../decisions/decisions-marks.md#d118--the-marks-card-follows-tableau-except-where-the-app-has-no-uploads-no-maps-or-no-contrast-rule-yet).

Not a Tableau clone ([index.md](../development/backlog/index.md#guards-every-item-must-keep)): the aim is the same job done, not the same dialogs.

## Matches

| Tableau | Here |
|---|---|
| Colour: a discrete field colours per member; a continuous field colours by value | Colour dimension (up to 3 fields, "a · b" members) or one measure; gradient or steps |
| Edit Colors: Stepped Color, Reversed, Use Full Color Range, Advanced Start / End / Center | Color flyout: Steps (3 to 9), Reverse palette, Use full colour range, Colour from / to pins and centre value (under Limits); Automatic starts Diverging when the data crosses zero ([D110](../decisions/decisions-dashboards.md#d110--the-colour-scale-starts-automatic-diverging-when-the-data-crosses-zero-and-use-full-colour-range)) |
| Color effects: Opacity, Border thickness | Color flyout: Opacity (0 to 100, steps of 10), Border thickness (none / thin / medium / thick, colour from four tokens), Line markers ([D151](../decisions/decisions-marks.md#d151--the-color-tile-opens-the-colour-controls-format-keeps-the-rest)) |
| Edit Colors: Include totals (totals, subtotals and grand totals are coloured and count toward the range) | Table / Text: Format → Conditional formatting → Include totals, per measure; the scale, bars and rules colour the total cells and the totals widen the range; the key says "Totals included" ([D122](../decisions/decisions-marks.md#d122--include-totals-in-the-colour-encoding)) |
| Edit Colors: pick a colour for one member | Edit member colours in the Color flyout (24 fixed swatches) |
| Size: a discrete field gives each member a size; a continuous field a range; legend shows it | Size dimension (steps) or measure; a Size legend line names the range |
| Edit Sizes: Sizes vary (Automatically, By range, From zero), range slider, Reversed (not under From zero), Start / End value in the legend | Format → Edit Sizes: Sizes vary (Automatic, By range, From zero), smallest / largest %, typed Start / End value (a value beyond saturates), Reversed (off under From zero); Automatic keeps each chart's own default, not Tableau's data-driven rule ([D120](../decisions/decisions-marks.md#d120--edit-sizes-sizes-vary-and-a-typed-start-and-end-value)) |
| Size by mark type: bars thicker, lines thicker, text bigger; a Gantt bar wider or narrower | Bar thickness, Gantt bar thickness (a Size measure; the bar's length stays the second measure or Format → Length, [D123](../decisions/decisions-marks.md#d123--gantt-bar-size-from-size-a-measure-sets-each-bars-thickness)), a line's own thickness, Text / Table font size (three steps) |
| Label: a dimension labels by member, a measure by value; marks to label (All, Min / Max, Selected, Highlighted, Most recent, Line ends) | Label slot; Format → Label marks, same modes, plus Label position above / below / left / right ([D116](../decisions/decisions-dashboards.md#d116--label-marks-a-mask-over-the-marks-offered-only-where-it-does-something), [D117](../decisions/decisions-dashboards.md#d117--labels-on-a-point-chart-split-by-shape-or-colour-one-label-per-mark-the-mask-taken-across-the-members)) |
| Detail: separate marks by a dimension's members | Detail slot, extra group-by |
| Shape: a dimension gets a shape per member, a legend; a measure becomes discrete | Shape dimension; a measure is binned into at most six symbols plus one for missing ([D114](../decisions/decisions-dashboards.md#d114--a-measure-on-shape-is-binned-into-at-most-six-symbols-plus-one-for-a-missing-value)); Edit member shapes |
| Path: orders Line vertices; line type Linear / Step / Jump | Path slot orders line and area vertices; Format → Line style: straight, step, jump |
| Line markers: Selected, All or None; Line pattern: Solid, dashed or dotted (solid with a continuous Size) | Color flyout → Line markers (Automatic, Selected, All, None; a lone value and a Size-sized or cued marker always stay) and Line pattern (Solid, Dashed, Dotted; solid under a Size thickness, a measure cue keeps its own dash) ([D119](../decisions/decisions-marks.md#d119--line-pattern-and-line-markers-on-the-marks-card), [D124](../decisions/decisions-marks.md#d124--line-markers-selected-dots-only-at-the-click-selected-marks)) |
| Tooltip: field on Tooltip, Edit Tooltip text with inserted fields and formatting | Tooltip slot; Edit tooltip… with `<field>` placeholders, per-line size / bold / italic / colour, per-field number and date formats |
| Tooltip behaviour: Show Tooltips; Responsive or On Hover; command buttons Keep Only, Exclude, View Data | Format → Show tooltips, Command buttons (Keep only, Exclude, View data on selecting charts in the editor) and Tooltip mode (Responsive: a click pins the tooltip; On hover) ([D121](../decisions/decisions-marks.md#d121--tooltip-behaviour-show-tooltips-command-buttons-and-responsive-or-on-hover)) |
| Mark-type defaults and the Size slider per type | The chart-type table in [worksheet-marks.md](../concepts/worksheet/worksheet-marks.md#colour-size-and-shape-by-chart-type-t03-19-t03-20-t03-21-t01-21); an unmet mapping is a hint, never an error |

## Differences and gaps

| Area | Tableau | Here | Status |
|---|---|---|---|
| Size on a pie | Size sets the pie's overall size; a pie per member of a Rows / Columns dimension | A hint: one pie has nothing to compare | Backlog: panelled pie |
| Bar width on a continuous axis | Size card → Fixed: width in axis units or days | Not available; bars sit on a category axis | Backlog, with the continuous time axis |
| Colour palettes | A palette drop-down (categorical and ordinal), Assign Palette, Reset; a custom hex colour on the web | One fixed set of eight colours and 24 swatches; two diverging hue pairs | Backlog: needs a stored-colour contrast rule |
| Tooltip: Group Members, Create Set, Allow selection by category, a view in the tooltip | Command buttons Group Members and Create Set; select a field's members by clicking them in the tooltip; a view in the tooltip | Not built: no sets, no member-list step; a view in a tooltip is P38 | Backlog |
| Mark halos | A halo colour over a background image or a map | Not available (no maps or background images) | Waits on maps |
| Polygon mark | A Polygon type with Path | No Polygon chart type | Waits on maps |
| Custom shapes | Image files as a shape palette; shapes shared by every sheet of a data source; a default shape per field | Seven built-in symbols; per-sheet member shapes | Deliberate: no uploads ([D118](../decisions/decisions-marks.md#d118--the-marks-card-follows-tableau-except-where-the-app-has-no-uploads-no-maps-or-no-contrast-rule-yet)) |
| Angle | Not on the Marks-card help page | A slot that acknowledges the pie angle and hints elsewhere | None |

## Reading the table

- **Backlog** means an entry exists in the backlog file; **Waits on maps** means it depends on the maps item in [analytics-and-maps.md](../development/backlog/analytics-and-maps.md); **Deliberate** means a decision, not a gap.
- Our extras with no Tableau counterpart on these pages: Label position, Line ends on area, per-line tooltip styling, the Automatic colour scale and a Shape measure binned into symbols.
