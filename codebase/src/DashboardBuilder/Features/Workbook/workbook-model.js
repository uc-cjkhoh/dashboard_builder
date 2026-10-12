// Workbook save/load format — pure, DOM-free (unit-tested under tests/js/).
// A workbook is the whole builder state: the Data Model (tables + positions + join keys +
// relationships) and every dashboard's worksheet. It never contains the connection or a password —
// a workbook is reopened against whatever server the session is connected to.
import { emptySheet } from "../Core/store.js";

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
  if (copy.pages) delete copy.pages.members; // re-fetched from the bounded distinct query
  return copy;
}

/** JSON text → a validated workbook `{ entities, relationships, dashboards, active }`. Throws an
 *  Error with a user-facing message for anything that isn't a workbook this build can open.
 *  Malformed tables and links are dropped rather than failing the whole file. */
export function parseWorkbook(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error(NOT_A_WORKBOOK); }
  if (!raw || typeof raw !== "object" || raw.format !== WORKBOOK_FORMAT) throw new Error(NOT_A_WORKBOOK);
  if (!(raw.version <= WORKBOOK_VERSION))
    throw new Error("This workbook was saved by a newer version of Dashboard Builder.");

  const isStr = (v) => typeof v === "string" && v.length > 0;
  const num = (v) => (Number.isFinite(v) ? Math.max(0, v) : 0);

  const entities = (Array.isArray(raw.entities) ? raw.entities : [])
    .filter((e) => e && isStr(e.id) && isStr(e.db) && isStr(e.table))
    .map((e) => ({
      id: e.id, db: e.db, table: e.table, x: num(e.x), y: num(e.y),
      joinKeys: Array.isArray(e.joinKeys) ? e.joinKeys.filter(isStr) : [],
    }));
  const ids = new Set(entities.map((e) => e.id));
  const endpoint = (p) => p && ids.has(p.entityId) && isStr(p.column);

  const relationships = (Array.isArray(raw.relationships) ? raw.relationships : [])
    .filter((r) => r && endpoint(r.from) && endpoint(r.to) && CARDINALITIES.has(r.cardinality))
    .map((r) => ({
      from: { entityId: r.from.entityId, column: r.from.column },
      to: { entityId: r.to.entityId, column: r.to.column },
      cardinality: r.cardinality,
    }));

  const dashboards = (Array.isArray(raw.dashboards) ? raw.dashboards : [])
    .filter((d) => d && typeof d === "object")
    .map((d) => ({ name: isStr(d.name) ? d.name : "Dashboard", sheet: restoreSheet(d.sheet) }));

  const active = Number.isInteger(raw.active) && raw.active >= 0 && raw.active < dashboards.length ? raw.active : null;
  return { entities, relationships, dashboards, active };
}

/** A saved sheet merged over today's defaults, so workbooks from older builds gain new fields. */
export function restoreSheet(saved) {
  const base = emptySheet();
  const s = saved && typeof saved === "object" ? saved : {};
  const sheet = {
    ...base, ...s,
    marks: { ...base.marks, ...(s.marks ?? {}) },
    format: { ...base.format, ...(s.format ?? {}) },
  };
  for (const k of ["columns", "rows", "color", "filters"]) if (!Array.isArray(sheet[k])) sheet[k] = [];
  return sheet;
}

/** The browser-storage key for the session's server + user, or null while disconnected. */
export function storageKey(view) {
  if (!view?.connected) return null;
  return `dashboardbuilder.workbook.v${WORKBOOK_VERSION}|${view.host}|${view.port}|${view.user}`;
}
