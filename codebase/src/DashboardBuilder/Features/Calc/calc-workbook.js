// Calculated fields — workbook-level list helpers (pure, DOM-free; tests/js/calc-workbook.test.mjs).
// A calculation is { id: "calc{n}", name, formula }; the parsed tree is never saved (it is rebuilt on open).
import { LIMITS, text } from "../Core/validate.js";

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

/** B2: a calculation name is 1–LIMITS.calcName characters, no `.`, `[` or `]`, unique case-insensitively
 *  (ignoring the calculation `selfId` being edited). { ok, value } or { ok: false, error }. */
export function checkName(name, calcs, selfId) {
  const t = text(name, { label: "Name", max: LIMITS.calcName, required: true });
  if (!t.ok) return t;
  if (/[.[\]]/.test(t.value)) return { ok: false, error: "Name can't contain '.', '[' or ']'." };
  if (calcs.some((c) => c.id !== selfId && sameName(c.name, t.value))) return { ok: false, error: `A calculation named '${t.value}' already exists.` };
  return { ok: true, value: t.value };
}

const refsTo = (formula, name) => {
  const re = /\[([^[\]]*)\]/g;
  for (let m; (m = re.exec(formula));) if (m[1].trim() === name) return true;
  return false;
};

/** B3: `[Old]` becomes `[New]` in every calculation's formula; `[table.Old]` is left alone. Returns a new array. */
export function renameInFormulas(calcs, oldName, newName) {
  return calcs.map((c) => ({ ...c, formula: String(c.formula).replace(/\[([^[\]]*)\]/g, (all, inner) => (inner.trim() === oldName ? `[${newName}]` : all)) }));
}

/** The names of the calculations whose formula references calculation `id` as `[name]`. */
export function usedBy(calcs, id) {
  const me = calcs.find((c) => c.id === id);
  if (!me) return [];
  return calcs.filter((c) => c.id !== id && refsTo(String(c.formula), me.name)).map((c) => c.name);
}

/** A saved calculation, checked — or null (with an issue). Name uniqueness is cleanCalculations' job. */
export function cleanCalculation(raw, issues) {
  if (!raw || typeof raw !== "object" || !/^calc\d{1,6}$/.test(raw.id ?? "")) { issues.push("Skipped a calculation with no id."); return null; }
  const name = checkName(raw.name, [], null);
  if (!name.ok) { issues.push(`Skipped a calculation ${raw.id}: ${name.error}`); return null; }
  if (typeof raw.formula !== "string" || raw.formula.length > LIMITS.calcFormula) {
    issues.push(`Skipped calculation "${name.value}": its formula was missing or longer than ${LIMITS.calcFormula} characters.`); return null;
  }
  return { id: raw.id, name: name.value, formula: raw.formula };
}

/** ≤ LIMITS.calculations, each checked; a duplicate id or name keeps the first. */
export function cleanCalculations(list, issues) {
  if (list == null) return [];
  if (!Array.isArray(list)) { issues.push("The calculations weren't a list — none were opened."); return []; }
  const out = [];
  for (const raw of list.slice(0, LIMITS.calculations)) {
    const c = cleanCalculation(raw, issues);
    if (!c) continue;
    if (out.some((o) => o.id === c.id || sameName(o.name, c.name))) { issues.push(`Skipped a duplicate calculation "${c.name}".`); continue; }
    out.push(c);
  }
  if (list.length > LIMITS.calculations) issues.push(`Only the first ${LIMITS.calculations} calculations were opened.`);
  return out;
}
