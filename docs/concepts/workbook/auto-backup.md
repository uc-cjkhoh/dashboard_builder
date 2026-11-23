---
components: [src/DashboardBuilder/Features/Workbook/backup.js, src/DashboardBuilder/Features/Workbook/backup-model.js, src/DashboardBuilder/Features/Workbook/workbook.js, src/DashboardBuilder/Features/Workbook/workbook.css, src/DashboardBuilder/Features/Shell/Index.cshtml]
---
# Auto-backup — a hard copy of the workbook in a folder on disk

The workbook lives in the browser's `localStorage` ([workbook.md](workbook.md)), which clearing site data, a private window, another
browser or a changed app address loses. Auto-backup also writes the workbook to a **folder the user picks on their own disk**, so it
survives all of that. Nothing goes to the server: the browser writes the files itself ([D150](../../decisions/decisions-workbook-backup.md)).

**Code:** `Workbook/backup.js` (folder, permission, writes, the Settings dialog), `Workbook/backup-model.js` (pure: names, pruning,
timing, settings, error words), a hook in `Workbook/workbook.js`, the Settings button (`Shell/Index.cshtml`).

## At a glance

- **Where:** a folder the user picks once. The app makes `DashboardBuilder-backups/<host>-<port>-<user>/` inside it.
  There is no fixed default path: a web page can't write to a path by name, so the first run asks. The picker opens at Documents
  and remembers the last choice (`id: "dashboardbuilder-backup"`).
- **What:** the same text autosave just stored in `localStorage`, so no password and no connection secret. **Import workbook…** opens it.
- **When:** after a change, at most **once every 10 minutes**; also at once when the connection changes (what the workbook flushed for
  the connection being left), when the tab is hidden (best effort: an async write may not finish while a tab closes, so the timer is the
  guarantee), when a folder is chosen, and on **Back up now**.
- **How many:** the newest **5** files, named `workbook-YYYYMMDD-HHmmss.json` in the app's time zone. The next backup removes the oldest.
  Only names matching that pattern are ever listed or removed; anything else in the folder is left alone.
- **Browsers:** desktop Chrome and Edge (File System Access API), on `https` or `localhost`. Elsewhere the Settings dialog says why and its controls are off.

## What is never written

`decideWrite` (in `backup-model.js`) refuses, in this order:

| Case | Why |
|---|---|
| An **empty** workbook (no tables, no tabs), even on Back up now | it would push the good copies out |
| Content **identical** to the last backup of that connection (a hash, kept per connection folder in `localStorage`) | an idle session or a page reload would rotate good copies out; Back up now and a newly chosen folder skip this check |
| Content changed but the 10 minutes aren't up | a timer writes the newest content when they are (`wait` is the time left) |

A save the workbook module refused (an unreadable stored entry, a partial open) never reaches the backup, because the backup is told
only after a successful save (`workbook:saved`).

## The Settings dialog

One **Settings** icon (`settings`, title and `aria-label` "Settings") is the last tile of the sidebar foot (`#settings-dock-btn`, an id kept from the old dock),
next to Appearance. It is in the same place on every tab, on the wide sidebar and on every rail: the Data Source, a worksheet, a dashboard and a story.
It opens one modal (`dialog.backup-dialog`), titled **Settings**, section **Auto-backup**:

- **Folder** — the folder's name (never its full path: the browser doesn't give it) and **Choose folder…** / **Change folder…**.
  A new folder gets a copy at once. The old folder keeps its files.
- **Status** with an icon, text and colour: *Last backup <time>* (ok), *Auto-backup is off*, *Not backing up. Choose a folder to start.*,
  *Paused. The browser needs your OK to use this folder.* with **Allow access**, or *Paused. Couldn't write the backup: <reason>.*
- **Backups for <user>@<host>** — the files for the connected server and user, newest first, the newest selected, and **Restore**.
  Disconnected, it says to connect; without access, it says to allow it.
- **Back up now**, **Turn off** / **Turn on**, **Close**.

A paused backup also puts a dot on the Settings button and changes its label to "Settings — auto-backup is paused", and shows one
danger toast per cause (not one per save).

## Restore

1. **Settings → Restore** reads the chosen file and hands its text to the workbook module (`workbook:open-text`). It opens through the
   same checks as an imported file: full validation, the issues dialog, and the replace confirmation before a non-empty canvas is replaced.
2. **On connect, with nothing stored in this browser** (`workbook:none-stored`) and the folder still known and already allowed, a
   dialog offers *Restore your workbook from the backup of <time>?*. Once per connection per page load. If the browser needs a click
   to allow the folder first, nothing is offered; use Settings.
3. **After the site data is cleared** the folder link (kept in IndexedDB) is gone too, but the files are still on disk. Connect, open
   Settings, **Choose folder…** (the same folder), and the list shows the backups; **Restore** opens one.

## Storage and events

| Where | Holds |
|---|---|
| IndexedDB `dashboardbuilder` → `backup-folder` → `folder` | the folder handle |
| `localStorage` `dashboardbuilder.backup.v1` | `{ enabled, last: { "<host>-<port>-<user>": { at, hash } } }` |

| Event (on the store `bus`) | From → to |
|---|---|
| `workbook:saved` `{ json, view, empty }` | `workbook.js` after a successful autosave → `backup.js` |
| `workbook:none-stored` `{ view }` | `workbook.js` on connect with nothing stored → `backup.js` |
| `workbook:open-text` `{ text, name }` | `backup.js` → `workbook.js` (`importText`) |

`initBackup()` runs after `initWorkbook()` (`Shell/app.js`), so on a connection change the workbook has already flushed its save.

## Safety

- The folder name is `host-port-user` with each part cut to `[A-Za-z0-9._-]`, a leading dot replaced and a 60-character cap
  (`safeSegment`), so a user name can't carry a path.
- Writing needs the browser's `readwrite` permission. After a browser restart it may be "prompt" until one click (**Allow access**);
  until then the backup is paused, with the toast and the dot above.
- Chrome refuses some folders (system folders); the picker's refusal is shown as a toast with its reason, and the previous setting stays.

## Tests

- `tests/js/backup-model.test.mjs` — names, sanitising, pruning (own names only), when a backup is due, settings, error words.
- `tests/live/auto-backup-ui.mjs` — the picker is replaced by a folder in the page's origin-private file system (the same handle interface): the
  button places, choose → file written without the password, the interval holds, 5 kept and foreign files untouched, the connect offer,
  restore after site data is cleared with nothing written for an empty canvas, and the no-picker browser.
- Not covered by an automated test: the real folder picker window and the permission prompt (checked by hand in Chrome or Edge).
