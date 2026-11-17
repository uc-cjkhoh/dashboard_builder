---
components: [src/DashboardBuilder/Features/Core/ui.js, src/DashboardBuilder/Features/Canvas/canvas.js, src/DashboardBuilder/Features/Relations/relations.js, src/DashboardBuilder/Features/Tabs/tabs.js, src/DashboardBuilder/Features/Board/board.js, src/DashboardBuilder/Features/Story/story.js, src/DashboardBuilder/Features/Workbook/workbook.js, src/DashboardBuilder/Features/Workbook/parameters-dialog.js, src/DashboardBuilder/Features/Calc/calc-dialog.js, src/DashboardBuilder/Features/Dashboard/dashboards.js, src/DashboardBuilder/Features/Dashboard/hierarchy-dialog.js, src/DashboardBuilder/Features/Canvas/sql-dialog.js, tests/js/confirm-delete.test.mjs]
---
# Decisions — destructive actions

Behaviour: [canvas.md](../concepts/data-source/canvas.md), [relationships.md](../concepts/data-source/relationships.md), [tabs.md](../concepts/workbook/tabs.md),
[dashboards.md](../concepts/workbook/dashboards.md), [stories.md](../concepts/workbook/stories.md), [workbook.md](../concepts/workbook/workbook.md).
UI pattern: [components.md](../reference/design/components.md). Rule: [coding-standards.md § 13](../development/coding-standards.md#13-destructive-deletes-ask-twice-there-is-no-undo).
Edit an entry in place when it changes.

### D133 — No Undo; double confirmation before every destructive delete
**Chosen:** the app has no Undo or Redo anywhere. Every destructive delete asks twice through `confirmDeleteTwice(message, what, { confirmText = "Delete" })` in `Core/ui.js`:
the existing danger `confirmDialog(message)`, then, only if confirmed, a second danger dialog "Really <confirmText lowercased> <what>? This can't be undone." with the button
"<confirmText> for good". It resolves `true` only when both are confirmed; Cancel or Esc on either aborts.
- **Why:** the user chose explicit, safer confirmation over undo. An undo layer meant three separate history mechanisms (worksheet snapshots, the board's widget list,
  the close-tab restore plan), toasts with a 10-second action, and a `rel:reinstate` bus path to rebuild a removed card's links. A second "this can't be undone" dialog
  states the cost before the act and leaves nothing to restore.
- **Removed with it:** toast action buttons (`toast()` takes no `action`; `.toast__action` is gone), the close-tab undo bar (`Tabs/close-undo.js`, `.tab-undo`),
  worksheet history (`Dashboard/history.js`, the toolbar Undo / Redo, `.ws-undo`, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y), the board's history (`Board/board-history.js`, its buttons and shortcuts,
  the `rel:reinstate` and `workbook:reset` bus events; a board `commit()` is just `updateSheet`), and the `undo` / `redo` icons. Their node tests were deleted; `tests/js/confirm-delete.test.mjs` covers the new helper.
- **Where it is used** (button label in brackets):
  - remove a table card ("Remove"; **always** asks, even with no relationships);
  - delete a relationship from the cardinality dialog ("Remove");
  - close a tab that holds content or is used elsewhere ("Close"; an empty tab still closes with no prompt);
  - remove a dashboard widget, the X ("Remove"; was one click with Undo);
  - remove a story step ("Remove"; was one click);
  - delete a calculated field (**always** asks, even when unused; names its users), a hierarchy, a parameter (always asks now);
  - **Clear sheet** ("Clear");
  - discard unsaved edits in the Edit SQL dialog and the calculated-field dialog ("Discard");
  - replace the workbook on import ("Replace").
- **Not double-confirmed, by design:** removing a shelf pill, a filter chip or a mark (a pill is a view setting, not stored data); removing a key pair or a group inside an open dialog
  (a draft until saved); removing a recent connection; **Disconnect** (one confirm: it is not a delete).
- **Unchanged:** Ctrl+Z / Ctrl+Y inside the Edit SQL and calculated-field text boxes is the editor's own typing undo ([sql-editor.md](../concepts/data-source/sql-editor.md)).
- **Rejected:** an Undo toast or history of any kind, kept beside the confirm; double-confirming draft edits inside dialogs (nothing is lost until Save).
- **Supersedes:** the Undo parts of [D63](decisions-dashboards.md#d63--board-edits-are-refused-never-repaired-every-verdict-is-pure) (board history),
  [D127](decisions-relationships.md#d127--a-table-pair-holds-one-relationship-related-in-few-steps) (the key-pair toast's Undo), and the undo remarks in D68 and D69.
