// Workbook save/load format — pure, DOM-free (unit-tested under tests/js/).
// A workbook is the whole builder state: the Data Model (tables + positions + join keys +
// relationships) and every dashboard's worksheet. It never contains the connection or a password —
// a workbook is reopened against whatever server the session is connected to.
import { emptySheet, defaultFormat } from "../Core/store.js";
import { LIMITS, text } from "../Core/validate.js";
import { aggsFor } from "../Dashboard/filter-rules.js";
import {
  CHART_TYPE_IDS, CATEGORIES, FILTER_OPS, NUMBER_FORMATS, DATE_FORMATS, LEGENDS, TOP_N, MAX_DECIMALS,
} from "../Core/sheet-schema.js";

export const WORKBOOK_FORMAT = "dashboard-builder-workbook";
export const WORKBOOK_VERSION = 1;
const CARDINALITIES = new Set(["1:1", "1:N", "N:1", "N:M"]);
const NOT_A_WORKBOOK = "This file is not a Dashboard Builder workbook.";

/** Builder state → a plain JSON-safe object. DOM nodes, fetched columns and lazily-loaded page
 *  members are left out (they are re-fetched on open). */
export function serializeWorkbook({ entities, relationships, dashboards, active }) {
  const activeIndex = active?.kind === "dashboard" ? dashboards.findIndex((d) => d.id === active.id) : -1;
  return {
    format: WORKBOOK_FORMAT,
    version: WORKBOOK_VERSION,
    savedAt: new Date().toISOString(),
    entities: [...entities.values()].map((e) => ({
      id: e.id, db: e.db, table: e.table, x: Math.round(e.x), y: Math.round(e.y),
      // Keys a just-opened workbook is still waiting to tick (columns loading, or a table that
      // failed to load) are kept, so saving early never loses them.
      joinKeys: [...new Set([...e.joinKeys, ...(e.pendingKeys ?? [])])],
    })),
    relationships: [...relationships.values()].map((r) => ({
      from: { entityId: r.from.entityId, column: r.from.column },
      to: { entityId: r.to.entityId, column: r.to.column },
      cardinality: r.cardinality,
    })),
    dashboards: dashboards.map((d) => ({ name: d.name, sheet: savedSheet(d.sheet) })),
    active: activeIndex >= 0 ? activeIndex : null,
  };
}

function savedSheet(sheet) {
  const copy = structuredClone(sheet);
  if (copy.pages) { delete copy.pages.members; delete copy.pages.loadError; delete copy.pages.more; } // re-fetched from the bounded distinct query
  return copy;
}

/** JSON text → a validated workbook `{ entities, relationships, dashboards, active, issues }`. Throws an
 *  Error with a user-facing message for anything that isn't a workbook this build can open.
 *  Malformed parts are dropped or reset, and each one is reported in `issues` (never silent). */
export function parseWorkbook(source) {
  let raw;
  try { raw = JSON.parse(source); } catch { throw new Error(NOT_A_WORKBOOK); }
  if (!raw || typeof raw !== "object" || raw.format !== WORKBOOK_FORMAT) throw new Error(NOT_A_WORKBOOK);
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1)
    throw new Error("This workbook file has no valid version number.");
  if (raw.version > WORKBOOK_VERSION)
    throw new Error("This workbook was saved by a newer version of Dashboard Builder.");

  const issues = [];
  const num = (v) => (Number.isFinite(v) ? Math.max(0, v) : 0);

  // entities: keep the first of each id and of each db.table; report the rest
  const seenIds = new Set(), seenTables = new Set();
  let skipped = 0;
  const entities = [];
  for (const e of Array.isArray(raw.entities) ? raw.entities : []) {
    if (!(e && isStr(e.id) && isStr(e.db) && isStr(e.table))) { skipped++; continue; }
    if (seenIds.has(e.id)) { issues.push(`Skipped a table with a duplicate id (${e.id}).`); continue; }
    if (seenTables.has(`${e.db}.${e.table}`)) { issues.push(`Skipped a second copy of ${e.db}.${e.table}.`); continue; }
    seenIds.add(e.id); seenTables.add(`${e.db}.${e.table}`);
    entities.push({
      id: e.id, db: e.db, table: e.table, x: num(e.x), y: num(e.y),
      joinKeys: Array.isArray(e.joinKeys) ? e.joinKeys.filter(isStr) : [],
    });
  }
  if (skipped) issues.push(`Skipped ${skipped} table(s) with missing details.`);
  const ids = new Set(entities.map((e) => e.id));
  const endpoint = (p) => p && ids.has(p.entityId) && isStr(p.column);

  const relList = Array.isArray(raw.relationships) ? raw.relationships : [];
  const relationships = relList
    .filter((r) => r && endpoint(r.from) && endpoint(r.to) && CARDINALITIES.has(r.cardinality))
    .map((r) => ({
      from: { entityId: r.from.entityId, column: r.from.column },
      to: { entityId: r.to.entityId, column: r.to.column },
      cardinality: r.cardinality,
    }));
  const droppedRels = relList.length - relationships.length;
  if (droppedRels > 0) issues.push(`Skipped ${droppedRels} relationship(s) that referenced missing tables or had an unknown cardinality.`);

  const list = (Array.isArray(raw.dashboards) ? raw.dashboards : []).filter((d) => d && typeof d === "object");
  if (list.length > LIMITS.dashboards) {
    issues.push(`Only the first ${LIMITS.dashboards} dashboards were opened.`);
    list.length = LIMITS.dashboards;
  }
  const dashboards = list.map((d) => {
    const r = text(d.name, { label: "Tab name", max: LIMITS.tabName, required: true });
    let name = "Dashboard";
    if (r.ok) name = r.value;
    else issues.push(`A dashboard name was reset to "Dashboard": ${r.error}`);
    return { name, sheet: sanitizeSheet(d.sheet, `Sheet "${name}"`, issues) };
  });

  const active = Number.isInteger(raw.active) && raw.active >= 0 && raw.active < dashboards.length ? raw.active : null;
  return { entities, relationships, dashboards, active, issues: [...new Set(issues)] };
}

const isStr = (v) => typeof v === "string" && v.length > 0;
const defAgg = (p) => (p.category === "numeric" ? "sum" : "count");

// `needCategory: false` is for filters: workbooks from older builds saved filters without a category,
// and the worksheet backfills it from the column catalog at runtime.
function cleanPill(raw, where, issues, needCategory = true) {
  const catOk = raw && (raw.category === undefined && !needCategory ? true : CATEGORIES.has(raw.category));
  if (!raw || typeof raw !== "object" || !isStr(raw.db) || !isStr(raw.table) || !isStr(raw.column) || !catOk) {
    issues.push(`${where}: skipped a field with missing details.`); return null;
  }
  const p = { ...raw };
  if (p.role !== undefined && p.role !== "dimension" && p.role !== "measure") delete p.role;
  if (p.agg !== undefined && p.category !== undefined && !aggsFor(p.category).includes(p.agg)) {
    issues.push(`${where}: ${p.table}.${p.column} can't use "${p.agg}" — reset to ${defAgg(p)}.`); p.agg = defAgg(p);
  }
  return p;
}
function cleanPills(list, where, issues, max = LIMITS.pillsPerShelf, needCategory = true) {
  if (list == null) return [];
  if (!Array.isArray(list)) { issues.push(`${where}: not a list — cleared.`); return []; }
  const out = list.map((p) => cleanPill(p, where, issues, needCategory)).filter(Boolean);
  if (out.length > max) { issues.push(`${where}: only the first ${max} fields were kept.`); out.length = max; }
  return out;
}
const oneOf = (set, v, fallback, where, what, issues) => {
  if (v === undefined || set.has(v)) return v ?? fallback;
  issues.push(`${where}: unknown ${what} "${v}" — reset.`); return fallback;
};

/** A saved worksheet validated field by field over today's defaults. Anything invalid is dropped or
 *  reset and described in `issues`. */
export function sanitizeSheet(saved, where, issues) {
  const base = emptySheet();
  const s = saved && typeof saved === "object" ? saved : {};
  const sheet = { ...base };
  sheet.chartType = s.chartType === undefined ? base.chartType : CHART_TYPE_IDS.has(s.chartType) ? s.chartType
    : (issues.push(`${where}: unknown chart type "${s.chartType}" — reset to Bar.`), "bar");
  for (const k of ["columns", "rows", "color"]) sheet[k] = cleanPills(s[k], `${where} ${k}`, issues);
  sheet.filters = cleanPills(s.filters, `${where} filters`, issues, LIMITS.filters, false).filter((f) => {
    const okShape = FILTER_OPS.has(f.op) && (f.op === "in" || f.op === "between"
      ? Array.isArray(f.values) && f.values.every((v) => typeof v === "string") : typeof (f.value ?? "") === "string");
    if (!okShape) issues.push(`${where}: skipped a filter on ${f.table}.${f.column} with an unknown operator or value.`);
    return okShape;
  });
  const m = s.marks && typeof s.marks === "object" ? s.marks : {};
  sheet.marks = { ...base.marks };
  for (const k of ["size", "label", "shape", "path", "angle"]) sheet.marks[k] = m[k] == null ? null : cleanPill(m[k], `${where} ${k}`, issues);
  for (const k of ["detail", "tooltip"]) sheet.marks[k] = cleanPills(m[k], `${where} ${k}`, issues);
  sheet.sort = s.sort == null ? null : isStr(s.sort.by) && (s.sort.dir === "asc" || s.sort.dir === "desc") ? { by: s.sort.by, dir: s.sort.dir }
    : (issues.push(`${where}: sort cleared.`), null);
  sheet.selection = null; // transient click selection — never restored
  sheet.drill = cleanDrill(s.drill, where, issues);
  sheet.pages = s.pages == null ? null
    : cleanPill(s.pages, `${where} pages`, issues) && Number.isInteger(s.pages.index) && s.pages.index >= 0
      ? { db: s.pages.db, table: s.pages.table, column: s.pages.column, category: s.pages.category, index: s.pages.index }
      : (issues.push(`${where}: pages cleared.`), null);
  sheet.format = cleanFormat(s.format, where, issues);
  return sheet;
}

function cleanDrill(d, where, issues) {
  if (d == null) return null;
  if (typeof d !== "object") { issues.push(`${where}: drill cleared.`); return null; }
  let levels = Array.isArray(d.levels) ? d.levels.map((p) => cleanPill(p, `${where} drill`, issues)).filter(Boolean) : [];
  if (levels.length > LIMITS.drillLevels) {
    issues.push(`${where}: drill kept the first ${LIMITS.drillLevels} levels.`);
    levels = levels.slice(0, LIMITS.drillLevels);
  }
  const okDepth = Number.isInteger(d.depth) && d.depth >= 0 && d.depth < levels.length;
  const okPath = okDepth && Array.isArray(d.path) && d.path.length === d.depth && d.path.every((x) => x && isStr(x.column));
  if (levels.length < 2 || !okPath) { issues.push(`${where}: drill cleared.`); return null; }
  return { levels, depth: d.depth, path: d.path.map((x) => ({ column: x.column, value: x.value ?? null, label: String(x.label ?? "") })) };
}

function cleanFormat(f0, where, issues) {
  const base = defaultFormat();
  const f = f0 && typeof f0 === "object" ? f0 : {};
  const w = `${where} format`;
  const out = { ...base };
  out.numberFormat = oneOf(NUMBER_FORMATS, f.numberFormat, base.numberFormat, w, "number format", issues);
  out.dateFormat = oneOf(DATE_FORMATS, f.dateFormat, base.dateFormat, w, "date format", issues);
  out.legend = oneOf(LEGENDS, f.legend, base.legend, w, "legend position", issues);
  out.decimals = f.decimals == null ? null : Number.isInteger(f.decimals) && f.decimals >= 0 && f.decimals <= MAX_DECIMALS ? f.decimals
    : (issues.push(`${w}: decimals "${f.decimals}" — reset to Auto.`), null);
  out.topN = f.topN == null ? null : TOP_N.has(f.topN) ? f.topN : (issues.push(`${w}: Top N "${f.topN}" — reset to All.`), null);
  for (const k of ["dataLabels", "colorByDimension"]) out[k] = f[k] === undefined ? base[k] : Boolean(f[k]);
  out.currencySymbol = typeof f.currencySymbol === "string" && f.currencySymbol.length <= 8 ? f.currencySymbol : base.currencySymbol;
  for (const k of ["xTitle", "yTitle"]) {
    const r = f[k] == null ? null : text(f[k], { label: "Axis title", max: LIMITS.axisTitle });
    out[k] = r === null ? null : r.ok ? r.value || null : (issues.push(`${w}: ${r.error} — cleared.`), null);
  }
  return out;
}

/** A saved sheet merged over today's defaults, so workbooks from older builds gain new fields. */
export const restoreSheet = (saved) => sanitizeSheet(saved, "Sheet", []);

/** The browser-storage key for the session's server + user, or null while disconnected. */
export function storageKey(view) {
  if (!view?.connected) return null;
  return `dashboardbuilder.workbook.v${WORKBOOK_VERSION}|${view.host}|${view.port}|${view.user}`;
}
