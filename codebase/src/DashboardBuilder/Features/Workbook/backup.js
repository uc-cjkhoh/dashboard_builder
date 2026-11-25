import { bus } from "../Core/store.js";
import { icon } from "../Core/icons.js";
import { toast, makeButton, openDialog, closeDialog, confirmDialog } from "../Core/ui.js";
import { dateTimeIn } from "../Core/timezone.js";
import {
  BACKUP_INTERVAL_MS, BACKUP_KEEP, BACKUP_ROOT, SETTINGS_KEY,
  connectionFolder, backupName, newestFirst, namesToPrune, nameLabel, contentHash, decideWrite,
  parseSettings, serializeSettings, unsupportedReason, describeError,
} from "./backup-model.js";

// Auto-backup: a hard copy of the workbook in a folder on the user's disk, so it survives anything that happens to this browser's storage.
// The user picks a folder once (the File System Access API; Chrome and Edge). Every 10 minutes after a change, and when the connection changes
// or the tab is hidden, the stored workbook's text (what Workbook/workbook.js just saved, with no password) is written to
// <folder>/DashboardBuilder-backups/<host>-<port>-<user>/workbook-<date>-<time>.json, and only the newest 5 such files are kept.
// Nothing leaves the browser except to that folder. The folder handle lives in IndexedDB, the on/off switch and last-backup record in
// localStorage; clearing site data drops both, but the files stay on disk and the Settings dialog can list and restore them again.

const DB_NAME = "dashboardbuilder", STORE = "backup-folder", HANDLE_KEY = "folder", PICKER_ID = "dashboardbuilder-backup";
const RW = { mode: "readwrite" };

let unsupported = "";   // why it can't run here, or ""
let settings = { enabled: false, last: {} };
let handle = null;      // the folder the user picked (a FileSystemDirectoryHandle), or null
let latest = null;      // the newest saved workbook: { json, hash, view, empty }
let lastError = "";     // why the last write failed, or ""
let timer = null;       // the wait until the next backup is allowed
let queue = Promise.resolve(); // backups run one at a time
let warned = "";        // the last "paused" toast (once per cause)
let currentView = null; // the connection the screen is on (host, port, user), or null
let ready = Promise.resolve(); // the folder handle has been read from IndexedDB (the first connection event can arrive before it)
const offered = new Set(); // connection folders already offered a restore in this page load
const watchers = new Set(); // open Settings dialogs, redrawn when the state changes

// --- storage -----------------------------------------------------------------
function loadSettings() {
  try { return parseSettings(localStorage.getItem(SETTINGS_KEY)); } catch { return parseSettings(null); }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, serializeSettings(settings)); } catch { /* not remembered — backups still run this session */ }
}
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(mode, run) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch { return null; }
}
const loadHandle = () => idb("readonly", (s) => s.get(HANDLE_KEY));
const storeHandle = (h) => idb("readwrite", (s) => s.put(h, HANDLE_KEY));

// --- folder access -----------------------------------------------------------
async function hasAccess({ ask = false } = {}) {
  if (!handle) return false;
  try {
    if ((await handle.queryPermission(RW)) === "granted") return true;
    return ask && (await handle.requestPermission(RW)) === "granted"; // needs a click (a user gesture)
  } catch { return false; }
}

/** The connection's folder inside the chosen one; `create` false answers null when it isn't there yet. */
async function connectionDir(view, create) {
  try {
    const root = await handle.getDirectoryHandle(BACKUP_ROOT, { create });
    return await root.getDirectoryHandle(connectionFolder(view), { create });
  } catch (err) {
    if (!create && err?.name === "NotFoundError") return null;
    throw err;
  }
}

async function namesIn(dir) {
  const names = [];
  for await (const [name, entry] of dir.entries()) if (entry.kind === "file") names.push(name);
  return names;
}

/** The backups for a connection, newest first ([] when none, or no access). */
async function listBackups(view) {
  if (!handle || !view || !(await hasAccess())) return [];
  try {
    const dir = await connectionDir(view, false);
    return dir ? newestFirst(await namesIn(dir)) : [];
  } catch { return []; }
}

async function readBackup(view, name) {
  const dir = await connectionDir(view, false);
  return (await (await dir.getFileHandle(name)).getFile()).text();
}

// --- writing -----------------------------------------------------------------
const enqueue = (opts) => { queue = queue.then(() => runBackup(opts)).catch((err) => console.error(err)); return queue; };

/** One backup, if one is due. `asap` skips the 10-minute wait (a connection change, the tab going away, Back up now); `force` also skips "unchanged". */
async function runBackup({ asap = false, force = false } = {}) {
  await ready;
  if (unsupported || !settings.enabled || !latest?.view) return { reason: "off" };
  const snap = latest, folder = connectionFolder(snap.view), last = settings.last[folder] ?? {};
  const now = Date.now();
  const d = decideWrite({ now, lastAt: asap || force ? 0 : last.at, lastHash: last.hash, hash: snap.hash, empty: snap.empty, force });
  if (!d.write) {
    if (d.reason === "too-soon") { clearTimeout(timer); timer = setTimeout(() => enqueue({}), d.wait + 50); }
    return d;
  }
  if (!handle) { notify(); return { write: false, reason: "no-folder" }; }
  if (!(await hasAccess())) { pause("needs-permission", "Auto-backup is paused — open Settings and choose Allow access."); return { write: false, reason: "needs-permission" }; }
  try {
    const dir = await connectionDir(snap.view, true);
    const file = await dir.getFileHandle(backupName(now), { create: true });
    const out = await file.createWritable();
    await out.write(snap.json);
    await out.close();
    for (const name of namesToPrune(await namesIn(dir), BACKUP_KEEP)) await dir.removeEntry(name); // only names this app wrote
    settings.last[folder] = { at: now, hash: snap.hash };
    saveSettings();
    lastError = ""; warned = "";
    notify();
    return { ...d, wrote: true };
  } catch (err) {
    lastError = describeError(err) || "an unknown error";
    pause("error", `Auto-backup is paused — couldn't write the backup: ${lastError}.`);
    return { write: false, reason: "error" };
  }
}

function pause(cause, text) {
  if (warned !== cause) { warned = cause; toast(text, "danger"); }
  notify();
}

// --- events ------------------------------------------------------------------
function onSaved(e) {
  const { json, view, empty } = e.detail ?? {};
  if (typeof json !== "string") return;
  latest = { json, view, empty: empty === true, hash: contentHash(json) };
  if (settings.enabled && !unsupported) enqueue({});
}

/** Connected with nothing stored in this browser: if a backup of this server + user is in the chosen folder, offer it. */
async function onNoneStored(e) {
  const view = e.detail?.view;
  await ready;
  if (!view || !handle || unsupported) return;
  const folder = connectionFolder(view);
  if (offered.has(folder)) return;
  offered.add(folder);
  const names = await listBackups(view); // reads only with the folder already allowed; otherwise Settings → Restore does it
  if (!names.length) return;
  const ok = await confirmDialog(`Restore your workbook from the backup of ${nameLabel(names[0])}?`, { confirmText: "Restore" });
  if (!ok) return;
  await openBackup(view, names[0]);
}

async function openBackup(view, name) {
  try {
    const text = await readBackup(view, name);
    bus.dispatchEvent(new CustomEvent("workbook:open-text", { detail: { text, name: `the backup of ${nameLabel(name)}` } }));
  } catch (err) {
    toast(`Couldn't read that backup: ${describeError(err) || "an unknown error"}.`, "danger");
  }
}

// --- choosing and switching --------------------------------------------------
async function chooseFolder() {
  try {
    const picked = await window.showDirectoryPicker({ id: PICKER_ID, mode: "readwrite", startIn: handle ?? "documents" });
    await picked.getDirectoryHandle(BACKUP_ROOT, { create: true }); // proves it is writable before it is kept
    handle = picked;
    await storeHandle(picked);
    settings.enabled = true;
    saveSettings();
    lastError = ""; warned = "";
    enqueue({ force: true }); // a new folder gets a copy at once, even of content the old folder already has
    notify();
  } catch (err) {
    const why = describeError(err);
    if (why) toast(`Couldn't use that folder: ${why}.`, "danger");
  }
}

async function setEnabled(on) {
  if (on && !handle) { await chooseFolder(); return; }
  settings.enabled = on;
  saveSettings();
  if (on) { warned = ""; enqueue({ asap: true }); }
  notify();
}

async function allowAccess() {
  if (await hasAccess({ ask: true })) { warned = ""; lastError = ""; enqueue({ asap: true }); }
  else toast("The browser didn't allow access to that folder.", "danger");
  notify();
}

async function backUpNow() {
  if (!latest || latest.empty) { toast("Nothing to back up yet — add a table first.", "info"); return; }
  const res = await enqueue({ force: true });
  if (res?.wrote) toast("Backed up.", "ok");
}

// --- the state the dialog and the buttons show --------------------------------
/** "unsupported" | "no-folder" | "off" | "needs-permission" | "error" | "ok" */
async function currentStatus() {
  if (unsupported) return "unsupported";
  if (!handle) return "no-folder";
  if (!settings.enabled) return "off";
  if (!(await hasAccess())) return "needs-permission";
  return lastError ? "error" : "ok";
}

function lastBackupAt() {
  const mine = currentView ? settings.last[connectionFolder(currentView)] : null;
  if (mine) return mine.at;
  return Math.max(0, ...Object.values(settings.last).map((e) => e.at));
}

async function notify() {
  const status = await currentStatus();
  for (const el of document.querySelectorAll("[data-settings-open]")) {
    const attention = status === "needs-permission" || status === "error";
    el.classList.toggle("is-attention", attention);
    const label = attention ? "Settings — auto-backup is paused" : "Settings";
    el.title = label; el.setAttribute("aria-label", label);
  }
  for (const redraw of watchers) redraw();
}

// --- the Settings dialog -----------------------------------------------------
const STATUS_LOOK = {
  ok: ["check", "ok"], off: ["info", "plain"], "no-folder": ["info", "plain"],
  "needs-permission": ["warning", "warn"], error: ["error", "danger"], unsupported: ["warning", "warn"],
};

function statusText(status) {
  switch (status) {
    case "unsupported": return unsupported;
    case "no-folder": return "Not backing up. Choose a folder to start.";
    case "off": return "Auto-backup is off.";
    case "needs-permission": return "Paused. The browser needs your OK to use this folder.";
    case "error": return `Paused. Couldn't write the backup: ${lastError}.`;
    default: { const at = lastBackupAt(); return at ? `Last backup ${dateTimeIn(at)}.` : "On. The first backup is written after your next change."; }
  }
}

function openSettings(opener) {
  const dlg = document.createElement("dialog");
  dlg.className = "dialog backup-dialog";
  dlg.setAttribute("aria-labelledby", "backup-title");

  const title = document.createElement("h2"); title.className = "dialog__title"; title.id = "backup-title"; title.textContent = "Settings";
  const body = document.createElement("div"); body.className = "backup-dialog__body";
  const heading = document.createElement("h3"); heading.className = "backup-dialog__heading"; heading.textContent = "Auto-backup";

  const folderRow = document.createElement("div"); folderRow.className = "backup-row";
  const folderLabel = document.createElement("span"); folderLabel.className = "backup-row__label"; folderLabel.textContent = "Folder";
  const folderValue = document.createElement("span"); folderValue.className = "backup-row__value"; folderValue.id = "backup-folder";
  const choose = makeButton("", "btn"); choose.id = "backup-choose";
  folderRow.append(folderLabel, folderValue, choose);

  const statusRow = document.createElement("div"); statusRow.className = "backup-row";
  const statusEl = document.createElement("p"); statusEl.className = "backup-status"; statusEl.id = "backup-status"; statusEl.setAttribute("role", "status");
  const allow = makeButton("Allow access", "btn"); allow.id = "backup-allow";
  statusRow.append(statusEl, allow);

  const keep = document.createElement("p"); keep.className = "backup-note"; keep.textContent = `Every ${BACKUP_INTERVAL_MS / 60000} minutes after a change. The newest ${BACKUP_KEEP} are kept.`;

  const listHead = document.createElement("h3"); listHead.className = "backup-dialog__heading"; listHead.id = "backup-list-head";
  const list = document.createElement("div"); list.className = "backup-list"; list.id = "backup-list"; list.setAttribute("role", "radiogroup"); list.setAttribute("aria-labelledby", "backup-list-head");
  body.append(heading, folderRow, statusRow, keep, listHead, list);

  const foot = document.createElement("div"); foot.className = "dialog__foot";
  const now = makeButton("Back up now", "btn"); now.id = "backup-now";
  const restore = makeButton("Restore", "btn"); restore.id = "backup-restore";
  const toggle = makeButton("", "btn"); toggle.id = "backup-toggle";
  const done = makeButton("Close", "btn btn--primary");
  foot.append(now, restore, toggle, done);
  dlg.append(title, body, foot);
  document.body.append(dlg);

  let ticket = 0;
  let picked = ""; // the backup the user chose; until they choose, the newest is selected and stays so as new backups arrive
  list.addEventListener("change", (e) => { if (e.target instanceof HTMLInputElement) picked = e.target.value; });
  const draw = async () => {
    const mine = ++ticket;
    const status = await currentStatus();
    const names = status === "ok" || status === "off" || status === "error" ? await listBackups(currentView) : [];
    if (mine !== ticket || !dlg.isConnected) return;
    const [glyph, tone] = STATUS_LOOK[status];
    statusEl.className = `backup-status backup-status--${tone}`;
    const g = document.createElement("span"); g.className = "backup-status__icon"; g.setAttribute("aria-hidden", "true"); g.append(icon(glyph, { size: 16 }));
    statusEl.replaceChildren(g, document.createTextNode(` ${statusText(status)}`));
    folderValue.textContent = handle?.name ?? "None chosen";
    choose.textContent = handle ? "Change folder…" : "Choose folder…";
    choose.disabled = !!unsupported;
    allow.hidden = status !== "needs-permission";
    now.disabled = unsupported || !handle || status === "off";
    toggle.textContent = settings.enabled ? "Turn off" : "Turn on";
    toggle.hidden = !!unsupported;
    toggle.disabled = false;
    // The backups for the connected server + user, newest first, the newest chosen.
    const connected = !!currentView;
    listHead.hidden = list.hidden = !handle || !!unsupported;
    listHead.textContent = connected ? `Backups for ${currentView.user}@${currentView.host}` : "Backups";
    if (!connected) list.replaceChildren(plain("Connect to a server to see its backups."));
    else if (status === "needs-permission") list.replaceChildren(plain("Allow access to see the backups."));
    else if (!names.length) list.replaceChildren(plain("No backups yet for this server and user."));
    else {
      const chosen = names.includes(picked) ? picked : names[0];
      list.replaceChildren(...names.map((name) => {
        const row = document.createElement("label"); row.className = "backup-pick";
        const input = document.createElement("input"); input.type = "radio"; input.name = "backup-pick"; input.value = name;
        input.checked = name === chosen;
        row.append(input, document.createTextNode(nameLabel(name)));
        return row;
      }));
    }
    restore.disabled = !connected || !list.querySelector("input");
  };
  const plain = (text) => { const p = document.createElement("p"); p.className = "backup-note"; p.textContent = text; return p; };

  watchers.add(draw);
  const finish = () => { watchers.delete(draw); closeDialog(dlg); opener?.focus(); };
  choose.addEventListener("click", chooseFolder);
  allow.addEventListener("click", allowAccess);
  now.addEventListener("click", backUpNow);
  toggle.addEventListener("click", () => setEnabled(!settings.enabled));
  restore.addEventListener("click", async () => {
    const name = list.querySelector("input:checked")?.value;
    if (!name || !currentView) return;
    const view = currentView;
    finish();
    await openBackup(view, name);
  });
  done.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
  draw();
  openDialog(dlg);
  done.focus();
}

// --- start-up ----------------------------------------------------------------
export function initBackup() {
  unsupported = unsupportedReason({ hasPicker: typeof window.showDirectoryPicker === "function", secure: window.isSecureContext === true });
  for (const el of document.querySelectorAll("[data-settings-open]")) el.addEventListener("click", () => openSettings(el));

  settings = loadSettings();
  if (unsupported) return;
  ready = loadHandle().then((h) => { handle = h; notify(); });
  document.addEventListener("connection:changed", (e) => {
    const v = e.detail ?? {};
    currentView = v.connected ? { host: v.host, port: v.port, user: v.user } : null;
    enqueue({ asap: true }); // workbook.js has just flushed its save, so `latest` is the workbook of the connection being left
    notify();
  });
  bus.addEventListener("workbook:saved", onSaved);
  bus.addEventListener("workbook:none-stored", onNoneStored);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") enqueue({ asap: true }); });
}
