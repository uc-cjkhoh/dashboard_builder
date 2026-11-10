import {
  entities, relationships, tabs, bus, currentView,
  createWorksheet, createDashboard, createStory, setSteps, updateSheet, setWidgets, setDashboardSize, setDashboardRange, setDashboardNotes, nextWidgetId, closeTab, showModel, switchTab, currentTheme, setTheme,
  nextCalcId, sharedFilters, setSharedFilters, fieldMeta, setAllFieldMeta, parameters, setParameters, hierarchies, setHierarchies, calculations, setCalculations,
} from "../Core/store.js";
import { clearRoleChoices } from "../Calc/calc-pane-model.js";
import { DEFAULT_THEME } from "../Core/theme-model.js";
import { openThemeDialog } from "./theme-dialog.js";
import { wireMenu } from "../Core/menu.js";
import { exit } from "../Core/motion.js";
import { toast, confirmDialog, listDialog } from "../Core/ui.js";
import { dateIn } from "../Core/timezone.js";
import { addEntity, clearModel } from "../Canvas/canvas.js";
import { restoreRelationship } from "../Relations/relations.js";
import { loadWorkbooks, saveWorkbooks } from "../Start/start-store.js";
import { rememberWorkbook, summarize } from "../Start/start-model.js";
import { serializeWorkbook, parseWorkbook, storageKey, legacyStorageKey, restoredSummary, issueCount } from "./workbook-model.js";
import { api } from "../Core/api.js";
import { catalogIssues, tablesNamed, columnKey } from "../Dashboard/missing-columns.js";

// Workbook: the whole builder state survives a reload. It auto-saves to this browser's storage —
// one workbook per connected server + user — and reopens on the next connect when the canvas is
// empty. Disconnecting clears the screen (the saved copy stays, so reconnecting to the same server
// brings it back). Export / Import move it as a JSON file. Never stores the connection or a password; there is
// still no server-side database (decision D21). Autosave writes the v2 key; with none yet, the v1 key (an older
// build's autosave) is read, migrated and left in place.
const SAVE_DELAY_MS = 500;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const CHANGE_EVENTS = [
  "entity:added", "entity:moved", "entity:removed",
  "rel:changed", "tabs:changed", "worksheet:changed", "dashboard:changed", "story:changed", "theme:changed", "fields:changed", "parameters:changed", "hierarchies:changed", "calculations:changed",
];

let view = null;       // the connected view (host, port, user) the key came from
let key = null;        // storage key for the connected server + user; null while disconnected
let legacyKey = null;  // the v1 key for the same server + user (read-only fallback)
let restoring = false; // no autosave while a workbook is being rebuilt
let timer = null;
let blockedKey = null; // a stored workbook that couldn't be restored — never autosave over it
let warned = ""; // the last not-saved warning shown (a toast once per cause, not on every autosave)

export function initWorkbook() {
  const fileInput = document.getElementById("wb-file");
  if (!fileInput) return;

  const settingsBtn = document.getElementById("settings-btn"), settingsList = document.getElementById("settings-list");
  if (settingsBtn && settingsList) wireMenu(settingsBtn, settingsList);

  document.addEventListener("connection:changed", (e) => onConnection(e.detail ?? {}));
  for (const type of CHANGE_EVENTS) bus.addEventListener(type, scheduleSave);

  bus.addEventListener("workbook:export", exportFile);
  document.getElementById("wb-theme")?.addEventListener("click", openThemeDialog);
  // The worksheet view bar's Import button asks for a file here (it has no handle on the picker).
  bus.addEventListener("workbook:import", () => {
    if (!key) { toast("Connect to ClickHouse first — a workbook opens against the connected server.", "info"); return; }
    fileInput.click();
  });
  fileInput.addEventListener("change", () => importFile(fileInput));
}

// --- autosave & restore ------------------------------------------------------
async function onConnection(v) {
  flushSave(); // finish saving under the previous server's key
  view = v;
  key = storageKey(view);
  legacyKey = legacyStorageKey(view);
  if (!key) { clearWorkspace(); return; }
  if (!isEmpty()) return;
  const saved = readStorage(key) ?? readStorage(legacyKey);
  if (!saved) return;
  let wb;
  try { wb = parseWorkbook(saved); } catch (err) { keepUnreadable(saved, err); return; }
  if (!wb.entities.length && !wb.tabs.length) return;
  const stillThere = key;
  await addCatalogIssues(wb); // the live columns are known now: a worksheet pill naming a missing one is reported
  if (key !== stillThere || !isEmpty()) return; // disconnected or started building while the catalog was read
  if (!openWorkbook(wb)) { blockedKey = key; return; } // partial state must not overwrite the stored entry
  const restored = restoredSummary(wb);
  if (wb.issues.length) {
    toast(`${restored} ${issueCount(wb.issues.length)} to review.`, "info");
    listDialog(`Restored your last workbook with ${issueCount(wb.issues.length)}`,
      wb.issues.slice(0, 20).concat(wb.issues.length > 20 ? [`…and ${wb.issues.length - 20} more.`] : []));
  } else toast(restored, "ok");
}

/** Disconnected: fade the cards and tabs out, then clear the model and close every tab.
 *  Nothing is saved meanwhile (key is null), so the stored workbook for that server is untouched. */
async function clearWorkspace() {
  warned = "";
  if (isEmpty()) return;
  const leaving = [...[...entities.values()].map((e) => e.el), ...document.querySelectorAll(".tab:not(.tab--model)")];
  await Promise.all(leaving.filter(Boolean).map((el) => exit(el, { y: 0, scale: .98 })));
  if (key) return; // reconnected while fading out — keep the workspace
  restoring = true;
  try {
    clearModel();
    for (const t of [...tabs]) closeTab(t.id);
    showModel();
    setTheme(DEFAULT_THEME); // the saved workbook keeps its theme; it comes back on reconnect
    setSharedFilters([]);
    setAllFieldMeta({});
    setParameters([]);
    setHierarchies([]);
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
    warnNotSaved("Not saved — your previous workbook couldn't be read and has been left untouched. Use Export to keep a copy.");
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
    warnNotSaved("Not saved — your previous workbook couldn't be read and has been left untouched. Use Export to keep a copy.");
    return;
  }
  try {
    const saved = serializeWorkbook(currentState());
    localStorage.setItem(key, JSON.stringify(saved));
    warned = "";
    saveWorkbooks(rememberWorkbook(loadWorkbooks(), view, summarize(saved), Date.now())); // start-screen metadata only
  } catch (e) {
    const full = e?.name === "QuotaExceededError" || e?.code === 22;
    warnNotSaved(full ? "Not saved — browser storage is full (pictures take the most room). Use Export to keep a copy." : "Not saved — browser storage is unavailable. Use Export to keep a copy.");
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
    for (const t of [...tabs]) closeTab(t.id);
    setSharedFilters(wb.sharedFilters ?? []); // before the tabs, so a worksheet's first query applies them
    setAllFieldMeta(wb.fields ?? {});
    setHierarchies(wb.hierarchies ?? []);
    setParameters(wb.parameters ?? []); // before the tabs, so a worksheet's first query reads them
    clearRoleChoices();
    setCalculations(wb.calculations ?? [], wb.nextCalcId); // likewise: pills read their calculation by id

    const ids = new Map(); // saved entity id → new entity id
    for (const e of wb.entities) ids.set(e.id, addEntity(e.db, e.table, e.x, e.y, { source: e.source }));
    for (const r of wb.relationships) {
      restoreRelationship(
        { entityId: ids.get(r.from.entityId), column: r.from.column },
        { entityId: ids.get(r.to.entityId), column: r.to.column },
        r.cardinality,
        r.joinType,
        r.joinFixed,
        r.pairs ?? [],
        { aggregate: r.aggregateFirst === true, direction: r.filterDirection },
      );
    }

    // Tabs in strip order; widgets point at worksheets by saved index, so those are wired once every tab exists.
    const worksheetIds = [], dashboardIds = [], storyIds = [];
    for (const t of wb.tabs) {
      if (t.kind === "worksheet") {
        const w = wb.worksheets[t.index];
        const tab = createWorksheet(w.name);
        updateSheet(tab.id, w.sheet);
        worksheetIds[t.index] = tab.id;
      } else if (t.kind === "story") storyIds[t.index] = createStory(wb.stories[t.index].name).id;
      else dashboardIds[t.index] = createDashboard(wb.dashboards[t.index].name).id;
    }
    wb.stories.forEach((s, i) => setSteps(storyIds[i], s.steps.map((x) => ({ caption: x.caption, target: (x.target.kind === "worksheet" ? worksheetIds : dashboardIds)[x.target.index] }))));
    wb.dashboards.forEach((d, i) => setWidgets(dashboardIds[i], d.widgets.map((w) => (w.kind === "sheet"
      ? { id: nextWidgetId(), kind: "sheet", sheetId: worksheetIds[w.sheet], ...(w.note ? { note: w.note } : {}), x: w.x, y: w.y, w: w.w, h: w.h }
      : w.kind === "image" ? { id: nextWidgetId(), kind: "image", alt: w.alt, src: w.src, x: w.x, y: w.y, w: w.w, h: w.h }
      : w.kind === "nav" ? { id: nextWidgetId(), kind: "nav", label: w.label, tip: w.tip, target: w.target ? (w.target.kind === "worksheet" ? worksheetIds : dashboardIds)[w.target.index] ?? null : null, x: w.x, y: w.y, w: w.w, h: w.h }
      : w.kind === "spacer" ? { id: nextWidgetId(), kind: "spacer", x: w.x, y: w.y, w: w.w, h: w.h }
      : { id: nextWidgetId(), kind: "text", heading: w.heading, body: w.body, x: w.x, y: w.y, w: w.w, h: w.h }))));
    wb.dashboards.forEach((d, i) => { if (d.size) setDashboardSize(dashboardIds[i], d.size); if (d.range) setDashboardRange(dashboardIds[i], d.range); if (d.notes) setDashboardNotes(dashboardIds[i], d.notes); });
    const activeId = wb.active ? (wb.active.kind === "worksheet" ? worksheetIds : wb.active.kind === "story" ? storyIds : dashboardIds)[wb.active.index] : null;
    if (activeId) switchTab(activeId);
    else showModel();
    setTheme(wb.theme ?? DEFAULT_THEME);
  } catch (err) {
    console.error(err);
    toast("Part of the workbook couldn't be opened — check the worksheets and dashboards.", "danger");
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
  a.download = `workbook-${dateIn(Date.now())}.json`;
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
      "Replace the current workbook? Its tables, relationships, worksheets, dashboards and stories will be removed.",
      { danger: true, confirmText: "Replace" },
    );
    if (!ok) return;
  }
  await addCatalogIssues(wb);
  if (openWorkbook(wb)) blockedKey = null; // a deliberate import replaces whatever was stored
  if (wb.issues.length) {
    await listDialog(`Opened ${file.name} with ${issueCount(wb.issues.length)}`,
      wb.issues.slice(0, 20).concat(wb.issues.length > 20 ? [`…and ${wb.issues.length - 20} more.`] : []));
  } else toast(`Opened ${file.name}.`, "ok");
}

// --- helpers -----------------------------------------------------------------
/** Reads the live columns of the tables the worksheets use and adds an issue for each pill naming a column that isn't there
 *  (the pill itself is marked and left out of its query by the worksheet). A table that can't be read adds nothing. */
async function addCatalogIssues(wb) {
  const real = new Set(wb.entities.filter((e) => !e.source).map((e) => columnKey(e.db, e.table)));
  const tables = tablesNamed(wb.worksheets).filter((t) => real.has(columnKey(t.db, t.table))).slice(0, 50);
  if (!tables.length) return;
  const catalog = new Map();
  await Promise.all(tables.map(async ({ db, table }) => {
    try { catalog.set(columnKey(db, table), new Set((await api.columns(db, table)).map((c) => c.name))); } catch { /* unreadable: nothing to report for it */ }
  }));
  wb.issues.push(...catalogIssues(wb.worksheets, catalog));
}

function currentState() {
  return { entities, relationships, tabs, active: currentView(), theme: currentTheme(), sharedFilters, fieldMeta, parameters, hierarchies, calculations, nextCalcId: nextCalcId() };
}

const isEmpty = () => entities.size === 0 && tabs.length === 0;

function warnNotSaved(text) {
  if (warned === text) return;
  warned = text;
  toast(text, "danger");
}
