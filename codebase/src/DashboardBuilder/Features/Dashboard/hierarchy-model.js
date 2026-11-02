// T03-29 named hierarchies — pure, DOM-free (tests/js/hierarchy-model.test.mjs). A workbook holds up to 20
// reusable hierarchies: { id: "hier<N>", name, levels: [{ db, table, column }, …] } — 2..LIMITS.drillLevels
// levels, all from ONE table (the same rule as a sheet's drill). Applying one to a sheet COPIES its levels into
// `sheet.drill = { levels, depth: 0, path: [] }` (the structure addDrillLevel builds), so the sheet keeps
// working if the hierarchy is later renamed, edited or deleted. Client-side only: the server never sees one.
import { LIMITS, text } from "../Core/validate.js";
import { REFUSAL, isCalcPill } from "../Calc/calc-pill.js";

export const CAST_REFUSAL = "A field with a type cast can't be a hierarchy level — clear its cast first.";
const ID = /^hier\d{1,6}$/;
const PART_MAX = 256;
const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error });
const isPart = (v) => typeof v === "string" && v.length > 0 && v.length <= PART_MAX;

export const hierarchyTableKey = (db, table) => `${db}.${table}`;

/** A hierarchy name: required, <= 60 characters, unique case-insensitively (`selfId` is the one being edited). */
export function checkHierarchyName(raw, hierarchies, selfId = null) {
  const n = text(raw, { label: "Name", max: LIMITS.hierarchyName, required: true });
  if (!n.ok) return n;
  const low = n.value.toLowerCase();
  if (hierarchies.some((h) => h.id !== selfId && h.name.toLowerCase() === low)) return fail("Another hierarchy has that name.");
  return n;
}

/** The levels of a hierarchy being saved: 2..6 plain, un-cast columns of one table, no repeats. Keeps only db/table/column. */
export function checkLevels(levels, { castOf = () => undefined } = {}) {
  if (!Array.isArray(levels) || levels.length < 2) return fail("A hierarchy needs at least 2 levels.");
  if (levels.length > LIMITS.drillLevels) return fail(`A hierarchy can have at most ${LIMITS.drillLevels} levels.`);
  const out = [];
  for (const l of levels) {
    if (isCalcPill(l)) return fail(REFUSAL);
    if (!l || !isPart(l.db) || !isPart(l.table) || !isPart(l.column)) return fail("A level needs a table and a column.");
    if (castOf({ db: l.db, table: l.table, column: l.column })) return fail(CAST_REFUSAL);
    if (out.length && (out[0].db !== l.db || out[0].table !== l.table)) return fail("Hierarchy levels must all come from one table.");
    if (out.some((x) => x.column === l.column)) return fail("A level can't repeat.");
    out.push({ db: l.db, table: l.table, column: l.column });
  }
  return ok(out);
}

/** A hierarchy being saved ({ name, levels }) against the workbook's list: { ok, value: { name, levels } } or { ok: false, error }. */
export function checkHierarchy(draft, hierarchies, selfId = null, opts = {}) {
  if (!selfId && hierarchies.length >= LIMITS.hierarchies) return fail(`A workbook can have at most ${LIMITS.hierarchies} hierarchies.`);
  const n = checkHierarchyName(draft?.name, hierarchies, selfId);
  if (!n.ok) return n;
  const l = checkLevels(draft?.levels, opts);
  if (!l.ok) return l;
  return ok({ name: n.value, levels: l.value });
}

/**
 * A saved `hierarchies` value → a clean list; problems go to `issues`. Absent (older workbooks) = [] with no issue.
 * `tables` (optional Set of "db.table") drops a hierarchy whose table isn't in the workbook.
 */
export function cleanHierarchies(raw, issues, { tables = null } = {}) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) { issues.push("The hierarchies weren't a list — none were opened."); return []; }
  const out = [], ids = new Set(), names = new Set();
  for (const r of raw.slice(0, LIMITS.hierarchies)) {
    if (!r || typeof r !== "object" || Array.isArray(r)) { issues.push("A hierarchy wasn't valid — skipped."); continue; }
    const label = typeof r.name === "string" && r.name.trim() ? `Hierarchy “${r.name.trim().slice(0, 60)}”` : "A hierarchy";
    if (typeof r.id !== "string" || !ID.test(r.id)) { issues.push(`${label} had no valid id — skipped.`); continue; }
    if (ids.has(r.id)) { issues.push(`${label} repeated an id — skipped.`); continue; }
    const name = text(r.name, { label: "Name", max: LIMITS.hierarchyName, required: true });
    if (!name.ok) { issues.push(`${label} had an invalid name — skipped.`); continue; }
    if (names.has(name.value.toLowerCase())) { issues.push(`${label} repeated a name — skipped.`); continue; }
    let levels = [];
    for (const l of Array.isArray(r.levels) ? r.levels : []) {
      if (isCalcPill(l)) { issues.push(`${label}: a calculated field can't be a level — removed.`); continue; }
      if (!l || typeof l !== "object" || !isPart(l.db) || !isPart(l.table) || !isPart(l.column)) { issues.push(`${label}: an invalid level was removed.`); continue; }
      if (levels.length && (levels[0].db !== l.db || levels[0].table !== l.table)) { issues.push(`${label}: a level from another table was removed.`); continue; }
      if (levels.some((x) => x.column === l.column)) { issues.push(`${label}: a repeated level was removed.`); continue; }
      levels.push({ db: l.db, table: l.table, column: l.column });
    }
    if (levels.length > LIMITS.drillLevels) { issues.push(`${label}: kept the first ${LIMITS.drillLevels} levels.`); levels = levels.slice(0, LIMITS.drillLevels); }
    if (levels.length < 2) { issues.push(`${label} had fewer than 2 usable levels — skipped.`); continue; }
    if (tables && !tables.has(hierarchyTableKey(levels[0].db, levels[0].table))) { issues.push(`${label}: its table ${levels[0].db}.${levels[0].table} isn't in this workbook — skipped.`); continue; }
    ids.add(r.id); names.add(name.value.toLowerCase());
    out.push({ id: r.id, name: name.value, levels });
  }
  if (raw.length > LIMITS.hierarchies) issues.push(`Only the first ${LIMITS.hierarchies} hierarchies were opened.`);
  return out;
}

/**
 * The sheet's drill for a hierarchy: { ok, drill: { levels, depth: 0, path: [] } } or { ok: false, error }.
 * `columns` is the table's column list ([{ name, category }]); a column that is gone, or has been cast since,
 * refuses. The levels are fresh objects (a copy), carrying each column's category like a dropped level.
 */
export function drillFromHierarchy(h, columns, castOf = () => undefined) {
  const levels = [];
  for (const l of h.levels) {
    const c = (columns ?? []).find((x) => x.name === l.column);
    if (!c) return fail(`“${h.name}” can't be used: column ${l.column} is no longer in ${l.table}.`);
    if (castOf({ db: l.db, table: l.table, column: l.column })) return fail(CAST_REFUSAL);
    levels.push({ db: l.db, table: l.table, column: l.column, category: c.category });
  }
  return { ok: true, drill: { levels, depth: 0, path: [] } };
}
