import { isCalcPill, pillSlots } from "../Calc/calc-pill.js";

// A pill can name a column the table no longer has (a workbook edited by hand, or a table that changed). Pure and
// DOM-free (tests/js/missing-columns.test.mjs). The Data Source's loaded catalog (entity.columns) decides: a table
// whose columns haven't loaded yet, or that isn't in the model, is "unknown" and never reported.

export const columnKey = (db, table) => `${db}\u0000${table}`;

/** "ok" | "missing" | "unknown" for one column, read from the model's entities (a Map or an array of { db, table, columns }). */
export function columnState(entities, db, table, column) {
  for (const e of entities.values ? entities.values() : entities) {
    if (e.db !== db || e.table !== table) continue;
    if (!e.columns?.length) continue;
    return e.columns.some((c) => c.name === column) ? "ok" : "missing";
  }
  return "unknown";
}

/** Every pill of a sheet that names a table column: shelves, Colour, marks, filters, period, pages and drill levels. */
function* slots(sheet) {
  yield* pillSlots(sheet);
  for (const f of sheet.filters ?? []) yield f;
  if (sheet.period) yield sheet.period;
  if (sheet.pages) yield sheet.pages;
  for (const f of sheet.drill?.levels ?? []) yield f;
}

const named = (f) => f && !isCalcPill(f) && typeof f.db === "string" && f.db && typeof f.table === "string" && f.table && typeof f.column === "string" && f.column;

/** The one-line reason, used by the pill tooltip, the notice and the import summary. */
export const missingMessage = (f) => `${f.table}.${f.column} isn't in ${f.db}.${f.table} — left out.`;

/** Missing columns of a sheet, each once, as `{ db, table, column }`. `stateOf(db, table, column)` answers ok/missing/unknown. */
function findMissing(sheet, stateOf) {
  const out = [], seen = new Set();
  for (const f of slots(sheet)) {
    if (!named(f) || stateOf(f.db, f.table, f.column) !== "missing") continue;
    const k = `${f.db}.${f.table}.${f.column}`;
    if (!seen.has(k)) { seen.add(k); out.push({ db: f.db, table: f.table, column: f.column }); }
  }
  return out;
}

export const missingIn = (sheet, entities) => findMissing(sheet, (db, table, column) => columnState(entities, db, table, column));

/** True when this pill's column is known to be gone (for marking it on screen). */
export const isMissingPill = (f, entities) => Boolean(named(f)) && columnState(entities, f.db, f.table, f.column) === "missing";

/** A copy of the sheet without its missing pills (what the query and the chart use), plus what was left out.
 *  Nothing missing → the same sheet object. The saved sheet is never changed. */
export function pruneMissing(sheet, entities) {
  const gone = (f) => isMissingPill(f, entities);
  const missing = [];
  for (const f of slots(sheet)) if (gone(f)) missing.push(f);
  if (!missing.length) return { sheet, missing: [] };
  const keep = (list) => (list ?? []).filter((f) => !gone(f));
  const out = { ...sheet, rows: keep(sheet.rows), columns: keep(sheet.columns), color: keep(sheet.color), filters: keep(sheet.filters) };
  if (sheet.marks) {
    const m = { ...sheet.marks };
    for (const k of ["size", "label", "shape", "path", "angle"]) if (gone(m[k])) m[k] = null;
    for (const k of ["detail", "tooltip"]) if (m[k]) m[k] = keep(m[k]);
    out.marks = m;
  }
  if (gone(sheet.period)) out.period = null;
  if (gone(sheet.pages)) out.pages = null;
  if (sheet.drill?.levels) out.drill = { ...sheet.drill, levels: keep(sheet.drill.levels) };
  return { sheet: out, missing: findMissing(sheet, (db, table, column) => columnState(entities, db, table, column)) };
}

/** Import / restore summary lines. `catalog`: Map of columnKey(db, table) → Set of column names for tables whose columns were read. */
export function catalogIssues(worksheets, catalog, where = (w) => `Sheet "${w.name}"`) {
  const out = [];
  const stateOf = (db, table, column) => { const s = catalog.get(columnKey(db, table)); return s ? (s.has(column) ? "ok" : "missing") : "unknown"; };
  for (const w of worksheets) for (const m of findMissing(w.sheet, stateOf)) out.push(`${where(w)}: ${missingMessage(m)}`);
  return out;
}

/** The distinct real tables a list of worksheets names (db, table), to read their columns once. */
export function tablesNamed(worksheets) {
  const out = new Map();
  for (const w of worksheets) for (const f of slots(w.sheet)) if (named(f)) out.set(columnKey(f.db, f.table), { db: f.db, table: f.table });
  return [...out.values()];
}

/** Reads the columns of `tables` with `read(db, table)`, giving up after `ms` (a slow or never-answering read adds nothing).
 *  Resolves to the catalog Map for catalogIssues; it never rejects. */
export async function readCatalog(tables, read, ms = 5000) {
  const catalog = new Map();
  const one = async ({ db, table }) => {
    try { catalog.set(columnKey(db, table), new Set((await read(db, table)).map((c) => c.name))); } catch { /* unreadable: nothing to report for it */ }
  };
  let timer;
  await Promise.race([Promise.all(tables.map(one)), new Promise((r) => { timer = setTimeout(r, ms); })]);
  clearTimeout(timer);
  return new Map(catalog);
}
