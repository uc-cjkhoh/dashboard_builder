// Calculated fields — the type checker (pure, DOM-free; tests/js/calc-cases.test.mjs).
// A line-for-line twin of ClickHouse/Calc/CalcCatalog.cs + CalcValidator.cs: the same function table, the same
// messages, the same error paths, the same check order. The shared fixture tests/fixtures/calc-cases.json is
// the contract — change one side and the other in the same commit.

/** Calculation limits (`count`: largest LEFT/RIGHT length or SPLIT position; `separator`: longest SPLIT separator; `concat`: most CONCAT arguments; `dateAmount`: largest DATEADD amount, either sign; `inList`: most values in an IN list); mirrored in ClickHouse/Calc/CalcLimits (and the workbook ones in Core/validate.js LIMITS). */
export const CALC_LIMITS = Object.freeze({ formula: 500, depth: 12, nodes: 200, calcs: 20, name: 60, string: 100, count: 1000, separator: 20, concat: 10, dateAmount: 100000, inList: 50 });

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
  median: { accepts: NUMBER_ONLY, result: "number" },
  stddev: { accepts: NUMBER_ONLY, result: "number" },
  variance: { accepts: NUMBER_ONLY, result: "number" },
  percentile: { accepts: NUMBER_ONLY, result: "number", fraction: true }, // takes a literal 0..1 `p` after its argument
  attr: { accepts: ANYTHING, result: null },
});

/** The units DATEDIFF and DATEADD take, written as a text literal (any case). Twin of CalcCatalog.DateUnits. */
export const DATE_UNITS = Object.freeze(["year", "quarter", "month", "week", "day", "hour", "minute", "second"]);

/** The parts DATENAME takes, written as a text literal (any case): the name is always English. Twin of CalcCatalog.DateNameParts. */
export const DATE_NAME_PARTS = Object.freeze(["weekday", "month"]);

/** Why a regular expression pattern can't run on ClickHouse (RE2: no look-ahead / look-behind, no atomic groups, no back-references in the pattern) or is not
 *  closed; null when none of these applies. A cheap scan, not a parser: ClickHouse still has the last word. Twin of CalcValidator.RegexProblem. */
export function regexProblem(p) {
  let depth = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") {
      if (i + 1 < p.length && p[i + 1] >= "1" && p[i + 1] <= "9") return "back-references such as \\1 aren't supported in a pattern";
      i++;
    } else if (c === "[") {
      let j = i + 1;
      if (p[j] === "^") j++;
      if (p[j] === "]") j++; // a ] right after the opening is a letter of the class
      for (; j < p.length && p[j] !== "]"; j++) if (p[j] === "\\") j++;
      if (j >= p.length) return "a [ is never closed";
      i = j;
    } else if (c === "(") {
      if (/^\(\?(=|!|<=|<!)/.test(p.slice(i, i + 4))) return "look-ahead and look-behind aren't supported";
      if (p.startsWith("(?>", i)) return "atomic groups aren't supported";
      depth++;
    } else if (c === ")" && --depth < 0) return "a ) has no ( before it";
  }
  return depth > 0 ? "a ( is never closed" : null;
}

/** The row-level text and date functions (wire node `{ k: "fn", fn, args }`). `args` are kinds in order: `text` (any text expression),
 *  `length` (a whole-number literal 0..count), `position` (a whole-number literal 1..count), `separator` (a non-empty text
 *  literal, at most `separator` characters); the date kinds: `date` (a date expression), `unit` (a DATE_UNITS text literal),
 *  `amount` (a whole-number literal, either sign, at most `dateAmount`); `part` (a DATE_NAME_PARTS text literal); `month` (a whole-number literal 1..12, a fiscal start month); `pattern` (a non-empty text literal, a regular expression, at most `string` characters); `replacement` (a text literal, possibly empty, at most `string` characters); `number` (any number expression); `value` (a number, date or text expression). `max` above `args.length` repeats the last kind (CONCAT); `min` below `args.length` makes the trailing arguments optional (MID, FIND). Twin of CalcCatalog.RowFunctions. */
export const ROW_FUNCTIONS = Object.freeze({
  lower: { args: ["text"], result: "text" },
  upper: { args: ["text"], result: "text" },
  trim: { args: ["text"], result: "text" },
  ltrim: { args: ["text"], result: "text" },
  rtrim: { args: ["text"], result: "text" },
  text: { args: ["value"], result: "text" },
  len: { args: ["text"], result: "number" },
  left: { args: ["text", "length"], result: "text" },
  right: { args: ["text", "length"], result: "text" },
  mid: { args: ["text", "position", "length"], result: "text", min: 2 },
  find: { args: ["text", "text", "position"], result: "number", min: 2 },
  replace: { args: ["text", "text", "text"], result: "text" },
  concat: { args: ["text", "text"], result: "text", max: CALC_LIMITS.concat },
  contains: { args: ["text", "text"], result: "boolean" },
  startswith: { args: ["text", "text"], result: "boolean" },
  endswith: { args: ["text", "text"], result: "boolean" },
  icontains: { args: ["text", "text"], result: "boolean" },
  istartswith: { args: ["text", "text"], result: "boolean" },
  iendswith: { args: ["text", "text"], result: "boolean" },
  split: { args: ["text", "separator", "position"], result: "text" },
  regexp_match: { args: ["text", "pattern"], result: "boolean" },
  regexp_extract: { args: ["text", "pattern"], result: "text" },
  regexp_extract_nth: { args: ["text", "pattern", "position"], result: "text" },
  regexp_replace: { args: ["text", "pattern", "replacement"], result: "text" },
  datediff: { args: ["unit", "date", "date"], result: "number" },
  dateadd: { args: ["unit", "amount", "date"], result: "date" },
  year: { args: ["date"], result: "number" },
  month: { args: ["date"], result: "number" },
  day: { args: ["date"], result: "number" },
  quarter: { args: ["date"], result: "number" },
  week: { args: ["date"], result: "number" },
  weekday: { args: ["date"], result: "number" },
  date: { args: ["text"], result: "date" },
  isoyear: { args: ["date"], result: "number" },
  datename: { args: ["part", "date"], result: "text" },
  datetrunc: { args: ["unit", "date"], result: "date" },
  fiscalyear: { args: ["month", "date"], result: "number" },
  fiscalquarter: { args: ["month", "date"], result: "number" },
  makedate: { args: ["number", "number", "number"], result: "date" },
});

/** The first and last day a ClickHouse `Date` holds; a date literal (`#2024-01-31#`) must be a real day between them. Twin of CalcLimits.MinDate / MaxDate. */
export const DATE_LITERAL_MIN = "1970-01-01";
export const DATE_LITERAL_MAX = "2149-06-06";
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_LITERAL_MESSAGE = `A date must be a real day from ${DATE_LITERAL_MIN} to ${DATE_LITERAL_MAX}, written #2024-01-31#.`;

/** Is `v` a date-literal value: `yyyy-mm-dd`, a day that exists, within the range a `Date` holds (the YYYY-MM-DD strings order as dates). */
export function isDateLiteral(v) {
  if (typeof v !== "string" || !DATE_SHAPE.test(v)) return false;
  if (v < DATE_LITERAL_MIN || v > DATE_LITERAL_MAX) return false;
  const [y, m, d] = v.split("-").map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

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
    else if (n.k === "in") { walk(n.arg, depth + 1); if (Array.isArray(n.list)) for (const v of n.list) walk(v, depth + 1); }
    else if (n.k === "fn" && Array.isArray(n.args)) for (const a of n.args) walk(a, depth + 1);
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
// NULL has no type of its own: it takes the type of the results (or the IFNULL value) beside it, and is refused anywhere else.
// Internally its type is "null"; it never leaves typeOf() as an answer (check() rejects it at the root).
const NULL_TYPE = "NULL needs another value to take its type from — use it as an IF, CASE or IFNULL result.";
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

    case "date":
      if (!isDateLiteral(node.v)) throw new CalcError(DATE_LITERAL_MESSAGE, path);
      return { type: "date", isAggregate: false, isConst: true, tables: new Set(), name: "that value" };

    case "bool":
      if (typeof node.v !== "boolean") throw new CalcError("Unknown expression node.", path);
      return { type: "boolean", isAggregate: false, isConst: true, tables: new Set(), name: "that value" };

    case "null":
      return { type: "null", isAggregate: false, isConst: true, tables: new Set(), name: "NULL" };

    case "in": {
      const arg = typeOf(node.arg, child(path, "arg"), categoryOf);
      if (arg.type !== "number" && arg.type !== "text" && arg.type !== "date") throw new CalcError(`IN needs a number, text or date — ${arg.name} is ${arg.type}.`, child(path, "arg"));
      const list = Array.isArray(node.list) ? node.list : [];
      if (list.length < 1 || list.length > CALC_LIMITS.inList) throw new CalcError(`IN takes 1 to ${CALC_LIMITS.inList} values.`, child(path, "list"));
      list.forEach((item, i) => {
        const ip = child(path, `list.${i}`);
        const literal = isNode(item) && (item.k === "num" || item.k === "str" || item.k === "date" || (item.k === "un" && item.op === "-" && isNode(item.arg) && item.arg.k === "num"));
        if (!literal) throw new CalcError("IN's values must be numbers, text or dates written in the formula.", ip);
        const t = typeOf(item, ip, categoryOf);
        if (t.type !== arg.type) throw new CalcError(`IN needs values of the same type — ${t.name} is ${t.type}, not ${arg.type}.`, ip);
      });
      return { type: "boolean", isAggregate: arg.isAggregate, isConst: arg.isConst, tables: arg.tables, name: "that value" };
    }

    case "cmp": {
      if (!["=", "!=", "<", "<=", ">", ">="].includes(node.op)) throw new CalcError(`Unknown operator ${node.op}.`, path);
      const l = typeOf(node.l, child(path, "l"), categoryOf);
      const r = typeOf(node.r, child(path, "r"), categoryOf);
      if (l.type === "null" || r.type === "null") throw new CalcError("Comparison with NULL never matches — use ISNULL(value) instead.", path);
      // A boolean compares only with = and != (and only with a boolean, below); it has no order.
      for (const [t, p] of [[l, "l"], [r, "r"]]) {
        if (t.type === "boolean" && node.op !== "=" && node.op !== "!=") throw new CalcError(`Comparison needs a number, text or date — ${t.name} is boolean.`, child(path, p));
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
      if (l.type === "null" && r.type === "null") throw new CalcError(NULL_TYPE, path);
      if (l.type !== "null" && r.type !== "null" && l.type !== r.type) throw new CalcError(`${SAME_TYPE} — ${r.name} is ${r.type}, not ${l.type}.`, child(path, "r"));
      if (mixes([l, r])) throw new CalcError(MIX, path);
      return { type: l.type === "null" ? r.type : l.type, isAggregate: l.isAggregate || r.isAggregate, isConst: l.isConst && r.isConst, tables: unionTables([l, r]), name: "that value" };
    }

    case "case": {
      if (!Array.isArray(node.whens) || node.whens.length === 0) throw new CalcError("A CASE needs at least one WHEN.", path);
      // Typed in source order: w0.c, w0.t, w1.c, ..., else. The first non-NULL result fixes the result type.
      const parts = [];
      let first = null;
      node.whens.forEach((w, i) => {
        const wp = `w${i}`;
        const c = typeOf(isNode(w) ? w.c : null, child(path, `${wp}.c`), categoryOf);
        requireBoolean(c, child(path, `${wp}.c`), "A condition");
        const t = typeOf(isNode(w) ? w.t : null, child(path, `${wp}.t`), categoryOf);
        if (t.type === "null") { /* takes the type of the other results */ }
        else if (first === null) first = t;
        else if (t.type !== first.type) throw new CalcError(`${SAME_TYPE} — ${t.name} is ${t.type}, not ${first.type}.`, child(path, `${wp}.t`));
        parts.push(c, t);
      });
      if (node.else !== undefined) {
        const e = typeOf(node.else, child(path, "else"), categoryOf);
        if (e.type === "null") { /* takes the type of the results */ }
        else if (first === null) first = e;
        else if (e.type !== first.type) throw new CalcError(`${SAME_TYPE} — ${e.name} is ${e.type}, not ${first.type}.`, child(path, "else"));
        parts.push(e);
      }
      if (first === null) throw new CalcError(NULL_TYPE, path);
      if (mixes(parts)) throw new CalcError(MIX, path);
      return { type: first.type, isAggregate: parts.some((t) => t.isAggregate), isConst: parts.every((t) => t.isConst), tables: unionTables(parts), name: "that value" };
    }

    case "fn": {
      const spec = typeof node.fn === "string" && Object.hasOwn(ROW_FUNCTIONS, node.fn) ? ROW_FUNCTIONS[node.fn] : null;
      if (spec === null) throw new CalcError(`Unknown function ${node.fn}.`, path);
      const upper = node.fn.toUpperCase();
      const label = node.fn === "text" ? "TEXT (or STR)" : upper;
      const args = Array.isArray(node.args) ? node.args : [];
      const max = Math.max(spec.max ?? 0, spec.args.length);
      const min = spec.min ?? spec.args.length;
      if (args.length < min || args.length > max) {
        throw new CalcError(`${label} takes ${max > min ? `${min} to ${max} arguments` : min === 1 ? "1 argument" : `${min} arguments`}.`, path);
      }
      const parts = args.map((a, i) => {
        const ap = child(path, `args.${i}`);
        const kind = spec.args[Math.min(i, spec.args.length - 1)];
        const t = typeOf(a, ap, categoryOf);
        if (kind === "text") {
          if (t.type !== "text") throw new CalcError(`${upper} needs a text — ${t.name} is ${t.type}.`, ap);
        } else if (kind === "value") {
          if (t.type === "boolean" || t.type === "null") throw new CalcError(`${label} needs a number, date or text — ${t.name} is ${t.type}.`, ap);
        } else if (kind === "length" || kind === "position") {
          const min = kind === "length" ? 0 : 1;
          const v = a.k === "num" ? a.v : NaN;
          if (!Number.isInteger(v) || v < min || v > CALC_LIMITS.count) {
            throw new CalcError(kind === "length"
              ? `${upper}'s length must be a whole number from 0 to ${CALC_LIMITS.count} written in the formula.`
              : `${upper}'s position must be a whole number from 1 to ${CALC_LIMITS.count} written in the formula.`, ap);
          }
        } else if (kind === "date") {
          if (t.type !== "date") throw new CalcError(`${upper} needs a date — ${t.name} is ${t.type}.${t.type === "text" ? " Use DATE() to turn text into a date." : ""}`, ap);
        } else if (kind === "unit") {
          if (a.k !== "str" || !DATE_UNITS.includes(a.v.toLowerCase())) {
            throw new CalcError(`${upper}'s unit must be one of ${DATE_UNITS.slice(0, -1).map((u) => `'${u}'`).join(", ")} or '${DATE_UNITS[DATE_UNITS.length - 1]}' written in the formula as text.`, ap);
          }
        } else if (kind === "part") {
          if (a.k !== "str" || !DATE_NAME_PARTS.includes(a.v.toLowerCase())) {
            throw new CalcError(`${upper}'s part must be ${DATE_NAME_PARTS.map((u) => `'${u}'`).join(" or ")} written in the formula as text.`, ap);
          }
        } else if (kind === "month") {
          if (a.k !== "num" || !Number.isInteger(a.v) || a.v < 1 || a.v > 12) {
            throw new CalcError(`${upper}'s start month must be a whole number from 1 to 12 written in the formula.`, ap);
          }
        } else if (kind === "pattern") {
          if (a.k !== "str" || a.v.length < 1 || a.v.length > CALC_LIMITS.string) {
            throw new CalcError(`${upper}'s pattern must be a regular expression written in the formula as text, 1 to ${CALC_LIMITS.string} characters.`, ap);
          }
          const why = regexProblem(a.v);
          if (why) throw new CalcError(`${upper}'s pattern isn't a regular expression ClickHouse can read: ${why}.`, ap);
        } else if (kind === "replacement") {
          if (a.k !== "str" || a.v.length > CALC_LIMITS.string) {
            throw new CalcError(`${upper}'s replacement must be text written in the formula, at most ${CALC_LIMITS.string} characters.`, ap);
          }
        } else if (kind === "number") {
          if (t.type !== "number") throw new CalcError(`${upper} needs a number — ${t.name} is ${t.type}.`, ap);
        } else if (kind === "amount") {
          const lit = a.k === "un" && a.op === "-" && isNode(a.arg) && a.arg.k === "num" ? -a.arg.v : a.k === "num" ? a.v : NaN;
          if (!Number.isInteger(lit) || Math.abs(lit) > CALC_LIMITS.dateAmount) {
            throw new CalcError(`${upper}'s amount must be a whole number from -${CALC_LIMITS.dateAmount} to ${CALC_LIMITS.dateAmount} written in the formula.`, ap);
          }
        } else if (a.k !== "str" || a.v.length < 1 || a.v.length > CALC_LIMITS.separator) {
          throw new CalcError(`${upper}'s separator must be text written in the formula, 1 to ${CALC_LIMITS.separator} characters.`, ap);
        }
        return t;
      });
      if (mixes(parts)) throw new CalcError(MIX, path);
      return { type: spec.result, isAggregate: parts.some((t) => t.isAggregate), isConst: parts.every((t) => t.isConst), tables: unionTables(parts), name: "that value" };
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
      const pPath = child(path, "p");
      if (spec.fraction) {
        if (typeof node.p !== "number" || !Number.isFinite(node.p) || node.p < 0 || node.p > 1) {
          throw new CalcError(`${node.fn.toUpperCase()} needs a fraction between 0 and 1.`, pPath);
        }
      } else if (node.p !== undefined && node.p !== null) {
        throw new CalcError(`${node.fn.toUpperCase()} takes no fraction.`, pPath);
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
    if (t.type === "null") throw new CalcError(NULL_TYPE, "");
    return { type: t.type, isAggregate: t.isAggregate, tables: [...t.tables].sort() };
  } catch (e) {
    if (e instanceof CalcError) return { error: { message: e.message, path: e.path } };
    throw e;
  }
}
