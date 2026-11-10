// Pure rules for the raw-row views (no DOM): the schema browser's table preview and the worksheet's
// "View data". Builds POST /api/rows requests, notes what could not be applied, and shapes the rows for
// display and CSV. Unit-tested in tests/js/rows-model.test.mjs; the limits mirror ClickHouse/RequestValidation.cs.
import { LIMITS } from "../Core/validate.js";
import { calcOnTable } from "../Calc/calc-tree.js";

export const DEFAULT_LIMIT = 100;   // server ApiLimits.DefaultRowsLimit
export const PREVIEW_LIMIT = 20;    // a table preview is deliberately small

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function checkedLimit(limit, columnCount = 0) {
  const n = limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n < 1 || n > LIMITS.viewRows) throw new Error(`Limit must be between 1 and ${LIMITS.viewRows}.`);
  if (columnCount * n > LIMITS.viewCells)
    throw new Error(`${columnCount} columns allow at most ${Math.floor(LIMITS.viewCells / columnCount)} rows — ask for fewer rows or columns (${LIMITS.viewCells.toLocaleString("en-US")} cells in all).`);
  return n;
}
/** Does any cell show the server's cut (cells over 1000 characters come back as 1000 + "…")? */
export const anyCellCut = (rows) => rows.some((r) => r.some((v) => typeof v === "string" && v.length > MAX_CELL && v.endsWith("…")));
export const CUT_NOTE = "Some cells were cut at 1000 characters; the CSV export has the cut text too.";
const MAX_CELL = 1000;
const wire = (f) => ({ column: f.column, op: f.op, value: f.value ?? "", values: f.values ?? null, ...(f.calc ? { calc: f.calc } : {}) });

/** The first rows of one table, unfiltered. */
export function tableRowsRequest(db, table, limit = PREVIEW_LIMIT, columns) {
  return { db, table, ...(columns ? { columns } : {}), limit: checkedLimit(limit, columns?.length ?? 0) };
}

/**
 * The rows behind a worksheet view. `plan` is the sheet's query plan WITHOUT its click selection (the caller
 * builds it so); the rows are those of its base table (`plan.from`) narrowed by the view's own filters that
 * sit on that table (a calculated one only when it reads that table alone), plus the selected mark as a bound `=` filter. Filters on joined tables, a selection on
 * a joined table, a NULL mark and Top-N rankings can't be applied to a single-table read: they are left out
 * and named in `notes`, never dropped silently.
 */
export function buildRowsRequest({ plan, selection = null, limit, castOf = () => undefined, base = null }) {
  const { db, table } = base ?? plan.from;
  const here = (x) => x.db === db && x.table === table;
  const notes = [];
  const filters = [];
  let joined = 0, top = 0, casted = 0, calcs = 0;
  for (const f of plan.filters ?? []) {
    if (f.op === "top") top++;
    else if (f.calc) { if (calcOnTable(f.calc, db, table)) filters.push(wire(f)); else calcs++; } // evaluated by the single-table read only when it reads this table alone
    else if (f.cast) casted++; // /api/rows compares the stored column, so a cast field's filter would match wrong rows
    else if (!here(f)) joined++;
    else filters.push(wire(f));
  }
  if (joined) notes.push(`${plural(joined, "filter", "filters")} on a joined table ${joined === 1 ? "isn't" : "aren't"} applied.`);
  if (calcs) notes.push(`${plural(calcs, "filter", "filters")} on a calculated field across tables ${calcs === 1 ? "isn't" : "aren't"} applied to rows.`);
  if (top) notes.push("Top-N filters aren't applied to rows.");
  if (casted) notes.push(`${plural(casted, "filter", "filters")} on a field with a data type cast ${casted === 1 ? "isn't" : "aren't"} applied to rows.`);
  if (selection) {
    if (!here(selection)) notes.push("The selected mark is on a joined table, so it isn't applied.");
    else if (castOf(selection)) notes.push("The selected mark is on a field with a data type cast, so it isn't applied to rows.");
    else if (selection.value === null || selection.value === undefined) notes.push("The selected mark is NULL, which can't be matched — it isn't applied.");
    else filters.push({ column: selection.column, op: "=", value: String(selection.value), values: null });
  }
  return { request: { db, table, filters, limit: checkedLimit(limit) }, notes };
}

/** The table of the first measure (`measures`: the sheet's planMeasures entries), the fact table behind the numbers. A
 *  calculated pill has no single table here, so it is skipped; null when no measure names one (D95). */
export function firstMeasureTable(measures) {
  const e = measures.find((m) => m.field && !m.field.calc && m.field.db && m.field.table);
  return e ? { db: e.field.db, table: e.field.table } : null;
}

/** The View data dialog's title: the table plainly, then the whole view or the selected mark. */
export const viewDataTitle = ({ db, table }, markLabel) => `Rows of ${db}.${table} behind ${markLabel ?? "this view"}`;

/** A cell for display: SQL NULL reads as "NULL" (flagged so it can be styled and is not mistaken for text). */
export const cellText = (v) => (v === null || v === undefined ? { text: "NULL", isNull: true } : { text: String(v), isNull: false });

/** "2 rows" / "No rows" / "First 100 rows — more exist". */
export function rowsSummary({ rows, truncated }) {
  const n = rows.length;
  if (truncated) return `First ${plural(n, "row", "rows")} — more exist`;
  return n === 0 ? "No rows" : plural(n, "row", "rows");
}

const esc = (v) => {
  let s = v ?? "";
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;           // a spreadsheet must not run an exported cell
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** RFC-4180 CSV of the rows shown (same quoting and formula guard as the server's CsvUtil). */
export function rowsToCsv(columns, rows) {
  const lines = [columns.map((c) => esc(c.name)).join(","), ...rows.map((r) => r.map(esc).join(","))];
  return lines.join("\r\n") + "\r\n";
}
