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

// --- Custom SQL on a card (D105) --------------------------------------------------------------------------------------------
// Unlike a union / unpivot, a card with custom SQL stays an ordinary table card (it can be related and joined): `entity.customSql` is the
// SELECT text, the card's columns are what that query returns, and every query that reads the table also carries `sources: [{ kind: "sql",
// db, name: table, sql }]` so the server reads the derived table instead of the catalog table of that name. The single-table reads (View data,
// column profile, histogram, Check this join) carry the same entry as `source` (or `from.source` / `to.source`) for the table they read.
export const SQL_NOTE = "Custom SQL";

const quoteName = (n) => `\`${n.replace(/[\\`]/g, "\\$&")}\``;

/** The SELECT a card starts from: every column, one per line (a card still loading says `*`). */
export function defaultSql(db, table, columns = []) {
  const list = columns.length ? columns.map((c) => `  ${quoteName(c.name)}`).join(",\n") : "  *";
  return `SELECT\n${list}\nFROM ${quoteName(db)}.${quoteName(table)}`;
}

/** A sentence when `sql` can't be saved (the server re-checks everything and explains the rest), else null. */
export function sqlProblem(sql) {
  if (typeof sql !== "string" || !sql.trim()) return "Write a SELECT query.";
  if (sql.length > LIMITS.customSql) return `The query can be at most ${LIMITS.customSql.toLocaleString("en-US")} characters.`;
  return null;
}

/** What the server reads of one card's custom SQL (an entry of /api/query `sources`, or the body of /api/source/columns). */
export const sqlWire = (db, table, sql) => ({ kind: "sql", db, name: table, sql });

/** The custom SQL of the card showing (db, table), or null. `entities` is the store's Map. */
export function customSqlOf(entities, db, table) {
  for (const e of entities.values()) if (e.customSql && e.db === db && e.table === table) return e.customSql;
  return null;
}

/** The `sources` of a query that reads these `tables` ({ db, table }): one entry per table whose card has custom SQL; [] when none. */
export function sqlSourcesFor(entities, tables) {
  const seen = new Set(), out = [];
  for (const t of tables) {
    const k = `${t.db}\u0000${t.table}`, sql = customSqlOf(entities, t.db, t.table);
    if (sql && !seen.has(k)) { seen.add(k); out.push(sqlWire(t.db, t.table, sql)); }
  }
  return out;
}

/** A saved custom SQL, or null when it isn't text of an allowed length (a workbook file may be edited by hand; the server checks the rest). */
export const cleanCustomSql = (raw) => (typeof raw === "string" && raw.trim() && raw.length <= LIMITS.customSql ? raw : null);

/** The key columns a relationship needs that `columns` (what a new query returns) no longer has: [] when every one is still there.
 *  `needed` is the column names the card's relationships use. */
export const lostKeys = (needed, columns) => [...new Set(needed)].filter((n) => !columns.some((c) => c.name === n));

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

/** The same one-dimension query for a column of a card with custom SQL (D105): the table is read through `sources`, not `source`. */
export function distinctPlanSql(db, table, sql, column, limit) {
  const ref = { db, table, column };
  return { from: { db, table }, sources: [sqlWire(db, table, sql)], joins: [], rowDimensions: [ref], columnDimensions: [], measures: [], filters: [], limit,
    sort: { column: "k0", desc: false } };
}

/** The members a distinctPlan result lists (text, non-null), in order. */
export const distinctMembers = (result) => (result?.rows ?? []).map((r) => r.keys[0]).filter((k) => k !== null && k !== undefined);

/** What a union leaves out, from each table's columns ({ table, columns: [{name, type, category}] }, in order): the same rule the server
 *  applies (a column is kept when every table has it under one kind). `missing`: columns some tables lack; `kind`: columns every table
 *  has but of unlike kinds; `shared`: the names kept. Read-only; it only reads the catalog columns the card already can fetch. */
export function unionMismatch(tables) {
  const names = [...new Set(tables.flatMap((t) => t.columns.map((c) => c.name)))];
  const missing = [], kind = [], shared = [];
  for (const name of names) {
    const found = tables.map((t) => ({ table: t.table, col: t.columns.find((c) => c.name === name) }));
    const have = found.filter((f) => f.col);
    if (have.length < tables.length) missing.push({ column: name, in: have.map((f) => f.table), notIn: found.filter((f) => !f.col).map((f) => f.table) });
    else if (new Set(have.map((f) => f.col.category)).size > 1) kind.push({ column: name, kinds: Object.fromEntries(have.map((f) => [f.table, f.col.category])) });
    else shared.push(name);
  }
  return { missing, kind, shared };
}

/** One sentence over a unionMismatch result. */
export function mismatchSummary(m) {
  const n = m.missing.length + m.kind.length;
  if (!n) return "Every column is in all tables.";
  return `${n} column${n === 1 ? " is" : "s are"} left out: ${m.missing.length} not in every table, ${m.kind.length} of unlike kinds.`;
}
