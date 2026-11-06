// The box plot's query plan (pure, DOM-free; tests/js/box-plan.test.mjs). A box plot is a worksheet-shaped request to
// POST /api/boxplot: the numeric value is the one row dimension (a column or a row-level calculation — one value per
// row, never an aggregate), the optional group the one column dimension. Joins, filters, calculations, casts and a
// union / unpivot all come from the worksheet's own buildPlan, so they behave exactly as in every other chart.
import { buildPlan } from "./sheet-plan.js";
import { effectiveTopN } from "../Core/parameters-model.js";
import { LIMITS } from "../Core/validate.js";

/** The value (first numeric field) and the group (first other field) of a box-plot sheet; either may be null. */
export function boxFields(sheet) {
  const all = [...(sheet.columns ?? []), ...(sheet.rows ?? [])];
  const value = all.find((f) => f.category === "numeric") ?? null;
  return { value, group: all.find((f) => f !== value && f.category !== "numeric") ?? null };
}

/** The wire plan for a box plot, or `null` when there is no numeric field or its tables can't be related. */
export function boxPlan(sheet, ctx, { crossFilter = null } = {}) {
  const { value, group } = boxFields(sheet);
  if (!value) return null;
  const { having: _having, ...valueField } = value; // a measure filter has no measure to test here (the view says so)
  const synthetic = {
    ...sheet, chartType: "bar", columns: group ? [group] : [],
    rows: [{ ...valueField, role: "measure", agg: "sum" }], marks: {}, color: [], drill: null,
  };
  const plan = buildPlan(synthetic, undefined, ctx, { crossFilter });
  if (!plan) return null;
  const m = plan.measures[0];
  const valueRef = { db: m.db, table: m.table, column: m.column, ...(m.calc ? { calc: m.calc } : {}), ...(m.cast ? { cast: m.cast } : {}) };
  const { measures: _m, having: _h, otherBucket: _o, dateBucket: _d, approximate: _a, sort: _s, offset: _f, withTotal: _t, fresh: _r, ...rest } = plan;
  return { ...rest, rowDimensions: [valueRef], columnDimensions: plan.columnDimensions.slice(0, 1), measures: [], limit: effectiveTopN(sheet.format, ctx.parameters, LIMITS.rows) ?? LIMITS.rows };
}
