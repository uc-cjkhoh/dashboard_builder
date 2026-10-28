// Calculated fields — workbook parameters in formulas (pure, DOM-free; tests/js/calc-params.test.mjs).
// A formula reads a parameter as `[@Name]` (the `@` is its own namespace: field and calculation names never start the
// same way, and a parameter name may hold dots). The parser makes `{ k: "param", name }`; compileCalculation() calls
// substituteParams() after expanding calculation references, so the tree that is checked, cached and sent holds only
// literals (`num`, `str`, or `fn date` over a `str`). The server never sees a parameter, only bound literals.
import { CALC_LIMITS } from "./calc-types.js";
import { dateTime, number as plainNumber } from "../Core/validate.js";
import { mapRefs } from "./calc-workbook.js";

/** Longest text parameter a formula can read (the text-literal limit). */
export const PARAM_TEXT_MAX = CALC_LIMITS.string;
const REF = /\[@([^[\]]*)\]/g;

export const missingParam = (name) => `Parameter [@${name}] was deleted or doesn't exist.`;

/** The literal node for one parameter, or `{ error }`. A negative number is `-` over its magnitude (the parser's shape). */
export function paramLiteral(p) {
  if (p.type === "number") {
    // A string must be a plain decimal (no 0x10, 0b11, Infinity); `1e400` overflows to a non-finite number and is refused.
    const n = typeof p.value === "number" ? p.value : (typeof p.value === "string" ? (plainNumber(p.value).value ?? NaN) : NaN);
    if (!Number.isFinite(n)) return { error: `Parameter [@${p.name}] isn't a usable number.` };
    return n < 0 ? { node: { k: "un", op: "-", arg: { k: "num", v: -n } } } : { node: { k: "num", v: n === 0 ? 0 : n } };
  }
  const s = String(p.value ?? "");
  if (p.type === "date") {
    const d = dateTime(s);
    return d.ok ? { node: { k: "fn", fn: "date", args: [{ k: "str", v: d.value }] } } : { error: `Parameter [@${p.name}] isn't a date.` };
  }
  if (s.length > PARAM_TEXT_MAX) return { error: `Parameter [@${p.name}] can be at most ${PARAM_TEXT_MAX} characters in a formula.` };
  return { node: { k: "str", v: s } };
}

/** Replaces every `param` node by its literal. Returns `{ ast }` (a new tree) or `{ error: { message } }`. */
export function substituteParams(ast, params) {
  const byName = new Map((params ?? []).map((p) => [p.name, p]));
  let error = null;
  const walk = (n) => {
    if (error || n === null || typeof n !== "object") return n;
    if (n.k === "param") {
      const p = byName.get(n.name);
      if (!p) { error = missingParam(n.name); return n; }
      const lit = paramLiteral(p);
      if (lit.error) { error = lit.error; return n; }
      return lit.node;
    }
    if (Array.isArray(n)) return n.map(walk);
    const out = {};
    for (const [k, v] of Object.entries(n)) out[k] = v !== null && typeof v === "object" ? walk(v) : v;
    return out;
  };
  const out = walk(ast);
  return error ? { error: { message: error } } : { ast: out };
}

/** Parameter names a formula text mentions as `[@Name]` (first-seen order, no duplicates). Scans text literals too, so a delete asks first. */
export function paramRefs(formula) {
  const out = [];
  for (const m of String(formula).matchAll(REF)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Names of the calculations whose formula reads parameter `name`. */
export const calcsUsingParam = (calcs, name) => (calcs ?? []).filter((c) => paramRefs(c.formula).includes(name)).map((c) => c.name);

/** `[@Old]` becomes `[@New]` in every formula, outside text literals (`'[@Old]'` is just text). Returns a new array. */
export function renameParamInFormulas(calcs, oldName, newName) {
  return calcs.map((c) => ({ ...c, formula: mapRefs(c.formula, (inner) => (inner === `@${oldName}` ? `@${newName}` : undefined)) }));
}

const CALC_REF = /\[([^[\]@][^[\]]*)\]/g;
/** Parameter names read by calculation `id`, following references to other calculations (names only; cycles are cut). */
export function calcParamNames(calcs, id) {
  const byId = new Map((calcs ?? []).map((c) => [c.id, c]));
  const byName = new Map((calcs ?? []).map((c) => [c.name, c]));
  const out = [], seen = new Set();
  const visit = (c) => {
    if (!c || seen.has(c.id)) return;
    seen.add(c.id);
    for (const n of paramRefs(c.formula)) if (!out.includes(n)) out.push(n);
    for (const m of String(c.formula).matchAll(CALC_REF)) visit(byName.get(m[1].trim()));
  };
  visit(byId.get(id));
  return out;
}
