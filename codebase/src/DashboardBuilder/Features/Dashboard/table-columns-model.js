// Per-column alignment and width on a table / text worksheet — pure, DOM-free (tests/js/table-columns.test.mjs).
// Stored on the sheet as format.tableCols: { [key]: { align?, width? } }, absent when no column is set (older workbooks open
// unchanged). A key is a position, not a name — "d0" is the first Rows dimension in the left stub, "m0" the first measure column —
// so renaming a field keeps its setting. A column's alignment overrides Format → Align; its width is in px, MIN to MAX.
import { TABLE_COL_ALIGNS, TABLE_COL_MIN, TABLE_COL_MAX } from "../Core/sheet-schema.js";
import { LIMITS } from "../Core/validate.js";
import { planDims, tableMeasures } from "./sheet-plan.js";
import { roleOf } from "./show-me-rules.js";
import { aggWord } from "../Calc/calc-plan.js";

export const COL_MIN = TABLE_COL_MIN;
export const COL_MAX = TABLE_COL_MAX;
export const COL_STEP = 8; // one arrow key on a resize handle (Shift = five steps)
export const COL_ALIGN_CHOICES = [["auto", "Table setting"], ["left", "Left"], ["center", "Centre"], ["right", "Right"]];

export const dimKey = (i) => `d${i}`;
export const measKey = (i) => `m${i}`;
const MAX_REPORTS = 5; // notes per sheet about column settings; the rest are counted
const KEY = /^([dm])(0|[1-9]\d?)$/;
const keyOk = (k) => { const m = KEY.exec(k); return !!m && Number(m[2]) < (m[1] === "d" ? LIMITS.dimensions : LIMITS.measures); };

/** null when `w` is a whole pixel width in range, else the sentence that says why not. */
export function columnWidthError(w) {
  if (typeof w !== "number" || !Number.isFinite(w)) return "Column width must be a number";
  if (!Number.isInteger(w)) return "Column width must be a whole number of pixels";
  return w < COL_MIN || w > COL_MAX ? `Column width must be between ${COL_MIN} and ${COL_MAX} px` : null;
}

/**
 * The columns a table can format, in order: [{ key, label }]. The Rows dimensions (the left stub) always; the measure columns only
 * when measures run across the top — measures down the left make the value columns the Columns members, which have no stable key.
 */
export function tableColumnList(sheet) {
  const out = planDims(sheet).rowDims.map((f, i) => ({ key: dimKey(i), label: f.column }));
  const measuresLeft = sheet.rows.some((f) => roleOf(f) === "measure") && !sheet.columns.some((f) => roleOf(f) === "measure");
  if (!measuresLeft) tableMeasures(sheet).forEach((e, i) => out.push({ key: measKey(i), label: `${aggWord(e.agg, e.field.p)} ${e.field.column}` }));
  return out;
}

/** `cols` with `patch` ({ align?, width? }) applied to `key`; null removes that field. Emptied and no-longer-present columns drop out; no columns → undefined. */
export function setTableColumn(cols, key, patch, validKeys) {
  const valid = new Set(validKeys);
  const next = {};
  for (const [k, v] of Object.entries(cols ?? {})) if (valid.has(k) && k !== key) next[k] = v;
  const merged = { ...(cols?.[key] ?? {}), ...patch };
  const entry = {};
  if (merged.align != null && TABLE_COL_ALIGNS.has(merged.align)) entry.align = merged.align;
  if (merged.width != null) entry.width = merged.width;
  if (valid.has(key) && Object.keys(entry).length) next[key] = entry;
  const keys = Object.keys(next).sort((a, b) => (a[0] === b[0] ? Number(a.slice(1)) - Number(b.slice(1)) : a < b ? -1 : 1));
  return keys.length ? Object.fromEntries(keys.map((k) => [k, next[k]])) : undefined;
}

/** One column's setting, with unset (or invalid) fields null. */
export function columnLook(cols, key) {
  const c = cols?.[key] ?? {};
  return { align: TABLE_COL_ALIGNS.has(c.align) ? c.align : null, width: Number.isInteger(c.width) && !columnWidthError(c.width) ? c.width : null };
}

/** The width one arrow press (or a drag) leads to: `dir` is steps (+1 wider, -1 narrower); automatic starts from `drawn`. Stops at the bounds. */
export function nudgeWidth(current, dir, drawn) {
  const from = current ?? Math.round(drawn ?? COL_MIN);
  return Math.min(COL_MAX, Math.max(COL_MIN, Math.round(from + dir * COL_STEP)));
}

/** Workbook restore: the valid part of a saved format.tableCols, or undefined; each dropped piece is reported. */
export function cleanTableCols(v, where, issues) {
  if (v == null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) { issues.push(`${where}: column settings were invalid — cleared.`); return undefined; }
  const out = {};
  let reports = 0, dropped = 0;
  const report = (msg) => { if (reports++ < MAX_REPORTS) issues.push(`${where}: ${msg}`); else dropped++; }; // a hand-edited file can't flood the list
  for (const [k, e] of Object.entries(v)) {
    if (!keyOk(k)) { report(`column ${String(k).slice(0, 12)} is not a known column — removed.`); continue; }
    if (!e || typeof e !== "object" || Array.isArray(e)) { report(`column ${k} was invalid — removed.`); continue; }
    const entry = {};
    if (e.align != null) { // null reads as unset, like an absent field
      if (TABLE_COL_ALIGNS.has(e.align)) entry.align = e.align;
      else report(`column ${k} alignment "${String(e.align).slice(0, 20)}" — reset to the table setting.`);
    }
    if (e.width != null) {
      const err = columnWidthError(e.width);
      if (err === null) entry.width = e.width;
      else report(`column ${k} width "${String(e.width).slice(0, 20)}" — reset to automatic.`);
    }
    if (Object.keys(entry).length) out[k] = entry;
  }
  if (dropped) issues.push(`${where}: ${dropped} more column setting${dropped === 1 ? "" : "s"} removed.`);
  return Object.keys(out).length ? out : undefined;
}
