---
components: []
---
# Backlog: data source hardening and UX

Security, robustness and UX gaps in the Data Source (connection, schema browser, canvas, relationships, Edit SQL, union / unpivot),
from a principal-engineer review on 2026-11-17 (UI driven in headless Chromium with a mocked `/api`; server and frontend code read).
Format: [index.md](index.md#how-to-read-an-entry). File paths are under `src/DashboardBuilder/`.

## Must fix

- **Edit SQL guard: quoted names and escapes** (priority P0; effort S) — Partial: fix on branch `fix/data-source-guards`, awaiting review. Open on `main`: `CustomSql.CheckFunctions` checks only unquoted words, so ``FROM `url`(…)`` or `"s3"(…)` passes; `EndOfQuoted` ignores backslash escapes inside backticks while `Identifier.Quote` relies on them, so `SETTINGS` or `;` can hide in what the guard reads as a name; `FORMAT` and `INTO OUTFILE` are not refused. Needs: none. Spec: [api-custom-sql.md](../../reference/api-custom-sql.md).
- **Connect host: internal-network probing** (priority P0; effort S) — Partial: fix on branch `fix/data-source-guards`, awaiting review. Open on `main`: the host field accepts any address (loopback, link-local, private), and the distinct connect-failure messages tell an unauthenticated visitor which host:port pairs answer. Needs: the operator's list of ClickHouse hosts for the live service. Spec: [connection.md](../../concepts/data-source/connection.md).
- **Query guards never drop `readonly=2` on a writable account** (priority P0; effort S) — Partial: fix on branch `fix/data-source-guards`, awaiting review. Open on `main`: a second settings refusal (code 452) steps the guards down to none, which sends no `readonly=2`, no time limit and no cancel-on-close. Needs: none. Spec: [clickhouse-integration.md](../../reference/clickhouse-integration.md#step-down-when-the-server-refuses-a-setting).
- **Change connection keeps the old server's model and saves it over the new server's workbook** (priority P0; effort S) — Partial: fix on branch `fix/data-source-guards`, awaiting review. Open on `main`: `workbook.js` `onConnection` switches the storage key but keeps a non-empty model, so the next autosave overwrites the other server's stored workbook. Needs: none. Spec: [workbook.md](../../concepts/workbook/workbook.md#restore-on-connect).

## Should fix

- **Canvas overview: fit, zoom controls, keyboard pan and zoom** (priority P1; effort M) — Open: cards added with + fill the grid downward and each add pans to the newest, so earlier cards end up off screen (5 tables at 1400×900 left 3 above the view); there is no Fit, no visible zoom control or zoom readout, and no keyboard pan or zoom. Fit after a workbook restore. Needs: none. Spec: [canvas.md](../../concepts/data-source/canvas.md).
- **Edit and remove a relationship from the keyboard** (priority P1; effort S) — Open: the link and its badge are click-only SVG and the Relationships card reacts to hover only; Enter then Enter on two related tables silently adds a key pair that only the (unreachable) dialog can remove. An Edit button on each Relationships-card row. Needs: none.
- **Latest-wins on the table list and the Unpivot dialog** (priority P1; effort S) — Open: `Schema/schema.js` `loadTables` and `loadDatabases` have no ticket, so a quick database switch can list (and + add) the previous database's tables; `Rows/unpivot-dialog.js` appends both responses on a quick table switch. Copy the union dialog's sequence guard. Needs: none.
- **Removing a card leaves a ghost link and a stale badge** (priority P2; effort S) — Open: `Canvas/canvas.js` emits `entity:removed` before deleting the card, so `relations.js` still counts it (dashed proposal and "Needs a partner" stay until the next move or zoom). Needs: none.
- **Edit SQL opens silently and can open twice** (priority P2; effort S) — Open: `Canvas/sql-dialog.js` runs up to six translate / validate / EXPLAIN calls before the dialog shows, with no busy state, no abort and no re-entry guard. Needs: none.
- **Edit SQL Reset to default can't be undone** (priority P2; effort S) — Open: `sql-editor.js` `setValue` clears history and Reset doesn't ask (rule 12). Use `replaceRange`, or confirm. Needs: none.
- **Server bounds and connection reuse** (priority P2; effort M) — Open: distinct values, latest day and join preview have no `max_rows_to_read` / `max_memory_usage` backstop (the profile has); a new `HttpClient` and handler per query (no pooling); the translator gate waits without a timeout and maps a python I/O failure to "Query failed against ClickHouse"; the session cookie has no `Secure` policy and no forwarded headers behind Apache; the translate error is an anonymous object outside `ApiError`. Needs: none.

## Polish

- **Connect defaults and form** (priority P3) — Open: Trust self-signed certificate is on by default (D11), so a TLS connection does not check the certificate; the password stays in the form's DOM after connecting.
- **Dialog and wording consistency** (priority P3) — Open: Relationship and Union dialogs have ✕, Unpivot and Edit SQL don't; "Add to model", "canvas" and "Data Source" name one thing; the foot hint ("Drag a column onto a column…") stays up over cards and the data preview.
- **Card move: keyboard and touch** (priority P3) — Open: no keyboard move for a card; a touch or pen drag has no `pointercancel` and the head no `touch-action: none`, so a cancelled drag can stick.
- **Card details** (priority P3) — Open: a card's database label is decided at render only (a later same-named table from another database doesn't add it to the earlier card); removing a card names the relationships it ends but not the worksheets that use it; the SQL editor's focus moves the cursor to line 1.
- **Module size and limit parity** (priority P3; effort M) — Open: `ClickHouse/ClickHouseGateway.cs` (≈1,800 lines, the open / command / reader loop repeated ≈15 times) and `Relations/relations.js` (≈870 lines) want splitting; no test checks `Core/validate.js` LIMITS against `RequestValidation.cs` (a stale comment says the server allows 16 filters; it is 20); per-drag `render()` redraws proposals and the notes card on every pointermove (suspected jank near 100 cards).
