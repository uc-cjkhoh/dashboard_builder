// Calculated fields — resolver and compile seam (pure, DOM-free; tests/js/calc-resolve.test.mjs).
// Turns `[table.column]` / `[Name]` references into the parser's resolve() contract, and compiles a calculation
// (parse -> expand references -> check) into a tree the plan seam can use.
import { parseFormula } from "./calc-parser.js";
import { check } from "./calc-types.js";
import { expandCalcs, roleOfCalc } from "./calc-model.js";
import { groupTree } from "./group-model.js";

const USABLE = new Set(["numeric", "text", "temporal", "boolean"]);
const offered = (s) => typeof s === "string" && s !== "" && !/[.[\]]/.test(s);

/** Index of the store's entities: `{ categoryOf, tablesByName, fields, has }` (`fields`: every offered column with its category). Names with `.`, `[` or `]` are not offered. */
export function catalogFromEntities(entities) {
  const cats = new Map(); // "db\0table\0column" -> category
  const tablesByName = new Map();
  for (const e of entities ?? []) {
    if (!offered(e.db) || !offered(e.table)) continue;
    const full = `${e.db}.${e.table}`;
    const list = tablesByName.get(e.table) ?? [];
    if (!list.includes(full)) list.push(full);
    tablesByName.set(e.table, list);
    for (const c of e.columns ?? []) {
      if (offered(c.name)) cats.set(`${e.db}\0${e.table}\0${c.name}`, c.category ?? "other");
    }
  }
  const categoryOf = (db, table, column) => cats.get(`${db}\0${table}\0${column}`) ?? null;
  const fields = [...cats].map(([k, category]) => { const [db, table, column] = k.split("\0"); return { db, table, column, category }; });
  return { categoryOf, tablesByName, fields, has: (db, table, column) => cats.has(`${db}\0${table}\0${column}`) };
}

/** The `resolve(parts)` the parser takes (E8, E14). */
export function makeResolve(catalog, calcNames) {
  return (parts) => {
    if (parts.length === 1) return calcNames.has(parts[0]) ? { calc: { name: parts[0] } } : null;
    let db, table, column;
    if (parts.length === 2) {
      [table, column] = parts;
      const hits = catalog.tablesByName.get(table) ?? [];
      if (hits.length > 1) return { error: `${table}.${column} is in more than one database — write [db.table.column].` };
      db = hits.length === 1 ? hits[0].slice(0, hits[0].length - table.length - 1) : null;
    } else if (parts.length === 3) {
      [db, table, column] = parts;
    } else {
      return null;
    }
    const name = `${table}.${column}`;
    const category = db === null ? null : catalog.categoryOf(db, table, column);
    if (category === null) return { error: `${name} isn't in the model.` };
    if (!USABLE.has(category)) return { error: `${name} can't be used in a calculation.` };
    return { field: { db, table, column } };
  };
}

/**
 * Compiles one calculation against all `calcs` (`{ id, name, formula }`) and the catalog. Returns
 * `{ ast, info, role }` or `{ error: { message, pos? } }`. Syntax errors keep their position; unknown fields,
 * dangling references, cycles and type errors read `Calculation 'X' can't be computed: ...` (E15).
 */
export function compileCalculation(calc, calcs, catalog) {
  // The draft is registered only under its own current name: a saved copy of it (same id) is stale.
  const others = (calcs ?? []).filter((c) => c.id !== calc.id);
  const names = new Set(others.map((c) => c.name));
  names.add(calc.name);
  let resolverError = false;
  const base = makeResolve(catalog, names);
  const resolve = (parts) => {
    const r = base(parts);
    if (r && r.error) resolverError = true;
    return r;
  };
  const prefix = (message) => `Calculation '${calc.name}' can't be computed: ${message}`;
  const parse = (c) => {
    resolverError = false;
    if (c.group) return { ast: groupTree(c.group) }; // T02-30: a group field is a tree, never formula text
    if (typeof c.formula !== "string") return { error: { message: "Write a formula." } };
    const p = parseFormula(c.formula, resolve);
    return p.error && resolverError ? { error: { message: p.error.message, pos: p.error.pos, resolver: true } } : p;
  };

  const own = parse(calc);
  if (own.error) {
    const { resolver, ...e } = own.error;
    return { error: resolver ? { ...e, message: prefix(e.message) } : e };
  }
  const byName = new Map([[calc.name, { ast: own.ast }]]);
  const depErrors = new Map();
  for (const c of others) { // duplicate names: the first one wins
    if (byName.has(c.name)) continue;
    const p = parse(c);
    if (p.error) depErrors.set(c.name, p.error.message);
    else byName.set(c.name, { ast: p.ast });
  }
  const ex = expandCalcs(own.ast, byName);
  if (ex.error) {
    const m = /^Unknown calculation \[(.*)\]\.$/.exec(ex.error.message);
    const dep = m && depErrors.get(m[1]);
    return { error: { message: prefix(dep ? dep : ex.error.message) } };
  }
  const info = check(ex.ast, catalog.categoryOf);
  if (info.error) return { error: { message: prefix(info.error.message) } };
  return { ast: ex.ast, info, role: roleOfCalc(info) };
}

/** `"db.table"` strings the calculation reads (empty for a constant). */
export function calcTables(info) {
  return info && Array.isArray(info.tables) ? [...info.tables] : [];
}
