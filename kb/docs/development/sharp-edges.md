---
components: [src/DashboardBuilder/Features/Connection/connection.js, src/DashboardBuilder/Features/Core/api.js, src/DashboardBuilder/Features/Schema/schema.js, src/DashboardBuilder/Features/Shell/app.js, tests/live/model.mjs]
---
# Sharp edges

Gotchas that have bitten (or will bite) this app. Read before touching the area named in each heading.

## ClickHouse

- **No foreign keys exist.** Don't look for `system` FK metadata. Relationship keys are user-picked
  columns ([golden rule 5](coding-standards.md#5-relationships-are-logical-declarations-not-database-facts)).
- **Identifiers aren't parameterizable.** `SHOW TABLES FROM {db}` and `DESCRIBE {db}.{table}` need
  string interpolation; only *values* can be bound
  ([golden rule 2](coding-standards.md#2-never-interpolate-an-identifier-you-havent-validated)).
- **`DESCRIBE` returns ClickHouse types, not SQL-92.** Expect `Nullable(...)`, `LowCardinality(...)`,
  `Array(...)`, `Enum8(...)`, `DateTime64(3)`. Map through `ClickHouseType.Categorize`; don't assume
  `int`/`varchar` ([type mapping](../reference/clickhouse-integration.md#type-mapping)).
- **A "wrong password" can be a source-IP restriction.** A user limited by `<networks>` gets
  `Code: 194 … REQUIRED_PASSWORD` (HTTP 401) from a disallowed IP even with the right password. The
  `default` user on `10.168.49.13` is localhost-only — connect from the app host with a
  network-enabled account ([detail](../reference/clickhouse-integration.md#a-wrong-password-can-be-a-network-restriction)).
- **The target cert is self-signed.** Validation is on by default, so connecting needs the
  "Trust invalid / self-signed certificate" box ticked
  ([D11](../decisions/decisions-platform.md#d11--tls-certificate-trust-self-signed-is-accepted-by-default-untick-to-verify)).
- **A hand-built `HttpClient` must set `AutomaticDecompression`**, or ClickHouse.Client throws
  "server returned compressed result but HttpClient did not decompress it".
- **A union or unpivot source multiplies the scan.** A union reads every source table in full; an
  unpivot produces up to 50 rows per source row. Only `max_execution_time` bounds it, and so a profile
  (which reads every row, [D143](../decisions/decisions-performance.md#d143--the-column-profile-reads-every-row)) that
  refuses settings has no bound at all ([query-sources.md](../concepts/data-source/query-sources.md#cost-limit)).
- **Two connections, same server, different databases is normal.** Scope every query to the
  connection + database the request names, never a global default.
- **A ClickHouse `JOIN … ON a = b` never matches NULL keys.** Verified: `NULL = NULL` joins 0 rows. So
  a Nullable group dimension drops out of the box-plot fence join. Join on
  `(ifNull(toString(k), ''), isNull(k))` instead.
- **Give helper columns unique aliases** such as `__bx_*`. A `WHERE` inside the same subquery resolves
  a user column named like an alias (`v`, `label`) to the alias, so it filters different rows.

## Hosting & deploy

- **The Apache proxy 403s `DELETE` and body-less `POST`/`GET`** before Kestrel sees them. Every
  state-changing call is a `POST` with a JSON body; for example, Disconnect is
  `POST /api/connection/disconnect` with `{}`. A feature can pass tests and direct `curl :5105` yet fail in the browser.
- **Never copy a DLL over the running process.** Overwriting the live mmap'd `DashboardBuilder.dll`
  throws `BadImageFormatException`, systemd crash-restarts, and every session's in-memory connection
  is lost. Stop → copy → start ([deployment.md § Release flow](../how-to/deployment.md)).
- **Never `pkill -f DashboardBuilder.dll`**; it matches the live service too. Kill dev runs by port.
- **A restart resets every session**, because the session store is in memory. Users must reconnect;
  their workbook restores from the browser on reconnect.
- **Stale ES modules.** Imports aren't version-stamped, but the page serves every asset under
  `/features/v-<content hash>/…`, so a changed file means new URLs for the whole graph and the browser keeps a
  matching build for a year (`immutable`). Keep imports **relative** (an absolute `/features/…` import skips the
  prefix and loads an unversioned copy) and keep the HTML uncached. Unversioned and old-hash URLs answer
  `no-cache`. [D139](../decisions/decisions-performance.md#d139--static-assets-live-under-a-content-hash-url-and-are-cached-for-a-year-clickhouse-calls-share-one-http-client-per-endpoint).

## Frontend

- **Measure values can be a string or `null`, not just a number.** `min` / `max` of a text or date column
  return strings. An aggregate over no rows (or one giving `NaN` / `∞`) returns `null`. Anything that
  reads `row.values[i]` must handle both; only Table, Text and KPI can show a string. A numeric-looking
  text value (`"01234"`) still gets number formatting, because no measure-type signal reaches the client.
- **Temporal values are ISO text, and midnight `DateTime` renders date-only.** Keys, distinct values and
  box labels are `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`; a `DateTime` at exactly `00:00:00` prints as
  `YYYY-MM-DD`. A `Date` / `Date32` column rejects a filter value with a time part (400). `DateTime64`
  keys lose their milliseconds, and filter values with fractional seconds are rejected.
- **Server filter cap (20) ≠ client cap (8).** The worksheet appends the shared filters (≤ 4), drill path,
  page, selection and date range to the user's filters. Raise one side only with the other in mind
  ([api.md § Limits](../reference/api.md#limits)).
- **Approximate SAMPLE is untested against a live ClickHouse.** The SQL (`SAMPLE 0.1`, `_sample_factor`)
  follows the ClickHouse docs. A refusal falls back to an unsampled query, so the worst case is no speed-up.
- **The result cache is per process.** Two app instances keep separate caches; a restart empties it.
- **Drop-time caps ignore the chart type.** Dimension / measure counts include encodings the current
  chart doesn't use, so a drop exactly at the cap can be refused until the stale encoding is removed.
- **`POST /api/query {}` is a 400, not a 409**, because model binding runs before the connection check.
- **An unmatched `/api/*` route returns an empty-body 404** (no `{ error }`). A client that parses the
  body must tolerate it.
- **An unreadable stored workbook is backed up, never overwritten.** Autosave is blocked for a key only
  when no backup could be kept ([workbook.md](../concepts/workbook/workbook.md#restore-on-connect)).
- **The worksheet's column cache is never invalidated on reconnect** to a different server. Filters can
  read "can't be compared" until a reload.
- **New feature CSS/JS must sit under `Features/`.** Only `.css`/`.js` are served from there
  (`/features/<Feature>/<file>`) and only those globs are copied on publish; anything else 404s.
- **Init order matters.** `app.js` registers listeners (`schema.js`'s `connection:changed`) before
  `connection.js` fires its initial status check.
- **`api.js` derives the API base from its own URL** by stripping `/features/Core/`. Move the file and
  every API call 404s. The page still loads, so only a click reveals it.
- **No headless browser on the build host**, but Node 24 is available (via nvm). Unit-test pure modules
  with `node --test` and drive the DOM in jsdom ([testing.md](../how-to/testing.md#test)).
- **Ports 5080 and 5199 are taken.** The launch profile pins 5080, and a long-running dev process holds
  5199. Smoke-test with `dotnet run --no-launch-profile --urls http://localhost:5180`; otherwise an
  `ASPNETCORE_URLS` or launch-profile setting wins.
- **`::details-content { display: contents }` breaks closing a `<details>`.** Chrome hides closed content
  with `content-visibility: hidden` on that box, which `display: contents` ignores, so scope it to `[open]`
  (the old Relationships card did this before [D142](../decisions/decisions-design.md#d142--the-relationship-dialog-says-in-words-what-the-link-does-no-relationships-card) removed it).
- **A closed grid `<details>` keeps its `gap`.** The hidden content slot is still a grid item, so the gap
  sits under the summary and pushes it off centre; zero it with `:not([open])`.
- **`height: auto` stretches a modal `<dialog>` to the window.** The browser's own style is `height: fit-content`
  on a modal with `inset: 0`; to undo a set height, go back to `fit-content` (`.dialog--rel` under 640px in `relations.css`).
- **A grid item with `min-height: 0` shrinks under its text once the grid has a definite height.** Resetting a two-panel grid to one column
  for a narrow window needs `min-height: auto` back on the panels, or the first panel's row collapses and the next one overlaps it (the relationship dialog under 880px).
- **A cache hit means no query.** Presentation-only changes re-render from the worksheet's result
  cache. If a change *should* re-query, it must change the plan (see
  [worksheet-query.md § Query lifecycle](../concepts/worksheet/worksheet-query.md#query-lifecycle)).
- **A browser check that adds two tables must relate them** (`tests/live/model.mjs` `relateTables`), or the
  field pane stays empty and the check times out at "field pane filled". Calculated fields and hierarchies
  are not in the pane: drive them through the sidebar dialogs, and close any popup or dialog before a real
  mouse click on a mark.
- **A `//` comment inside an object literal hides every property after it on that line.** A bar label's `color`,
  `fontFamily` and `fontSize` sat behind one in `chart.js` and silently fell back to ECharts' defaults (a dark fill with
  a white outline). Put the comment at the end of the line, and check the option a chart really receives, not the source.
- **A flyout control disabled inside `.is-disabled` fades twice.** `.btn:disabled` (.5) and `.ws-fmt-select:disabled` (.55)
  stack on the wrapper's own fade, so selects and tiles went near-invisible while text inputs (no `:disabled` fade) looked
  almost enabled. `.ws-toolfly .is-disabled :disabled { opacity: 1 }` leaves the wrapper's single fade; keep new Label
  controls inside a wrapper that `gated()` marks.
- **A script's `focus()` and `click()` are not a user.** In headless Chromium the page itself is unfocused, so `el.focus()` fires no `focus` event (the Edit tooltip modal's "active line" follows `focus`), and Esc on a `<dialog>` is only cancelable after a real press: a handler that `preventDefault`s the `cancel` event (the Insert menu closing before the modal) sees the dialog close anyway. Browser checks press with `b.click(x, y)` first (`tests/live/tooltip-ui.mjs` `focusLine`, `tooltip-shape-dialogs-ui.mjs`). A check that fails with a modal open must not leave it open for the next one (`openModal` cancels a stale one), or every later check fails with it.
- **An aligned tooltip line is a block, the others are inline.** `text-align` does nothing on the `<span>` a styled line is, so `tooltipHtml` (`tooltip-model.js`) emits a `<div>` for a centred or right-aligned line and a `<br>` only between two inline lines. Add a line style that needs a box the same way, and keep the no-style output byte-identical (`tooltip-golden.json`).
- **A lone icon in a `.btn` sits 4px left of centre.** `buttons.css` pads a button whose first child is an icon for icon-plus-label (8px before, 16px after), and that also matches an icon-only button. Inside `.ws-flyedit` the rule `.ws-flyedit .btn:has(> .icon:only-child)` restores symmetric padding (the Tooltip editor's alignment, clear and card-field remove buttons); an icon-only `.btn` anywhere else still has the offset until it gets the same.
- **The Tooltip editor must never be detached or rebuilt while it is open.** A commit re-renders the worksheet, which rebuilds the flyout; moving the editor's nodes (re-appending them to a new panel, `replaceChildren` with the same node) blurs it, drops the selection and an open Insert list, resets the flyout's scroll and breaks an IME composition. So `tooltipFly` keeps one editor and its panel per sheet, `toolPanel` returns that same panel, `mountFly` skips the re-attach when it is already the flyout's only child, and the editor's `sync()` only re-reads sheet state. Anything new that builds the Tooltip flyout must go through `tooltipFly`. The text group commits on a 400ms debounce, on focus out and in `closeFly`; a new teardown path (a new way to close or switch the flyout) must call `flush({ final: true })` first or the last typing is lost.
- **The Edit tooltip editor is a controlled `contenteditable`: never read it back.** Every edit is a `beforeinput` that `tooltip-editor.js` cancels and applies to the model (`replaceRange`), then the blocks are drawn again; only input-method composition is left to the browser and read back as `textContent`. Anything that touches the surface from outside (a test, a script) must go through real input events (`Input.insertText`, a `keyDown` with `text: "\r"` for Enter), and a selection it sets is seen by the editor only after `selectionchange`, which is queued: the editor and the toolbar read the live selection (`current()`), and a test that selects and types at once relies on that.
