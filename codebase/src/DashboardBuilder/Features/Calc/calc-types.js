// Calculated fields — the type checker (pure, DOM-free; tests/js/calc-cases.test.mjs).
// A line-for-line twin of ClickHouse/Calc/CalcCatalog.cs + CalcValidator.cs: the same function table, the same
// messages, the same error paths, the same check order. The shared fixture tests/fixtures/calc-cases.json is
// the contract — change one side and the other in the same commit.

/** Calculation limits; mirrored in ClickHouse/Calc/CalcLimits (and the workbook ones in Core/validate.js LIMITS). */
export const CALC_LIMITS = Object.freeze({ formula: 500, depth: 12, nodes: 200, calcs: 20, name: 60, string: 100 });

const NUMBER_ONLY = ["number"];
const ORDERABLE = ["number", "date", "text"];
const ANYTHING = ["number", "date", "text", "boolean"];

/** The function table — the only place a function exists on the client. `accepts` is in display order;
 *  `result: null` means "the same type as the argument". Names are the lowercase wire names. */
export const FUNCTIONS = Object.freeze({
  sum: { accepts: NUMBER_ONLY, result: "number" },
  avg: { accepts: NUMBER_ONLY, result: "number" },
  min: { accepts: ORDERABLE, result: null },
  max: { accepts: ORDERABLE, result: null },
  count: { accepts: ANYTHING, result: "number" },
  countd: { accepts: ANYTHING, result: "number" },
});

// Catalog category (ClickHouseType) -> calculation type; any other category can't be used.
const TYPE_OF_CATEGORY = new Map([["numeric", "number"], ["text", "text"], ["temporal", "date"], ["boolean", "boolean"]]);

class CalcError extends Error {
  constructor(message, path) { super(message); this.path = path; }
}

const isNode = (n) => n !== null && typeof n === "object";
const child = (path, name) => (path.length === 0 ? name : `${path}.${name}`);

// Pre-order walk, root at depth 1 (same order as CalcValidator.CheckLimits).
function checkLimits(root) {
  let nodes = 0;
  const walk = (n, depth) => {
    if (depth > CALC_LIMITS.depth) throw new CalcError("That formula is too deep.", "");
    if (++nodes > CALC_LIMITS.nodes) throw new CalcError("That formula is too large.", "");
    if (!isNode(n)) return;
    if (n.k === "un" || n.k === "agg") walk(n.arg, depth + 1);
    else if (n.k === "bin" || n.k === "cmp" || n.k === "logic" || n.k === "ifnull") { walk(n.l, depth + 1); walk(n.r, depth + 1); }
    else if (n.k === "not" || n.k === "isnull") walk(n.arg, depth + 1);
    else if (n.k === "case" && Array.isArray(n.whens)) {
      for (const w of n.whens) if (isNode(w)) { walk(w.c, depth + 1); walk(w.t, depth + 1); }
      if (n.else !== undefined) walk(n.else, depth + 1);
    }
  };
  walk(root, 1);
}

const describe = (accepts) => (accepts.length === 1
  ? `a ${accepts[0]}`
  : `a ${accepts.slice(0, -1).join(", ")} or ${accepts[accepts.length - 1]}`);

const requireNumber = (t, path) => {
  if (t.type !== "number") throw new CalcError(`Arithmetic needs numbers — ${t.name} is ${t.type}.`, path);
};

const SAME_TYPE = "All results must be the same type";
// Aggregates and row-level values (constants are neutral) can't share one formula.
const mixes = (parts) => parts.some((t) => t.isAggregate) && parts.some((t) => !t.isAggregate && !t.isConst);
const MIX = "Can't mix an aggregate with a row-level value in one formula.";
const unionTables = (parts) => { const out = new Set(); for (const t of parts) for (const x of t.tables) out.add(x); return out; };
const requireBoolean = (t, path, what) => {
  if (t.type !== "boolean") throw new CalcError(`${what} needs ${what === "AND" || what === "OR" ? "booleans" : "a boolean"} — ${t.name} is ${t.type}.`, path);
};

// const: a number literal (or arithmetic over only literals) — it carries no field and no aggregate.
function typeOf(node, path, categoryOf) {
  if (!isNode(node)) throw new CalcError("Unknown expression node.", path);
  switch (node.k) {
    case "num":
      if (!Number.isFinite(node.v)) throw new CalcError("That number is out of range.", path);
      return { type: "number", isAggregate: false, isConst: true, tables: new Set(), name: "that value" };

    case "str":
      if (typeof node.v !== "string") throw new CalcError("Unknown expression node.", path);
      if (node.v.length > CALC_LIMITS.string) throw new CalcError(`A text value can be at most ${CALC_LIMITS.string} characters.`, path);
      return { type: "text", isAggregate: false, isConst: true, tables: new Set(), name: "that value" };

    case "cmp": {
      if (!["=", "!=", "<", "<=", ">", ">="].includes(node.op)) throw new CalcError(`Unknown operator ${node.op}.`, path);
      const l = typeOf(node.l, child(path, "l"), categoryOf);
      const r = typeOf(node.r, child(path, "r"), categoryOf);
      for (const [t, p] of [[l, "l"], [r, "r"]]) {
        if (t.type === "boolean") throw new CalcError(`Comparison needs a number, text or date — ${t.name} is boolean.`, child(path, p));
      }
      if (l.type !== r.type) {
        throw new CalcError(`Comparison needs two values of the same type — ${l.name} is ${l.type}, ${r.name} is ${r.type}.`, path);
      }
      if (mixes([l, r])) throw new CalcError(MIX, path);
      return { type: "boolean", isAggregate: l.isAggregate || r.isAggregate, isConst: l.isConst && r.isConst, tables: unionTables([l, r]), name: "that value" };
    }

    case "logic": {
      if (node.op !== "and" && node.op !== "or") throw new CalcError(`Unknown operator ${node.op}.`, path);
      const l = typeOf(node.l, child(path, "l"), categoryOf);
      const r = typeOf(node.r, child(path, "r"), categoryOf);
      requireBoolean(l, child(path, "l"), node.op.toUpperCase());
      requireBoolean(r, child(path, "r"), node.op.toUpperCase());
      if (mixes([l, r])) throw new CalcError(MIX, path);
      return { type: "boolean", isAggregate: l.isAggregate || r.isAggregate, isConst: l.isConst && r.isConst, tables: unionTables([l, r]), name: "that value" };
    }

    case "not": {
      const arg = typeOf(node.arg, child(path, "arg"), categoryOf);
      requireBoolean(arg, child(path, "arg"), "NOT");
      return { type: "boolean", isAggregate: arg.isAggregate, isConst: arg.isConst, tables: arg.tables, name: "that value" };
    }

    case "isnull": {
      const arg = typeOf(node.arg, child(path, "arg"), categoryOf);
      return { type: "boolean", isAggregate: arg.isAggregate, isConst: arg.isConst, tables: arg.tables, name: "that value" };
    }

    case "ifnull": {
      const l = typeOf(node.l, child(path, "l"), categoryOf);
      const r = typeOf(node.r, child(path, "r"), categoryOf);
      if (l.type !== r.type) throw new CalcError(`${SAME_TYPE} — ${r.name} is ${r.type}, not ${l.type}.`, child(path, "r"));
      if (mixes([l, r])) throw new CalcError(MIX, path);
      return { type: l.type, isAggregate: l.isAggregate || r.isAggregate, isConst: l.isConst && r.isConst, tables: unionTables([l, r]), name: "that value" };
    }

    case "case": {
      if (!Array.isArray(node.whens) || node.whens.length === 0) throw new CalcError("A CASE needs at least one WHEN.", path);
      // Typed in source order: w0.c, w0.t, w1.c, ..., else. The first THEN fixes the result type.
      const parts = [];
      let first = null;
      node.whens.forEach((w, i) => {
        const wp = `w${i}`;
        const c = typeOf(isNode(w) ? w.c : null, child(path, `${wp}.c`), categoryOf);
        requireBoolean(c, child(path, `${wp}.c`), "A condition");
        const t = typeOf(isNode(w) ? w.t : null, child(path, `${wp}.t`), categoryOf);
        if (first === null) first = t;
        else if (t.type !== first.type) throw new CalcError(`${SAME_TYPE} — ${t.name} is ${t.type}, not ${first.type}.`, child(path, `${wp}.t`));
        parts.push(c, t);
      });
      if (node.else !== undefined) {
        const e = typeOf(node.else, child(path, "else"), categoryOf);
        if (e.type !== first.type) throw new CalcError(`${SAME_TYPE} — ${e.name} is ${e.type}, not ${first.type}.`, child(path, "else"));
        parts.push(e);
      }
      if (mixes(parts)) throw new CalcError(MIX, path);
      return { type: first.type, isAggregate: parts.some((t) => t.isAggregate), isConst: parts.every((t) => t.isConst), tables: unionTables(parts), name: "that value" };
    }

    case "field": {
      const name = `${node.table}.${node.column}`;
      const category = categoryOf(node.db, node.table, node.column);
      if (category === null || category === undefined) throw new CalcError(`Unknown field ${name}.`, path);
      const type = TYPE_OF_CATEGORY.get(category);
      if (type === undefined) throw new CalcError(`${name} can't be used in a calculation.`, path);
      return { type, isAggregate: false, isConst: false, tables: new Set([`${node.db}.${node.table}`]), name };
    }

    case "un": {
      if (node.op !== "-") throw new CalcError(`Unknown operator ${node.op}.`, path);
      const arg = typeOf(node.arg, child(path, "arg"), categoryOf);
      requireNumber(arg, child(path, "arg"));
      return { type: "number", isAggregate: arg.isAggregate, isConst: arg.isConst, tables: arg.tables, name: "that value" };
    }

    case "bin": {
      if (!["+", "-", "*", "/"].includes(node.op)) throw new CalcError(`Unknown operator ${node.op}.`, path);
      // Both children are typed first (an unknown field on the right wins over a text error on the left).
      const l = typeOf(node.l, child(path, "l"), categoryOf);
      const r = typeOf(node.r, child(path, "r"), categoryOf);
      requireNumber(l, child(path, "l"));
      requireNumber(r, child(path, "r"));
      if ((l.isAggregate && !r.isAggregate && !r.isConst) || (r.isAggregate && !l.isAggregate && !l.isConst)) {
        throw new CalcError("Can't mix an aggregate with a row-level value in one formula.", path);
      }
      for (const t of r.tables) l.tables.add(t);
      return { type: "number", isAggregate: l.isAggregate || r.isAggregate, isConst: l.isConst && r.isConst, tables: l.tables, name: "that value" };
    }

    case "agg": {
      const spec = typeof node.fn === "string" && Object.hasOwn(FUNCTIONS, node.fn) ? FUNCTIONS[node.fn] : null;
      if (spec === null) throw new CalcError(`Unknown function ${node.fn}.`, path);
      const argPath = child(path, "arg");
      const arg = typeOf(node.arg, argPath, categoryOf);
      if (arg.isAggregate) throw new CalcError("An aggregate can't contain another aggregate.", argPath);
      if (!spec.accepts.includes(arg.type)) {
        throw new CalcError(`${node.fn.toUpperCase()} needs ${describe(spec.accepts)} — ${arg.name} is ${arg.type}.`, argPath);
      }
      return { type: spec.result ?? arg.type, isAggregate: true, isConst: false, tables: arg.tables, name: "that value" };
    }

    default:
      throw new CalcError("Unknown expression node.", path);
  }
}

/**
 * Types an expression tree bottom-up. `categoryOf(db, table, column)` returns the catalog category
 * (`numeric | text | temporal | boolean | other`), or null/undefined when the column doesn't exist.
 * Returns `{ type, isAggregate, tables }` (`tables`: sorted `"db.table"` strings, ordinal order) or
 * `{ error: { message, path } }` — `path` is dotted (`l`, `r`, `arg`; "" for the root).
 */
export function check(ast, categoryOf) {
  try {
    checkLimits(ast);
    const t = typeOf(ast, "", categoryOf);
    return { type: t.type, isAggregate: t.isAggregate, tables: [...t.tables].sort() };
  } catch (e) {
    if (e instanceof CalcError) return { error: { message: e.message, path: e.path } };
    throw e;
  }
}
