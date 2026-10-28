import {
  entities, relationships, dashboards, bus, activeDashboardId,
  createDashboard, updateSheet, closeDashboard, showModel, switchDashboard, currentTheme, setTheme,
  nextCalcId, sharedFilters, setSharedFilters, bookmarks, setBookmarks, fieldMeta, setAllFieldMeta, parameters, setParameters, calculations, setCalculations,
} from "../Core/store.js";
import { clearRoleChoices } from "../Calc/calc-pane-model.js";
import { DEFAULT_THEME } from "../Core/theme-model.js";
import { openThemeDialog } from "./theme-dialog.js";
import { saveBookmarkDialog, openBookmarksDialog } from "./bookmarks-dialog.js";
import { openParametersDialog } from "./parameters-dialog.js";
import { icon } from "../Core/icons.js";
import { wireMenu } from "../Core/menu.js";
import { exit } from "../Core/motion.js";
import { toast, confirmDialog, toggle, listDialog } from "../Core/ui.js";
import { addEntity, clearModel } from "../Canvas/canvas.js";
import { restoreRelationship } from "../Relations/relations.js";
import { serializeWorkbook, parseWorkbook, storageKey } from "./workbook-model.js";

// Workbook: the whole builder state survives a reload. It auto-saves to this browser's storage —
// one workbook per connected server + user — and reopens on the next connect when the canvas is
// empty. Disconnecting clears the screen (the saved copy stays, so reconnecting to the same server
// brings it back). Export / Import move it as a JSON file. Never stores the connection or a password; there is
// still no server-side database (decision D21).
const SAVE_DELAY_MS = 500;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const CHANGE_EVENTS = [
  "entity:added", "entity:moved", "entity:removed", "joinkey:changed",
  "rel:changed", "tabs:changed", "dashboard:changed", "theme:changed", "bookmarks:changed", "fields:changed", "parameters:changed", "calculations:changed",
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

  const menuBtn = document.getElementById("wb-menu-btn"), menuList = document.getElementById("wb-menu-list");
  if (menuBtn && menuList) wireMenu(menuBtn, menuList);

  document.addEventListener("connection:changed", (e) => onConnection(e.detail ?? {}));
  for (const type of CHANGE_EVENTS) bus.addEventListener(type, scheduleSave);

  exportBtn.addEventListener("click", exportFile);
  document.getElementById("wb-theme")?.addEventListener("click", openThemeDialog);
  document.getElementById("wb-bookmark-add")?.addEventListener("click", saveBookmarkDialog);
  document.getElementById("wb-bookmarks")?.addEventListener("click", openBookmarksDialog);
  document.getElementById("wb-parameters")?.addEventListener("click", openParametersDialog);
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
  if (!key) { clearWorkspace(); return; }
  if (!isEmpty()) return;
  const saved = readStorage(key);
  if (!saved) return;
  let wb;
  try { wb = parseWorkbook(saved); } catch (err) { keepUnreadable(saved, err); return; }
  if (!wb.entities.length && !wb.dashboards.length) return;
  if (!openWorkbook(wb)) { blockedKey = key; return; } // partial state must not overwrite the stored entry
  const restored = `Restored your last workbook (${count(wb.entities.length, "table")}, ${count(wb.dashboards.length, "dashboard")}).`;
  if (wb.issues.length) {
    toast(`${restored} ${wb.issues.length} part(s) were reset.`, "info");
    listDialog(`Restored your last workbook with ${wb.issues.length} issue(s)`,
      wb.issues.slice(0, 20).concat(wb.issues.length > 20 ? [`…and ${wb.issues.length - 20} more.`] : []));
  } else toast(restored, "ok");
}

/** Disconnected: fade the cards and dashboard tabs out, then clear the model and close every dashboard.
 *  Nothing is saved meanwhile (key is null), so the stored workbook for that server is untouched. */
async function clearWorkspace() {
  setStatus("");
  if (isEmpty()) return;
  const leaving = [...[...entities.values()].map((e) => e.el), ...document.querySelectorAll(".tab:not(.tab--model)")];
  await Promise.all(leaving.filter(Boolean).map((el) => exit(el, { y: 0, scale: .98 })));
  if (key) return; // reconnected while fading out — keep the workspace
  restoring = true;
  try {
    clearModel();
    for (const d of [...dashboards]) closeDashboard(d.id);
    showModel();
    setTheme(DEFAULT_THEME); // the saved workbook keeps its theme; it comes back on reconnect
    setSharedFilters([]);
    setBookmarks([]);
    setAllFieldMeta({});
    setParameters([]);
    setCalculations([]);
    clearRoleChoices();
  } finally {
    restoring = false;
  }
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
    setStatus("Not saved — your previous workbook couldn't be read and has been left untouched. Use Export to keep a copy.", "warning");
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
    setStatus("Not saved — your previous workbook couldn't be read and has been left untouched. Use Export to keep a copy.", "warning");
    return;
  }
  try {
    localStorage.setItem(key, JSON.stringify(serializeWorkbook(currentState())));
    setStatus("Saved");
  } catch {
    setStatus("Not saved — browser storage is unavailable. Use Export to keep a copy.", "warning");
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
    setSharedFilters(wb.sharedFilters ?? []); // before the dashboards, so their first query applies them
    setAllFieldMeta(wb.fields ?? {});
    setParameters(wb.parameters ?? []); // before the dashboards, so their first query reads them
    clearRoleChoices();
    setCalculations(wb.calculations ?? [], wb.nextCalcId); // likewise: pills read their calculation by id

    const ids = new Map(); // saved entity id → new entity id
    for (const e of wb.entities) ids.set(e.id, addEntity(e.db, e.table, e.x, e.y, { joinKeys: e.joinKeys }));
    for (const r of wb.relationships) {
      restoreRelationship(
        { entityId: ids.get(r.from.entityId), column: r.from.column },
        { entityId: ids.get(r.to.entityId), column: r.to.column },
        r.cardinality,
        r.joinType,
        r.joinFixed,
      );
    }

    const opened = wb.dashboards.map((d) => {
      const dash = createDashboard(d.name);
      updateSheet(dash.id, d.sheet);
      return dash;
    });
    // P39: bookmarks point at their dashboard by index; a missing one is recreated when applied.
    setBookmarks((wb.bookmarks ?? []).map((b) => ({ ...b, dashId: b.dashboard !== null ? opened[b.dashboard]?.id ?? null : null })));
    if (wb.active !== null && opened[wb.active]) switchDashboard(opened[wb.active].id);
    else showModel();
    setTheme(wb.theme ?? DEFAULT_THEME);
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
  return { entities, relationships, dashboards, active: id ? { kind: "dashboard", id } : { kind: "model" }, theme: currentTheme(), sharedFilters, bookmarks, fieldMeta, parameters, calculations, nextCalcId: nextCalcId() };
}

const isEmpty = () => entities.size === 0 && dashboards.length === 0;
const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function setStatus(text, iconName) {
  if (!statusEl) return;
  statusEl.classList.toggle("workbook__status--warn", iconName === "warning");
  statusEl.replaceChildren(...(text && iconName ? [icon(iconName, { size: 14 }), " "] : []), text);
  toggle(statusEl, Boolean(text));
}
