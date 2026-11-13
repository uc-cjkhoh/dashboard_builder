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
