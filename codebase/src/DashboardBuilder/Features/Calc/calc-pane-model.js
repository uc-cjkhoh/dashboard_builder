// Calculated fields — pure helpers for the dialog and the field-pane group (DOM-free; tests/js/calc-pane-model.test.mjs).
import { LIMITS } from "../Core/validate.js";
import { usedBy } from "./calc-workbook.js";
import { usesCalc, filtersUseCalc } from "./calc-pill.js";
import { compileCalculation } from "./calc-resolve.js";
import { chipFor } from "./calc-dialog-model.js";

/** A textarea can hold CRLF; the formula model rejects CR, so the dialog normalises first. */
export const normaliseFormula = (s) => String(s ?? "").replace(/\r\n?/g, "\n");

/** B4: `{ refusedBy: [names] | null, usedInSheets: n, usedInShared: n }` for deleting calculation `id`;
 *  `shared` are the workbook's shared filters (a shared Top-N can be ranked by a calculation too). */
export function deleteCalcPlan(calcs, sheets, id, shared = []) {
  const by = usedBy(calcs, id);
  return {
    refusedBy: by.length ? by : null,
    usedInSheets: sheets.filter((s) => usesCalc(s, id)).length,
    usedInShared: shared.filter((f) => filtersUseCalc([f], id)).length,
  };
}

/** The "Use as" control is only for a row-level number. */
export const showUseAs = (info) => Boolean(info) && !info.isAggregate && info.type === "number";
export const useAsRole = (v) => (v === "measure" || v === "dimension" ? v : null);

// The Measure / Dimension choice for a row-level number is not part of the saved workbook shape
// ({ id, name, formula }); it lives for the session and is applied when a pill is made.
const choices = new Map();
export const setRoleChoice = (id, role) => { if (role) choices.set(id, role); else choices.delete(id); };
export const clearRoleChoices = () => choices.clear();
export const roleChoice = (id) => choices.get(id) ?? null;

/** What the pane group shows: `{ canAdd, items: [{ calc, info, role, chip, error }] }`. */
export function paneState(calcs, catalog, params = []) {
  const items = calcs.map((calc) => {
    const r = compileCalculation(calc, calcs, catalog, params);
    if (r.error) return { calc, info: null, role: null, chip: null, error: r.error.message };
    return { calc, info: r.info, role: r.role, chip: chipFor(r.info, r.role), error: null };
  });
  return { canAdd: calcs.length < LIMITS.calculations, items };
}
