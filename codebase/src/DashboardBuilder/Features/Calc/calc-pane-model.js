// Calculated fields — pure helpers for the dialog and the field-pane group (DOM-free; tests/js/calc-pane-model.test.mjs).
import { LIMITS } from "../Core/validate.js";
import { usedBy } from "./calc-workbook.js";
import { usesCalc } from "./calc-pill.js";
import { compileCalculation } from "./calc-resolve.js";
import { chipFor } from "./calc-dialog-model.js";

/** A textarea can hold CRLF; the formula model rejects CR, so the dialog normalises first. */
export const normaliseFormula = (s) => String(s ?? "").replace(/\r\n?/g, "\n");

/** B4: `{ refusedBy: [names] | null, usedInSheets: n }` for deleting calculation `id` from `sheets`. */
export function deleteCalcPlan(calcs, sheets, id) {
  const by = usedBy(calcs, id);
  return { refusedBy: by.length ? by : null, usedInSheets: sheets.filter((s) => usesCalc(s, id)).length };
}

/** E4: the "Use as" control is only for a row-level number. */
export const showUseAs = (info) => Boolean(info) && !info.isAggregate && info.type === "number";
export const useAsRole = (v) => (v === "measure" || v === "dimension" ? v : null);

// The Measure / Dimension choice for a row-level number is not part of the saved workbook shape
// ({ id, name, formula }); it lives for the session and is applied when a pill is made.
const choices = new Map();
export const setRoleChoice = (id, role) => { if (role) choices.set(id, role); else choices.delete(id); };
export const roleChoice = (id) => choices.get(id) ?? null;

/** What the pane group shows: `{ canAdd, items: [{ calc, info, role, chip, error }] }`. */
export function paneState(calcs, catalog) {
  const items = calcs.map((calc) => {
    const r = compileCalculation(calc, calcs, catalog);
    if (r.error) return { calc, info: null, role: null, chip: null, error: r.error.message };
    return { calc, info: r.info, role: r.role, chip: chipFor(r.info, r.role), error: null };
  });
  return { canAdd: calcs.length < LIMITS.calculations, items };
}
