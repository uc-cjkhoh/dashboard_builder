---
components: []
---
# Backlog: data source hardening and UX

Security, robustness and UX gaps in the Data Source (connection, schema browser, canvas, relationships, Edit SQL, union / unpivot),
from a principal-engineer review on 2026-11-17 (UI driven in headless Chromium with a mocked `/api`; server and frontend code read).
Format: [index.md](index.md#how-to-read-an-entry). File paths are under `src/DashboardBuilder/`.

## Must fix

The four must-fix items of the review are built: the Edit SQL guard ([D136](../../decisions/decisions-custom-sql.md#d136--edit-sql-quoted-names-are-names-and-only-listed-table-functions-go-where-a-table-goes)), the connect host policy ([D135](../../decisions/decisions-connection.md#d135--the-connect-form-reaches-only-allowed-hosts-and-not-too-often)), `readonly=2` kept on a writable account ([D137](../../decisions/decisions-connection.md#d137--a-writable-account-never-runs-without-readonly2)) and Change connection to another server ([workbook.md](../../concepts/workbook/workbook.md#restore-on-connect)).

- **Allowed ClickHouse hosts on the live service** (priority P0; effort S) — Open: `ClickHouse:AllowedHosts` is not set on `webapps-dev.dashboardbuilder`, so the live connect form may still reach any host (the app logs a warning). Needs: the operator's list of ClickHouse hosts, then a stop → copy → start ([live-service.md](../../operations/live-service.md)).

## Should fix

- **Canvas overview: ragged columns and placement** (priority P2; effort S) — Partial: Fit, zoom controls with a readout and keyboard pan and zoom are built ([canvas.md](../../concepts/data-source/canvas.md)), and a workbook fits on open. Still open: card widths follow the table name (312–480px), so the columns are ragged (364px beside 312px) — use a common column width or width-aware slots (`card-width.js`); and a card added with + still goes to the first free slot and then reveals itself, so earlier cards can end up off screen until Fit is used (consider fitting after an add when the cards no longer fit). (From the 13-principle design review, 2026-11-18, issue 5.) Needs: none. Spec: [canvas.md](../../concepts/data-source/canvas.md).
- **Server bounds: distinct values, latest day, join preview** (priority P2; effort M) — Open: these three reads have no `max_rows_to_read` / `max_memory_usage` backstop (the column profile keeps a memory one, `ProfileSettings` in `ClickHouseGateway.Profile.cs`; its row bound was dropped on purpose, so decide whether these three want a row bound before adding one, since a bound turns a slow answer into a refusal on a big table). Built since the review: pooled ClickHouse clients ([D139](../../decisions/decisions-performance.md)), forwarded headers behind Apache, a Secure session cookie on HTTPS, the translator's busy answer and I/O failure message, and the named translate error. Needs: a decision.

## Polish

- **Connect defaults and form** (priority P3) — Open: Trust self-signed certificate is on by default (D11), so a TLS connection does not check the certificate; the password stays in the form's DOM after connecting.
- **Dialog and wording consistency** (priority P3) — Open: the Relationship dialog has ✕, Edit SQL doesn't; "canvas" and "Data Source" name one thing; the foot hint ("Drag a column onto a column…") stays up over cards and the data preview.
- **Card move: keyboard and touch** (priority P3) — Open: no keyboard move for a card; a touch or pen drag has no `pointercancel` and the head no `touch-action: none`, so a cancelled drag can stick.
- **Card details** (priority P3) — Open: removing a card names the relationships it ends but not the worksheets that use it; the SQL editor's focus moves the cursor to line 1.
- **Module size and limit parity** (priority P3; effort M) — Open: `ClickHouse/ClickHouseGateway.cs` (≈1,800 lines, the open / command / reader loop repeated ≈15 times) and `Relations/relations.js` (≈870 lines) want splitting; no test checks `Core/validate.js` LIMITS against `RequestValidation.cs` (a stale comment says the server allows 16 filters; it is 20); per-drag `render()` redraws proposals and the notes card on every pointermove (suspected jank near 100 cards).

## Design review against the 13 graphic design principles (2026-11-18)

Judged on the rendered Data Source (headless Chromium, mocked `/api`, 4 tables and 2 links, 1440×1100, light and dark). Strong: alignment, colour, repetition, rhythm, unity. Weak: balance, hierarchy, emphasis, movement. Contrast, white space, proportion and proximity are mixed.

The review's five issues: 1 and 2 are partial (below), 3 (the Relationships card) is resolved by removing it: its wording moved into the relationship dialog ([D142](../../decisions/decisions-design.md#d142--the-relationship-dialog-says-in-words-what-the-link-does-no-relationships-card)), 4 is below, 5 is folded into "Canvas overview" under Should fix. Found while checking them:

- **Connected Data Source has no focal point** (priority P2; effort S) — Partial: built by subtraction ([D140](../../decisions/decisions-design.md#d140--the-data-source-gives-the-next-step-the-strongest-mark-a-cards--rests-muted-and-the-key-strip-has-no-fill)): a card's ✕ rests muted, the key strips have no fill. Still open: whether the proposal pill now leads on its own at 14px / 600 (look again with several cards), and the title question below. Original finding: every visible string is 14px (weights 400 / 600 / 700 only); the tab's name appears only in its pill, and once cards exist nothing leads: the selected card's 2px outline, tinted key rows, dashed proposals and the amber "Needs a partner" box all compete. Decide first whether a 16px or 24px title fits design rule 6 (no unnecessary labels); if not, give the selected card or the one pending proposal the single strong emphasis. Needs: a decision.
- **Proposed links cross and sit on top of drawn links** (priority P3; effort M) — Partial: proposals are drawn on demand ([D127](../../decisions/decisions-relationships.md#d127--a-table-pair-holds-one-relationship-related-in-few-steps), amended), so a resting canvas has none. Still open: a drawn proposal can cross a real link (forced when the two interleave in one gutter) and its pill, 16px under the lower card, can cover one. Draw proposals under real links with a gap where they cross, and make the pill avoid link lines the way it avoids badges (stack it beside the card). Needs: none. Spec: [relating-tables.md](../../concepts/data-source/relating-tables.md#proposed-links).
- **Transient messages overlap** (priority P3; effort S) — Open: the foot hint and the "Connected" toast stack on each other and on a card at 900px height. Give transient messages one lane. Extends "Dialog and wording consistency" under Polish. Needs: none.
- **A long host name leaves about 90px of text in the connection row** (priority P3; effort S) — Open: at the narrowest sidebar (240px) a 55-character host leaves the host label 89px wide beside the two icon buttons (it has a tooltip, `summaryTitle`). Let the row wrap the host onto its own line, or drop the user · port line to the tooltip when the host is long. Needs: none.

## Light-scheme controls fail the 3:1 edge rule

- **Borderless buttons have no visible edge on light grounds** (priority P1; effort M) — Open: audit 2026-11-18; option 2 (darker `--btn-fill`, 54 % ink) was tried 2026-11-19 and revoked. Original finding: `buttons.css` removes every button border and says "the fill carries the edge", but in light the fills stand off their ground by 1.03–1.18:1 (`.btn` fill vs `--bg` 1.03, vs `--surface` 1.18; glass `.tab` / `.sidebar__tool` vs `--bg` 1.12; the open-tool `--accent-soft` wash vs `--bg` 1.03; `.btn--danger` fill vs `--surface` 1.09). WCAG 1.4.11 asks 3:1 for a control's boundary. `--ctl-edge` (`#7b7e82`, 4.08:1 on white) already exists and is unused by buttons. Related: `.input` / `.select` borders use `--line-2` (1.62:1 on white, 1.40:1 on `--bg`); the `.btn--ghost` outline is the same colour. Hover and pressed also sit 1.07–1.08:1 off the surface. Fix direction: give light `.btn` (and glass tiers) a `--ctl-edge` outline at rest, or darken `--btn-fill`; `tests/js/contrast.test.mjs` should pin it. Needs: a decision, since it reverses the flat-button choice in tokens.md § Buttons have no border.
