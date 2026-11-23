---
components: [src/DashboardBuilder/Features/Workbook/backup.js, src/DashboardBuilder/Features/Workbook/backup-model.js]
---
# Decisions: workbook auto-backup

### D150 — The workbook is also copied to a folder the user picks, by the browser; nothing is stored on the server
D21 keeps the workbook in `localStorage` and names Export as the backup. A manual Export is forgotten, and clearing site data, a private
window or a changed app address loses the workbook. The app now also writes it, by itself, to a folder on the user's disk.

- **How:** the File System Access API (`showDirectoryPicker`), once per browser. Every 10 minutes after a change, and on connection
  change, the stored text is written as `workbook-YYYYMMDD-HHmmss.json`; the newest 5 stay.
- **Why 5, not 1:** one file is replaced by the next backup, so a bad state (a worksheet deleted by mistake) would overwrite the only good
  copy within 10 minutes; five reach back about 50 minutes, and unchanged content is skipped so an idle session rotates nothing.
- **Why a picked folder, not `~/.cache` or `/tmp`:** a page can't write to a path by name, and those folders are cleaned on reboot or by age,
  which defeats a hard copy.
- **D2 and D21 hold:** no application database and no server-side storage. The server sees nothing; the file is the export, with no password
  (golden rule 4).
- **Pruning** deletes only files whose names match the app's own pattern, never anything else in the folder (golden rule 12 is about a
  user's work; a rolling copy is replaced, not deleted by hand).
- **Rejected:** repeated downloads (they pile up in Downloads and may be blocked); more copies in `localStorage` or IndexedDB (they die with the
  same site-data clear); a server-side copy (it needs a new decision on D2 and an arbitrary-write guard for a typed path).
- **Trade-offs:** desktop Chrome and Edge only (Firefox and Safari have no folder picker); a browser restart may need one click to allow the folder again.
- Detail: [auto-backup.md](../concepts/workbook/auto-backup.md).
