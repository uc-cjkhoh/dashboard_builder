import {
  entities, relationships, dashboards, bus, activeDashboardId,
  createDashboard, updateSheet, closeDashboard, showModel, switchDashboard,
} from "../Core/store.js";
import { toast, confirmDialog, toggle, listDialog } from "../Core/ui.js";
import { addEntity, clearModel } from "../Canvas/canvas.js";
import { restoreRelationship } from "../Relations/relations.js";
import { serializeWorkbook, parseWorkbook, storageKey } from "./workbook-model.js";

// Workbook: the whole builder state survives a reload. It auto-saves to this browser's storage —
// one workbook per connected server + user — and reopens on the next connect when the canvas is
// empty. Export / Import move it as a JSON file. Never stores the connection or a password; there is
// still no server-side database (decision D21).
const SAVE_DELAY_MS = 500;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const CHANGE_EVENTS = [
  "entity:added", "entity:moved", "entity:removed", "joinkey:changed",
  "rel:changed", "tabs:changed", "dashboard:changed",
];

let key = null;        // storage key for the connected server + user; null while disconnected
let restoring = false; // no autosave while a workbook is being rebuilt
let timer = null;
let blockedKey = null; // a stored workbook that couldn't be restored — never autosave over it
let statusEl = null;

export function initWorkbook() {
  const exportBtn = document.getElementById("wb-export");
  const importBtn = document.getElementById("wb-import");
  const fileInput = document.getElementById("wb-file");
  statusEl = document.getElementById("wb-status");
  if (!exportBtn || !importBtn || !fileInput) return;

  document.addEventListener("connection:changed", (e) => onConnection(e.detail ?? {}));
  for (const type of CHANGE_EVENTS) bus.addEventListener(type, scheduleSave);

  exportBtn.addEventListener("click", exportFile);
  importBtn.addEventListener("click", () => {
    if (!key) { toast("Connect to ClickHouse first — a workbook opens against the connected server.", "info"); return; }
    fileInput.click();
  });
  fileInput.addEventListener("change", () => importFile(fileInput));
}

// --- autosave & restore ------------------------------------------------------
function onConnection(view) {
  flushSave(); // finish saving under the previous server's key
  key = storageKey(view);
  if (!key || !isEmpty()) return;
  const saved = readStorage(key);
  if (!saved) return;
  let wb;
  try { wb = parseWorkbook(saved); } catch (err) { keepUnreadable(saved, err); return; }
  if (!wb.entities.length && !wb.dashboards.length) return;
  if (!openWorkbook(wb)) { blockedKey = key; return; } // partial state must not overwrite the stored entry
  toast(`Restored your last workbook (${count(wb.entities.length, "table")}, ${count(wb.dashboards.length, "dashboard")}).`, "ok");
  if (wb.issues.length) toast(`Restored your last workbook — ${wb.issues.length} part(s) were reset.`, "info");
}

/** A saved workbook that can't be read: keep a backup copy if there is room; autosave is blocked only when no backup could be kept. */
function keepUnreadable(saved, err) {
  const prefix = `${key}:backup-`;
  let kept = false;
  try {
    for (let i = 0; i < localStorage.length && !kept; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix) && localStorage.getItem(k) === saved) kept = true; // identical backup already exists
    }
    if (!kept) { localStorage.setItem(`${prefix}${new Date().toISOString()}`, saved); kept = true; }
  } catch { /* storage full or blocked */ }
  const reason = String(err.message ?? "").replace(/\.$/, "");
  toast(kept
    ? `Couldn't restore your saved workbook: ${reason}. A backup copy was kept in this browser, and saving continues normally.`
    : `Couldn't restore your saved workbook: ${reason}. No backup copy could be kept, so the stored workbook was left untouched.`, "danger");
  if (!kept) {
    blockedKey = key; // no backup exists, so the unreadable entry is the only copy — never overwrite it
    setStatus("⚠ Not saved — your previous workbook couldn't be read and has been left untouched. Use Export to keep a copy.");
  }
}

function scheduleSave() {
  if (!key || restoring) return;
  clearTimeout(timer);
  timer = setTimeout(save, SAVE_DELAY_MS);
}

function flushSave() {
  if (timer) { clearTimeout(timer); timer = null; save(); }
}

function save() {
  timer = null;
  if (!key || restoring) return;
  if (key === blockedKey) {
    setStatus("⚠ Not saved — your previous workbook couldn't be read and has been left untouched. Use Export to keep a copy.");
    return;
  }
  try {
    localStorage.setItem(key, JSON.stringify(serializeWorkbook(currentState())));
    setStatus("✓ Saved in this browser");
  } catch {
    setStatus("⚠ Not saved — browser storage is unavailable. Use Export to keep a copy.");
  }
}

function readStorage(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

// --- open --------------------------------------------------------------------
/** Rebuilds the builder from a validated workbook. Returns false if part of it couldn't be opened. */
function openWorkbook(wb) {
  let ok = true;
  restoring = true;
  try {
    clearModel();
    for (const d of [...dashboards]) closeDashboard(d.id);

    const ids = new Map(); // saved entity id → new entity id
    for (const e of wb.entities) ids.set(e.id, addEntity(e.db, e.table, e.x, e.y, { joinKeys: e.joinKeys }));
    for (const r of wb.relationships) {
      restoreRelationship(
        { entityId: ids.get(r.from.entityId), column: r.from.column },
        { entityId: ids.get(r.to.entityId), column: r.to.column },
        r.cardinality,
      );
    }

    const opened = wb.dashboards.map((d) => {
      const dash = createDashboard(d.name);
      updateSheet(dash.id, d.sheet);
      return dash;
    });
    if (wb.active !== null && opened[wb.active]) switchDashboard(opened[wb.active].id);
    else showModel();
  } catch (err) {
    console.error(err);
    toast("Part of the workbook couldn't be opened — check the dashboards.", "danger");
    ok = false;
  } finally {
    restoring = false;
  }
  scheduleSave();
  return ok;
}

// --- export / import ---------------------------------------------------------
function exportFile() {
  if (isEmpty()) { toast("Nothing to export yet — add a table first.", "info"); return; }
  const json = JSON.stringify(serializeWorkbook(currentState()), null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `workbook-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function importFile(input) {
  const file = input.files?.[0];
  input.value = ""; // let the same file be picked again later
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) { toast("That file is too large to be a workbook.", "danger"); return; }
  let wb;
  try { wb = parseWorkbook(await file.text()); } catch (err) { toast(err.message, "danger"); return; }
  if (!isEmpty()) {
    const ok = await confirmDialog(
      "Replace the current workbook? Its tables, relationships and dashboards will be removed.",
      { danger: true, confirmText: "Replace" },
    );
    if (!ok) return;
  }
  if (openWorkbook(wb)) blockedKey = null; // a deliberate import replaces whatever was stored
  if (wb.issues.length) {
    await listDialog(`Opened ${file.name} with ${wb.issues.length} issue(s)`,
      wb.issues.slice(0, 20).concat(wb.issues.length > 20 ? [`…and ${wb.issues.length - 20} more.`] : []));
  } else toast(`Opened ${file.name}.`, "ok");
}

// --- helpers -----------------------------------------------------------------
function currentState() {
  const id = activeDashboardId();
  return { entities, relationships, dashboards, active: id ? { kind: "dashboard", id } : { kind: "model" } };
}

const isEmpty = () => entities.size === 0 && dashboards.length === 0;
const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function setStatus(text) {
  if (!statusEl) return;
  statusEl.textContent = text;
  toggle(statusEl, Boolean(text));
}
