// Pure rules for a union / unpivot used as a data source (no DOM). A source is an entity on the Data Source whose
// `source` says how to read it: { kind: "union", db, name, tables, columns? } or { kind: "unpivot", db, name, table, columns, keep }.
// The entity's `table` is the source's `name`, so every field reference (db, table, column) works unchanged; the plan adds the
// definition as `source` and the server reads it as a bounded derived table (ClickHouse/SourceSql.cs). Limits mirror the server
// (ApiLimits.MaxUnionTables / MaxUnpivotColumns / MaxUnpivotKeep / MaxSourceName, MaxRowsColumns); the server re-checks the catalog.
import { LIMITS } from "./validate.js";

export const SOURCE_KINDS = new Set(["union", "unpivot"]);
export const MAX_SOURCE_COLUMNS = 200; // server ApiLimits.MaxRowsColumns: shared columns one union exposes

export const MIXED_MESSAGE = "A union or unpivot can't be combined with another table yet — use only its own fields in this view.";
export const UNION_NOTE = "Columns shared by name and kind.";
/** The second note line of a card whose same-named columns were read as Float64 (`lossy`: the columns the server flagged), else null. */
export const lossyNote = (lossy) => (lossy?.length ? "Types differ: read as Float64, large values may round." : null);
export const unpivotNote = (n) => `Field and Value from ${n} columns.`;

const isStr = (v) => typeof v === "string" && v.trim() !== "";
const distinct = (a) => new Set(a).size === a.length;

/** The note one card shows under its head. */
export const sourceNote = (s) => (s.kind === "union" ? UNION_NOTE : unpivotNote(s.columns.length));

/** A name not in `taken`: `base`, then `base 2`, `base 3` …, cut so it fits LIMITS.sourceName. */
export function uniqueName(base, taken) {
  const used = new Set(taken);
  const fit = (n, suffix = "") => `${n.slice(0, LIMITS.sourceName - suffix.length)}${suffix}`;
  if (!used.has(fit(base))) return fit(base);
  for (let i = 2; ; i++) if (!used.has(fit(base, ` ${i}`))) return fit(base, ` ${i}`);
}

/** The union source for `tables` of `db`. Throws a sentence when it can't be one. */
export function unionSource(db, tables, taken = []) {
  if (tables.length < 2 || tables.length > LIMITS.unionTables) throw new Error(`A union needs between 2 and ${LIMITS.unionTables} tables.`);
  if (!distinct(tables)) throw new Error("Pick different tables.");
  return { kind: "union", db, name: uniqueName(`Union: ${tables.join(" + ")}`, taken), tables: [...tables] };
}

/** The unpivot source for `columns` of `table` (keeping `keep`). Throws a sentence when it can't be one. */
export function unpivotSource(db, table, columns, keep = [], taken = []) {
  if (columns.length < 2 || columns.length > LIMITS.unpivotColumns) throw new Error(`An unpivot needs between 2 and ${LIMITS.unpivotColumns} columns.`);
  if (keep.length > LIMITS.unpivotKeep) throw new Error(`An unpivot can keep at most ${LIMITS.unpivotKeep} columns.`);
  if (!distinct([...columns, ...keep])) throw new Error("Pick different columns for each role.");
  return { kind: "unpivot", db, name: uniqueName(`Unpivot: ${table}`, taken), table, columns: [...columns], keep: [...keep] };
}

/** What the server reads of a source (POST /api/query `source`, POST /api/source/columns): only the fields its kind uses. */
export function wireSource(s) {
  return s.kind === "union"
    ? { kind: "union", db: s.db, name: s.name, tables: [...s.tables], ...(s.columns?.length ? { columns: [...s.columns] } : {}) }
    : { kind: "unpivot", db: s.db, name: s.name, table: s.table, columns: [...s.columns], keep: [...(s.keep ?? [])] };
}

/** A saved source checked against the same rules (a workbook file may be edited by hand): the clean source, or null. */
export function cleanSource(raw, db, name) {
  if (!raw || typeof raw !== "object" || !SOURCE_KINDS.has(raw.kind) || raw.db !== db || raw.name !== name) return null;
  if (!isStr(name) || name.length > LIMITS.sourceName) return null; // the server refuses a longer name on every query
  const list = (v, min, max) => Array.isArray(v) && v.length >= min && v.length <= max && v.every(isStr) && distinct(v);
  if (raw.kind === "union") {
    if (!list(raw.tables, 2, LIMITS.unionTables)) return null;
    if (raw.columns !== undefined && !list(raw.columns, 0, MAX_SOURCE_COLUMNS)) return null;
    return { kind: "union", db, name, tables: [...raw.tables], ...(raw.columns?.length ? { columns: [...raw.columns] } : {}) };
  }
  const keep = raw.keep ?? [];
  if (!isStr(raw.table) || !list(raw.columns, 2, LIMITS.unpivotColumns) || !list(keep, 0, LIMITS.unpivotKeep) || !distinct([...raw.columns, ...keep])) return null;
  return { kind: "unpivot", db, name, table: raw.table, columns: [...raw.columns], keep: [...keep] };
}

/** The source an entity of (db, table) reads, or null for a catalog table. `entities` is the store's Map. */
export function sourceOfTable(entities, db, table) {
  for (const e of entities.values()) if (e.source && e.db === db && e.table === table) return e.source;
  return null;
}

/** The sentence that refuses a view reading a source together with another table, or null. `keys` are "db\0table" (sheet-plan keyOf). */
export function sourceProblem(keys, entities) {
  if (keys.length < 2) return null;
  const sources = new Set([...entities.values()].filter((e) => e.source).map((e) => `${e.db}\u0000${e.table}`));
  return keys.some((k) => sources.has(k)) ? MIXED_MESSAGE : null;
}

/** The /api/query plan for a source column's distinct members (a filter's member list): its groups, NULL left out by the caller. */
export function distinctPlan(source, column, limit) {
  const ref = { db: source.db, table: source.name, column };
  return { from: { db: source.db, table: source.name }, source: wireSource(source), joins: [], rowDimensions: [ref], columnDimensions: [], measures: [], filters: [], limit,
    sort: { column: "k0", desc: false } };
}

/** The members a distinctPlan result lists (text, non-null), in order. */
export const distinctMembers = (result) => (result?.rows ?? []).map((r) => r.keys[0]).filter((k) => k !== null && k !== undefined);

/** Names a new source must avoid in `db`: the database's tables (a real one of that name could be dragged on later) and the entities already on the canvas. */
export const takenNames = (entities, db, tables) => [...tables, ...[...entities.values()].filter((e) => e.db === db).map((e) => e.table)];
