// Calculated fields — dialog model (pure, DOM-free; tests/js/calc-dialog-model.test.mjs).
// What the calculation dialog shows for a draft: validation, the role chip, and bracket autocomplete.
import { LIMITS } from "../Core/validate.js";
import { checkName } from "./calc-workbook.js";
import { compileCalculation } from "./calc-resolve.js";

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
const SUGGEST_MAX = 12;
const offered = (s) => typeof s === "string" && s !== "" && !/[.[\]]/.test(s);

/**
 * Validates an unsaved draft `{ name, formula, selfId }`. `ctx` = `{ calcs, catalog }`. Never throws; messages are the
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
    r = compileCalculation({ id: selfId, name: n.value, formula }, calcs, ctx.catalog);
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

const TYPE_WORD = { number: "number", text: "text", date: "date", boolean: "boolean" };

/** The role chip: `{ icon, text }`. `icon` is a Core/icons.js name; the text always carries the meaning. */
export function chipFor(info, role) {
  const aggregate = !!info?.isAggregate;
  const type = TYPE_WORD[info?.type] ?? String(info?.type ?? "value");
  return { icon: aggregate ? "analytics" : "detail", text: `${aggregate ? "Aggregate" : "Row-level"} · ${type}`, role };
}

/**
 * Autocomplete inside an unclosed `[`. Returns `{ from, to, items }`: replace `formula.slice(from, to)` with an
 * item's `insert` (the text between the brackets). Items are empty when the caret isn't inside an open bracket.
 * `ctx` = `{ calcs, catalog, selfId? }`.
 */
export function suggest(formula, caret, ctx) {
  const none = { from: 0, to: 0, items: [] };
  if (typeof formula !== "string") return none;
  const to = Math.max(0, Math.min(Number.isInteger(caret) ? caret : formula.length, formula.length));
  const before = formula.slice(0, to);
  const open = before.lastIndexOf("[");
  if (open < 0 || before.indexOf("]", open) >= 0) return { ...none, from: to, to };
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
