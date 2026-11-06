// Type cast — pure, DOM-free (tests/js/cast-model.test.mjs). A field setting (`cast`: text | number |
// date, stored in the workbook's field settings) makes the server read that column as another type, so the
// field groups, aggregates and filters as its target category. The pairings and the target categories mirror
// the server's TypeCast.cs; a pairing the server refuses is simply not offered.
import { aggsFor, opsFor } from "./filter-rules.js";
import { pillSlots } from "../Calc/calc-pill.js";

export const CASTS = Object.freeze(["text", "number", "date"]);
const TARGET = { text: "text", number: "numeric", date: "temporal" };
const LABELS = { text: "Text", number: "Number", date: "Date" };
/** What each source category can be read as (server TypeCast.Apply; to the same type is "Original"). */
const CHOICES = { text: ["number", "date"], numeric: ["text"], temporal: ["text"], boolean: ["text", "number"] };

export const castLabel = (cast) => LABELS[cast] ?? "";
/** The casts offered for a column of this (original) category. */
export const castChoices = (category) => CHOICES[category] ?? ["text"];
export const castAllowed = (category, cast) => castChoices(category).includes(cast);
/** The category a field has once cast (its own with no cast). */
export const effectiveCategory = (category, cast) => (cast && TARGET[cast]) || category;

const plain = (r) => r && typeof r === "object" && typeof r.calc !== "object" && typeof r.calc !== "string" && r.db && r.table && r.column;
const tag = (r, castOf) => {
  if (!plain(r)) return r;
  const cast = castOf(r);
  return cast ? { ...r, cast } : r;
};

/** The query plan with each plain column ref (dimension, measure, filter, ranking measure) carrying its field's cast. */
export function withCasts(plan, castOf) {
  const out = { ...plan };
  for (const k of ["rowDimensions", "columnDimensions", "measures"]) if (Array.isArray(plan[k])) out[k] = plan[k].map((r) => tag(r, castOf));
  if (Array.isArray(plan.filters)) out.filters = plan.filters.map((f) => {
    const t = tag(f, castOf);
    return f?.topBy ? { ...t, topBy: tag(f.topBy, castOf) } : t;
  });
  return out;
}

// Bring one stored ref (pill, filter, drill level) in step with its field's current effective category.
function syncRef(r, castOf, baseCategory) {
  if (!r || typeof r.calc === "string" || !r.db || !r.table || !r.column) return false;
  const base = baseCategory(r.db, r.table, r.column);
  if (!base) return false;
  const cat = effectiveCategory(base, castOf(r));
  if (r.category === cat) return false;
  r.category = cat;
  if (cat !== "temporal") { delete r.datePart; delete r.dateLabels; } // a date part / label policy only means something on a date field
  if (r.agg && !aggsFor(cat).includes(r.agg)) { r.agg = aggsFor(cat)[0]; delete r.p; }
  if (r.op && !opsFor(cat).includes(r.op)) { r.op = "="; r.value = ""; r.values = null; delete r.topBy; delete r.bottom; }
  return true;
}

/**
 * After a cast changes: re-categorise every pill, mark, filter, shared filter and drill level of `sheet` that reads
 * a cast (or un-cast) field. Mutates; true when anything changed. `baseCategory(db, table, column)` is the catalog's own.
 */
export function syncCastCategories(sheet, shared, castOf, baseCategory) {
  let changed = false;
  const refs = [...pillSlots(sheet), ...(sheet.filters ?? []), ...(shared ?? []), ...(sheet.drill?.levels ?? [])];
  if (sheet.pages) refs.push(sheet.pages);
  for (const r of refs) if (syncRef(r, castOf, baseCategory)) changed = true;
  return changed;
}

export const STAT_CAST_HINT = "A histogram doesn't use a data type cast yet — set the field's Data type back to Original.";
/** The histogram runs a single-table endpoint that doesn't cast: the hint when a field on the sheet is cast, else null. */
export function statCastProblem(sheet, castOf) {
  if (sheet.chartType !== "histogram") return null;
  const refs = [...(sheet.columns ?? []), ...(sheet.rows ?? []), ...(sheet.filters ?? [])];
  return refs.some((r) => plain(r) && castOf(r)) ? STAT_CAST_HINT : null;
}
