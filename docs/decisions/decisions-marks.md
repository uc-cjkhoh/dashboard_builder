---
components: [src/DashboardBuilder/Features/Dashboard/mark-channel-model.js]
---
# Decisions — the Marks card against Tableau

Lookup: [README.md](README.md). The comparison itself: [tableau-marks-comparison.md](../reference/tableau-marks-comparison.md). Edit an entry in place when it changes.

## D118 — The Marks card follows Tableau except where the app has no uploads, no maps or no contrast rule yet

- **Chosen:** the Marks card matches Tableau's Marks-card help (Color, Size, Label, Detail, Tooltip, Shape, Path) wherever the job can be done with the app's own parts. Where it cannot, it differs on purpose and says so in the interface (a hint, never an error). The differences are listed in [tableau-marks-comparison.md](../reference/tableau-marks-comparison.md); each one is either backlog work or one of the three reasons below.
- **No uploads → no custom shape palettes.** Tableau's Shape card loads image files from a repository folder. The app takes no file uploads and stores specifications only ([out-of-scope.md](../development/backlog/out-of-scope.md)), so Shape keeps seven built-in symbols and per-sheet member shapes (D115). A user-supplied image would also need the stored-colour contrast and size rules.
- **No maps → no halos and no Polygon.** Both exist in Tableau for map and background-image views; they come back with the maps item ([analytics-and-maps.md](../development/backlog/analytics-and-maps.md)).
- **No stored-colour contrast rule yet → no free palette editing.** Custom hex colours and an editable palette wait for a written contrast and saturation rule for stored colours (the palette entry in [charts-and-formatting.md](../development/backlog/charts-and-formatting.md)). Until then colour choices are tokens and 24 fixed swatches.
- **Not a Tableau clone:** where the same job is done differently, the app keeps its own control (Label position, Automatic colour scale, per-line tooltip styling). A feature is added to close a gap only when a backlog entry says so.
- **Rejected:** copying Tableau's dialogs one for one (it would add controls that do nothing on these chart types, against the gating rule of [D108–D117](decisions-dashboards.md)); treating the comparison as a to-do list (the backlog is the only to-do list).

## D119 — Line pattern and Line markers on the Marks card

- **Chosen:** Format → **Line pattern** (Solid, Dashed, Dotted) and Format → **Line markers** (Automatic, All, None) on Line, Area and Combo lines, in the Tableau Marks card's own words. Both are stored on `format` only when they differ from the default (`linePattern` `dashed` | `dotted`; `lineMarkers` `all` | `none`), so older workbooks open unchanged and a sheet that never set them draws byte for byte as before; an unknown saved value is dropped and reported, never clamped. One pure rule serves the drawing and the panel (`line-style-model.js`, `line-marker-model.js`), so a control is offered exactly where it does something and otherwise **disabled with its reason as the title**.
- **A dash that already means something keeps its meaning.**
  - A measure cue (a colour measure beside several measures) names its line: the cue wins and Line pattern is disabled with that reason. The cue's markers likewise win over None.
  - A comparison line stays dashed and faded; beside a Dashed or Dotted main line it takes a dash-dot, so the two differ without colour.
  - Reference lines and bands are analytics, never patterned. The trend line stays dotted, but beside a Dotted main line it takes the same dash-dot as a comparison line (it also has its end label), so the two differ by more than colour.
- **A straight line whose thickness follows Size stays solid, as in Tableau** (a dash cannot vary in thickness): the thickness is drawn as polygons (D108). The bound is 2,000 points in all the lines together; the drawing records the count it drew per sheet (`noteLinePoints`) and the panel reads it, so both apply the same `lineSizeMode`. Past the bound, and on a stepped line or an area, Size sizes the markers, so Line pattern applies there.
- **None never hides a value.**
  - A lone value (no neighbour on either side: a one-point line, a point between gaps) keeps its dot.
  - A mark that carries a label keeps a clear anchor: the dot is filled and bordered `transparent`, not given opacity 0, which a label sitting on it would inherit (seen in the browser check). Hover restores the dot's own fill and border, and the series' mark opacity still applies.
  - A marker that is data stays: Size on a stepped line, an area, or a straight line past 2,000 points (D108) and a measure's cue marker win over None, and Line markers is disabled with that reason. A sheet never drawn counts as within the bound.
  - The tooltip and the axis pointer are unchanged.
- **Marker size and Marker shape are not disabled under None:** a lone value and a hover dot still use them. The Line markers control's title says what None does to them.
- **All** pins every dot (`showAllSymbol`), because ECharts otherwise thins dense symbols, and a big canvas chart skips LTTB sampling for it (sampling would drop points and their markers; the 5,000-group cap bounds the cost). Automatic is untouched, including its own gap (a lone value past 60 points shows no dot).
- **Selected points (Tableau) is not built:** a line chart does have a selection (a click on a mark, or the dashboard's), but the chart is handed the selected marks only while Label marks is Selected (`labelMarksSpec`). Selected markers would need that selection passed through for Line markers on its own, on every cartesian render path; it stays in the backlog as that plumbing.
- **Rejected:** a custom polygon drawing for dashed thickness; patterning the cue lines (it would erase what names each measure); hiding the controls instead of disabling them (the user could not learn why); storing the defaults (every saved workbook would change).
