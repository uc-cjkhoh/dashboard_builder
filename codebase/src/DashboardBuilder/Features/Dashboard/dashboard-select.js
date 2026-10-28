import { keyOf, selectionFilter } from "./sheet-plan.js";
import { primaryDim } from "./result-model.js";
import { refusal } from "../Calc/calc-pill.js";

// The dashboard's one selection (P24c) — pure and DOM-free (tests/js/dashboard-select.test.mjs). A click on a mark in one
// worksheet widget selects that mark's value on the widget's primary dimension; every OTHER worksheet widget then filters
// to it. It is transient: held in the board's memory, never in the workbook. The filter it becomes is the worksheet's own
// click-selection filter (sheet-plan.js selectionFilter): a bound `=`, applied only where its table is already in the query.
//   selection = { db, table, column, value, label, sourceWidgetId }

const sameMark = (sel, field, raw, sourceWidgetId) => Boolean(sel) && sel.sourceWidgetId === sourceWidgetId
  && sel.db === field.db && sel.table === field.table && sel.column === field.column && String(sel.value) === String(raw);

/** The selection after a click on `raw` of `field` in widget `sourceWidgetId`: the same mark again clears (null), a null mark changes nothing (`cur`). */
export function nextSelection(cur, field, raw, fmtCat, sourceWidgetId) {
  if (raw === null || raw === undefined) return cur;
  if (sameMark(cur, field, raw, sourceWidgetId)) return null;
  return { db: field.db, table: field.table, column: field.column, value: raw, label: `${field.table}.${field.column} = ${fmtCat(raw)}`, sourceWidgetId };
}

/** Why `field` can't be selected on (a calculated field has no column to filter on), or null. Same message as the worksheet editor. */
export const selectionRefusal = (field) => refusal(field, "selection");

/** The bound `=` filter a target adds. */
export const crossFilterOf = (sel) => selectionFilter(sel, "=");

/** A target applies the selection only if the selected column's table is already in its query (`involvedKeys` = sheet-plan keys). */
export const appliesTo = (involvedKeys, sel) => Boolean(sel) && involvedKeys.includes(keyOf(sel.db, sel.table));

/** Every index whose raw primary-dimension value is the selected one (two row dimensions give several marks per value); [] when none, another column, or no selection. */
export function selectedIndicesOf(rawByIndex, sel, field) {
  if (!sel || (field && (field.db !== sel.db || field.table !== sel.table || field.column !== sel.column))) return [];
  const out = [];
  rawByIndex.forEach((r, i) => { if (r !== null && r !== undefined && String(r) === String(sel.value)) out.push(i); });
  return out;
}

/** Said when the clicked mark is a NULL member or the "Other" group: neither can be a bound `=` filter, so nothing is selected. */
export const UNSELECTABLE_NOTE = "That mark is the empty (NULL) value or the Other group — it can't be used as a filter.";

export const chipText = (sel) => `Filtering by ${sel.label}`;
export const notAppliedNote = (sel) => `${sel.table}.${sel.column}: selected on another sheet, not applied here — its table isn't in this view.`;
/** A histogram / box plot runs its own single-table query: it takes no dashboard selection. */
export const statNote = (sel) => `${sel.table}.${sel.column}: selected on another sheet, not applied to a histogram or box plot.`;

/** What a widget does with the dashboard selection: the source highlights its mark; every other widget filters; null = no selection. */
export const crossFor = (sel, widgetId) => (!sel ? null : sel.sourceWidgetId === widgetId ? { selected: sel } : { filter: sel });

/**
 * Everything a widget would show differently under `cross`, as a string: equal signatures mean the widget need not run again.
 * A widget the selection can't reach shows only the note, which names the column — not the value.
 */
export function crossSignature(cross, involvedKeys) {
  if (!cross) return "";
  if (cross.selected) return `source:${cross.selected.db}.${cross.selected.table}.${cross.selected.column}=${cross.selected.value}`;
  const sel = cross.filter;
  return appliesTo(involvedKeys, sel) ? `filter:${sel.db}.${sel.table}.${sel.column}=${sel.value}` : `note:${sel.table}.${sel.column}`;
}

/** The selection still describes its source: the source's primary dimension is still the selected column (else it clears). */
export function stillValid(sel, sourceSheet) {
  if (!sel) return true;
  const d = primaryDim(sourceSheet);
  return Boolean(d) && d.db === sel.db && d.table === sel.table && d.column === sel.column;
}
