import { dateIn, clockIn } from "../Core/timezone.js";

// Auto-backup, the pure part (no DOM, no storage): file names, which backups to prune, when a backup is due, the saved settings and
// the words for a failure. Workbook/backup.js does the browser work (folder picker, permission, writes).

export const BACKUP_INTERVAL_MS = 10 * 60 * 1000; // at most one backup this often
export const BACKUP_KEEP = 5;                     // the newest this many stay; the next backup replaces the oldest
export const BACKUP_ROOT = "DashboardBuilder-backups"; // the folder the app makes inside the one the user picked
export const SETTINGS_KEY = "dashboardbuilder.backup.v1";

const NAME = /^workbook-\d{8}-\d{6}\.json$/;

/** One path segment from free text: only letters, digits, dot, dash and underscore; never empty, never starting with a dot, ≤ 60 characters. */
export function safeSegment(text) {
  const s = String(text ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, 60);
  return s || "_";
}

/** The folder name for a connection: host-port-user, each part made safe, so a user name can't carry a path. */
export function connectionFolder(view) {
  return [view?.host, view?.port, view?.user].map(safeSegment).join("-");
}

/** "workbook-20261120-103005.json" for a moment (the app's time zone). */
export function backupName(ms, tz) {
  const date = dateIn(ms, tz).replaceAll("-", "");
  const time = clockIn(ms, tz).replaceAll(":", "");
  return `workbook-${date}-${time}.json`;
}

/** True only for a file name this app wrote. Nothing else in the folder is ever touched. */
export const isBackupName = (name) => NAME.test(String(name));

/** The backup names in a folder, newest first. Names the app didn't write are left out. */
export function newestFirst(names) {
  return names.filter(isBackupName).sort().reverse();
}

/** The names to delete so only the newest `keep` remain; only the app's own names are ever listed. */
export function namesToPrune(names, keep = BACKUP_KEEP) {
  return newestFirst(names).slice(keep);
}

/** "2026-11-20 10:30:05" from a backup name, or the name itself when it isn't one. */
export function nameLabel(name) {
  const m = /^workbook-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.json$/.exec(String(name));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : String(name);
}

/** A short change-detection hash of the saved text (two 32-bit mixes and the length), for "is this the same as the last backup". */
export function hashText(text) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16)}${(h1 >>> 0).toString(16)}-${text.length}`;
}

/** `hashText` of a saved workbook without what is not content: the save time and the Data Source view (zoom, pan, D159). Panning must not look like a change, or a minute of it would push a real version out of the rolling copies. */
export function contentHash(text) {
  return hashText(String(text).replace(/"savedAt":\s*"[^"]*",?/, "").replace(/"view":\s*\{\s*"zoom":[^,}]*,\s*"pan":\s*\{[^}]*\}\s*\},?/, ""));
}

/**
 * Is a backup due? `empty` and unchanged content never write (an empty workbook would replace the good copies; the same content
 * would only push an older copy out); `force` (Back up now) skips the "unchanged" and "too soon" checks, never the empty one.
 * Returns `{ write, reason, wait }`: `wait` is the milliseconds until the interval is up when the reason is "too-soon".
 */
export function decideWrite({ now, lastAt = 0, lastHash = "", hash, empty = false, force = false, intervalMs = BACKUP_INTERVAL_MS }) {
  if (empty) return { write: false, reason: "empty", wait: 0 };
  if (force) return { write: true, reason: "forced", wait: 0 };
  if (hash === lastHash) return { write: false, reason: "unchanged", wait: 0 };
  const since = now - lastAt;
  if (lastAt && since >= 0 && since < intervalMs) return { write: false, reason: "too-soon", wait: intervalMs - since };
  return { write: true, reason: "due", wait: 0 };
}

/** The saved settings: whether backups are on and, per connection folder, when and what was last written. A bad entry reads as the defaults. */
export function parseSettings(raw) {
  const out = { enabled: false, last: {} };
  let v;
  try { v = JSON.parse(raw); } catch { return out; }
  if (!v || typeof v !== "object") return out;
  out.enabled = v.enabled === true;
  if (v.last && typeof v.last === "object") {
    for (const [k, e] of Object.entries(v.last)) {
      if (e && Number.isFinite(e.at) && typeof e.hash === "string") out.last[k] = { at: e.at, hash: e.hash };
    }
  }
  return out;
}

export const serializeSettings = (s) => JSON.stringify({ enabled: s.enabled === true, last: s.last ?? {} });

/** Why auto-backup can't run in this browser, or "" when it can. */
export function unsupportedReason({ hasPicker, secure }) {
  if (!hasPicker) return "Auto-backup needs Chrome or Edge on a computer; this browser can't write to a folder.";
  if (!secure) return "Auto-backup needs a secure (https) page; this page isn't one.";
  return "";
}

/** Plain words for a file-system failure (a DOMException name), or "" for the user cancelling the picker. */
export function describeError(err) {
  switch (err?.name) {
    case "AbortError": return "";
    case "NotAllowedError": return "the browser didn't allow access to that folder";
    case "SecurityError": return "the browser doesn't allow that folder; pick another one";
    case "NotFoundError": return "the folder or file wasn't found";
    case "QuotaExceededError": return "the disk is full";
    case "NoModificationAllowedError": return "the file is locked by another program";
    default: return String(err?.message || "an unknown error").replace(/\.$/, "");
  }
}
