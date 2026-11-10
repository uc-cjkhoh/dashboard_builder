// Split a text field into pieces — pure, DOM-free (tests/js/split-model.test.mjs). A split is not a new kind of field:
// it plans one ordinary calculated field per piece, `SPLIT([db.table.column], 'sep', k)`, so the engine, pills, query and
// workbook already know it. The separator and position are literals in the formula (the engine's SPLIT rules, D54).
import { LIMITS } from "../Core/validate.js";
import { checkName } from "./calc-workbook.js";

export const SPLIT_MAX_PIECES = 10;
export const SPLIT_MAX_SEP = 20; // the engine's SPLIT separator limit
const NAME_BASE = 40; // leaves room in the 60-character name limit for " (split 99) 10"

const unwritable = (s) => /[.[\]]/.test(s);

/**
 * `field` { db, table, column }; `sep` the text to cut at; `pieces` how many fields to make; `calcs` the workbook's calculations;
 * `name` an optional base name (default: the column); `names` an optional comma-separated list that names the pieces in order (an
 * empty entry keeps the default `<base> <k>`). { ok: true, calcs: [{ name, formula }] } or { ok: false, error }.
 */
export function splitPlan({ field, sep, pieces, calcs, name, names }) {
  if (!Number.isInteger(pieces) || pieces < 2 || pieces > SPLIT_MAX_PIECES) return { ok: false, error: `Split into 2 to ${SPLIT_MAX_PIECES} fields.` };
  if (typeof sep !== "string" || sep.length < 1 || sep.length > SPLIT_MAX_SEP) return { ok: false, error: `The separator is 1 to ${SPLIT_MAX_SEP} characters.` };
  if ([field?.db, field?.table, field?.column].some((p) => typeof p !== "string" || !p || unwritable(p)))
    return { ok: false, error: "A field whose database, table or column name holds '.', '[' or ']' can't be written in a formula, so it can't be split." };
  if (calcs.length + pieces > LIMITS.calculations) return { ok: false, error: `A workbook can have at most ${LIMITS.calculations} calculated fields.` };
  const given = typeof names === "string" && names.trim() !== "" ? names.split(",").map((s) => s.trim()) : [];
  if (given.length > pieces) return { ok: false, error: `${given.length} names for ${pieces} pieces.` };
  const taken = [...calcs];
  for (const g of given.filter(Boolean)) {
    const c = checkName(g, taken);
    if (!c.ok) return { ok: false, error: c.error };
    if (given.filter((x) => x && x.toLowerCase() === g.toLowerCase()).length > 1) return { ok: false, error: `The name '${g}' is used more than once.` };
    taken.push({ id: "", name: g });
  }
  const clean = (s) => s.replace(/[.[\]]+/g, " ").trim().slice(0, NAME_BASE).trim();
  const root = clean(name || field.column) || "field";
  const open = Array.from({ length: pieces }, (_, i) => i).filter((i) => !given[i]);
  const free = (base) => open.every((i) => checkName(`${base} ${i + 1}`, taken).ok);
  let base = root;
  if (!free(base)) base = `${root} (split)`;
  for (let i = 2; !free(base) && i < 1000; i++) base = `${root} (split ${i})`;
  const lit = `'${sep.replaceAll("'", "''")}'`;
  const ref = `[${field.db}.${field.table}.${field.column}]`;
  return { ok: true, calcs: Array.from({ length: pieces }, (_, i) => ({ name: given[i] || `${base} ${i + 1}`, formula: `SPLIT(${ref}, ${lit}, ${i + 1})` })) };
}
