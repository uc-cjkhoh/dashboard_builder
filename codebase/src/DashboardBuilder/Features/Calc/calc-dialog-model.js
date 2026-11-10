// Calculated fields — dialog model (pure, DOM-free; tests/js/calc-dialog-model.test.mjs).
// What the calculation dialog shows for a draft: validation, the role chip, and bracket autocomplete.
import { LIMITS } from "../Core/validate.js";
import { checkName } from "./calc-workbook.js";
import { compileCalculation } from "./calc-resolve.js";
import { functionItems } from "./function-help.js";

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
const SUGGEST_MAX = 12;
const offered = (s) => typeof s === "string" && s !== "" && !/[.[\]]/.test(s);

/**
 * Validates an unsaved draft `{ name, formula, selfId }`. `ctx` = `{ calcs, catalog, params }`. Never throws; messages are the
 * plain text for the person editing (no "Calculation 'X' can't be computed:" prefix).
 */
export function evaluateDraft(draft, ctx) {
  const { name, formula, selfId } = draft ?? {};
  const calcs = Array.isArray(ctx?.calcs) ? ctx.calcs : [];
  const n = checkName(name, calcs, selfId);
  if (!n.ok) return { ok: false, field: "name", message: n.error };
  if (typeof formula !== "string" || formula.trim() === "") return { ok: false, field: "formula", message: "Write a formula." };
  if (formula.length > LIMITS.calcFormula) return { ok: false, field: "formula", message: `A formula can be at most ${LIMITS.calcFormula} characters.` };
  if (CONTROL.test(formula)) return { ok: false, field: "formula", message: "That formula has a character that isn't allowed." };
  let r;
  try {
    r = compileCalculation({ id: selfId, name: n.value, formula }, calcs, ctx.catalog, ctx.params);
  } catch {
    return { ok: false, field: "formula", message: "That formula can't be read." };
  }
  if (r.error) {
    const prefix = `Calculation '${n.value}' can't be computed: `;
    const message = r.error.message.startsWith(prefix) ? r.error.message.slice(prefix.length) : r.error.message;
    const out = { ok: false, field: "formula", message };
    if (r.error.pos !== undefined) out.pos = r.error.pos;
    return out;
  }
  return { ok: true, info: r.info, role: r.role, ast: r.ast };
}

/** True when the draft differs from what the dialog opened with (name trimmed, line endings ignored). */
export function isDirty(initial, now) {
  const norm = (d) => `${String(d?.name ?? "").trim()}\u0000${String(d?.formula ?? "").replace(/\r\n?/g, "\n")}`;
  return norm(initial) !== norm(now);
}

const TYPE_WORD = { number: "number", text: "text", date: "date", boolean: "boolean" };

/** The role chip: `{ icon, text }`. `icon` is a Core/icons.js name; the text always carries the meaning. */
export function chipFor(info, role) {
  const aggregate = !!info?.isAggregate;
  const type = TYPE_WORD[info?.type] ?? String(info?.type ?? "value");
  return { icon: aggregate ? "analytics" : "detail", text: `${aggregate ? "Aggregate" : "Row-level"} · ${type}`, role };
}

/**
 * Autocomplete. Inside an unclosed `[`: returns `{ from, to, items }`; replace `formula.slice(from, to)` with an
 * item's `insert` (the text between the brackets). Outside brackets and text literals, after a letter prefix: function
 * names (`kind: "function"`, `hint` = the signature, `insert` = the text to put in place of the prefix, e.g. `LOWER(`).
 * Items are empty otherwise.
 * `ctx` = `{ calcs, catalog, params?, selfId? }`. After `[@` only parameters are offered (`kind: "param"`).
 */
export function suggest(formula, caret, ctx) {
  const none = { from: 0, to: 0, items: [] };
  if (typeof formula !== "string") return none;
  const to = Math.max(0, Math.min(Number.isInteger(caret) ? caret : formula.length, formula.length));
  const before = formula.slice(0, to);
  const open = before.lastIndexOf("[");
  if (open < 0 || before.indexOf("]", open) >= 0) return functionSuggest(formula, before, to) ?? { ...none, from: to, to };
  if (before[open + 1] === "@") { // [@ — the workbook's parameters, and only those
    const typedParam = before.slice(open + 2).toLowerCase();
    const pItems = (Array.isArray(ctx?.params) ? ctx.params : [])
      .filter((p) => typeof p.name === "string" && !/[[\]]/.test(p.name) && p.name.toLowerCase().startsWith(typedParam))
      .map((p) => ({ label: p.name, insert: p.name, kind: "param", type: p.type }));
    return { from: open + 2, to, items: pItems.slice(0, SUGGEST_MAX) };
  }
  const from = open + 1;
  const typed = before.slice(from).trim().toLowerCase();
  const items = [];
  const push = (label, kind) => { if (label.toLowerCase().startsWith(typed)) items.push({ label, insert: label, kind }); };

  const catalog = ctx?.catalog;
  for (const f of catalog?.fields ?? []) {
    const ambiguous = (catalog.tablesByName?.get(f.table) ?? []).length > 1;
    push(ambiguous ? `${f.db}.${f.table}.${f.column}` : `${f.table}.${f.column}`, "field");
  }
  for (const c of Array.isArray(ctx?.calcs) ? ctx.calcs : []) {
    if (c.id !== ctx.selfId && offered(c.name)) push(c.name, "calc");
  }
  return { from, to, items: items.slice(0, SUGGEST_MAX) };
}

// True when `before` ends inside an unclosed '…' or "…" literal (the other quote kind is plain text inside one).
function inTextLiteral(before) {
  let q = null;
  for (const ch of before) { if (q === null) { if (ch === "'" || ch === '"') q = ch; } else if (ch === q) q = null; }
  return q !== null;
}

/** The note shown when calculation name `name` equals a model column name (a bare `[name]` then means the calculation), else null. */
export function columnClash(name, catalog) {
  const n = String(name ?? "").trim();
  if (n === "" || !(catalog?.fields ?? []).some((f) => f.column === n)) return null;
  return `A column is also called ${n} — [${n}] will mean this calculation.`;
}

// A word being typed outside any [ ] or '…' (the caller already knows there is no open bracket).
function functionSuggest(formula, before, to) {
  const next = formula.charAt(to);
  if (/[A-Za-z0-9_]/.test(next)) return null; // the caret is inside a word: LO|WER
  if (inTextLiteral(before)) return null;
  const m = /(?<![A-Za-z0-9_.])[A-Za-z_][A-Za-z0-9_]*$/.exec(before);
  if (!m) return null;
  const items = functionItems(m[0], SUGGEST_MAX);
  if (next === "(") for (const it of items) it.insert = it.insert.replace(/\($/, ""); // a bracket follows already
  return items.length ? { from: m.index, to, items } : null;
}
