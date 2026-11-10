// Query-time cleaning — pure, DOM-free (tests/js/clean-model.test.mjs). Cleaning is not a new kind of field: each operation plans
// ONE ordinary calculated field over the column (TRIM, IFNULL, CASE, DATE), so the engine, pills, query and workbook already know it.
// The source data is never changed; the cleaning happens in the query.
import { LIMITS } from "../Core/validate.js";
import { CALC_LIMITS } from "./calc-types.js";
import { checkName } from "./calc-workbook.js";

export const CLEAN_MAX_RECODE = LIMITS.cleanRecode;
const NAME_BASE = 40; // leaves room in the 60-character name limit for " (recoded 99)"
const SUFFIX = { trim: "trimmed", nullTo: "filled", recode: "recoded", date: "date" };
const unwritable = (s) => /[.[\]]/.test(s);
const lit = (s) => `'${s.replaceAll("'", "''")}'`;

/** The operations a column category offers, in menu order (a date column has none: the engine has no date literal). */
export function cleanOps(category) {
  if (category === "text") return ["trim", "nullTo", "recode", "date"];
  if (category === "numeric") return ["nullTo"];
  return [];
}

/** Dialog text, one `old = new` per line (cut at the first `=`; blank lines skipped) -> { pairs } or { error }. */
export function parseRecode(text) {
  const pairs = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const at = lines[i].indexOf("=");
    if (at < 0) return { error: `Line ${i + 1}: write it as  old value = new value.` };
    pairs.push({ from: lines[i].slice(0, at).trim(), to: lines[i].slice(at + 1).trim() });
  }
  return { pairs };
}

/**
 * `field` { db, table, column }; `category` the column's category; `op` one of cleanOps; `value` (nullTo: the replacement, text or a
 * number as typed); `emptyToo` (nullTo on text: an empty string is replaced as well as NULL); `pairs` [{ from, to }] and `keep` (recode: keep unmatched values, default true); `calcs` the workbook's
 * calculations; `name` an optional base name (default: the column). { ok: true, calcs: [{ name, formula }] } or { ok: false, error }.
 */
export function cleanPlan({ field, category, op, value, emptyToo = false, pairs, keep = true, calcs, name }) {
  if (!SUFFIX[op]) return { ok: false, error: "Pick a cleaning operation." };
  if (!cleanOps(category).length) return { ok: false, error: "A date field can't be cleaned here." };
  if (!cleanOps(category).includes(op)) return { ok: false, error: "That operation needs a text field." };
  if ([field?.db, field?.table, field?.column].some((p) => typeof p !== "string" || !p || unwritable(p)))
    return { ok: false, error: "A field whose database, table or column name holds '.', '[' or ']' can't be written in a formula, so it can't be cleaned." };
  if (calcs.length + 1 > LIMITS.calculations) return { ok: false, error: `A workbook can have at most ${LIMITS.calculations} calculated fields.` };
  const ref = `[${field.db}.${field.table}.${field.column}]`;
  const tooLong = (s) => s.length > CALC_LIMITS.string;
  const textTooLong = `Text can be at most ${CALC_LIMITS.string} characters.`;
  let formula;
  if (op === "trim") formula = `TRIM(${ref})`;
  else if (op === "date") formula = `DATE(${ref})`;
  else if (op === "nullTo") {
    if (category === "numeric") {
      const t = String(value ?? "").trim(), n = Number(t);
      if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t) || !Number.isFinite(n)) return { ok: false, error: "Enter a number to use for empty values." };
      formula = `IFNULL(${ref}, ${t})`;
    } else {
      const t = String(value ?? "");
      if (tooLong(t)) return { ok: false, error: textTooLong };
      formula = emptyToo ? `IF(ISNULL(${ref}) OR ${ref} = '', ${lit(t)}, ${ref})` : `IFNULL(${ref}, ${lit(t)})`;
    }
  } else {
    if (!Array.isArray(pairs) || !pairs.length) return { ok: false, error: "Add at least one value to recode." };
    if (pairs.length > CLEAN_MAX_RECODE) return { ok: false, error: `Recode at most ${CLEAN_MAX_RECODE} values.` };
    if (pairs.some((p) => tooLong(p.from) || tooLong(p.to))) return { ok: false, error: textTooLong };
    if (new Set(pairs.map((p) => p.from)).size !== pairs.length) return { ok: false, error: "An old value appears more than once." };
    formula = `CASE ${ref} ${pairs.map((p) => `WHEN ${lit(p.from)} THEN ${lit(p.to)}`).join(" ")}${keep ? ` ELSE ${ref}` : ""} END`;
  }
  if (formula.length > CALC_LIMITS.formula) return { ok: false, error: `The formula would be over ${CALC_LIMITS.formula} characters; recode fewer or shorter values.` };
  const clean = (s) => s.replace(/[.[\]]+/g, " ").trim().slice(0, NAME_BASE).trim();
  const root = clean(name || field.column) || "field";
  let nm = `${root} (${SUFFIX[op]})`;
  for (let i = 2; !checkName(nm, calcs).ok && i < 1000; i++) nm = `${root} (${SUFFIX[op]} ${i})`;
  return { ok: true, calcs: [{ name: nm, formula }] };
}
