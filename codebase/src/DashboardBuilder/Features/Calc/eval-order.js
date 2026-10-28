// Calculated fields — the "How this is computed" explainer text (pure, DOM-free; tests/js/eval-order.test.mjs).
// Six stages in the order the sheet is really evaluated; plain text generated from a summary of the sheet.

import { pillSlots, isCalcPill } from "./calc-pill.js";
import { effectiveTopN } from "../Core/parameters-model.js";
import { LIMITS } from "../Core/validate.js";
import { scalePlan } from "../Dashboard/scale-model.js";
import { roleOf } from "../Dashboard/show-me-rules.js";
import { calcName } from "../Dashboard/table-calc.js";

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * `s = { ownFilters, sharedFilters, drillDepth, hasPage, hasSelection, hasPeriod, hasTopFilter, rowLevelCalcs,
 *        aggregateCalcs, dimensions, displayCap, otherBucket, tableCalcs }`
 * Returns six `{ n, title, text }` entries.
 */
export function describeEvaluation(input) {
  const s = { dimensions: [], tableCalcs: [], ...input };
  s.dimensions = s.dimensions ?? [];
  s.tableCalcs = s.tableCalcs ?? [];
  const filters = [];
  if (s.ownFilters > 0) filters.push(`${s.ownFilters} own`);
  if (s.sharedFilters > 0) filters.push(`${s.sharedFilters} shared`);
  if (s.drillDepth > 0) filters.push(`drill ${plural(s.drillDepth, "level")}`);
  if (s.hasPage) filters.push("page");
  if (s.hasSelection) filters.push("selection");
  if (s.hasPeriod) filters.push("date range");
  if (s.hasTopFilter) filters.push("Top-N filter");
  const stage1 = filters.length === 0
    ? "No filters."
    : `ClickHouse first narrows the rows with ${filters.join(", ")}.`;

  const stage2 = s.rowLevelCalcs > 0
    ? `${plural(s.rowLevelCalcs, "row-level calculation")} ${s.rowLevelCalcs === 1 ? "is" : "are"} worked out for each remaining row.`
    : "There are no row-level calculations to work out.";

  const stage3 = s.dimensions.length > 0
    ? `Rows are grouped by ${s.dimensions.join(", ")}.`
    : "There are no dimensions, so all rows form a single group.";

  const stage4 = s.aggregateCalcs > 0
    ? `Each group is aggregated, including ${plural(s.aggregateCalcs, "aggregate calculation")}.`
    : "Each group is aggregated.";

  const stage5 = `Results are capped at ${Number.isFinite(s.displayCap) ? plural(s.displayCap, "group") : "the display cap"}${s.otherBucket ? ", and the groups past the cap are combined into an Other bucket" : ""}.`;

  const stage6 = s.tableCalcs.length > 0
    ? `Table calculations (${s.tableCalcs.join(", ")}) run in the browser on the returned groups.`
    : "There are no table calculations to run in the browser.";

  return [
    { n: 1, title: "Filters", text: stage1 },
    { n: 2, title: "Row-level calculations", text: stage2 },
    { n: 3, title: "Group by", text: stage3 },
    { n: 4, title: "Aggregates", text: stage4 },
    { n: 5, title: "Cap and Other", text: stage5 },
    { n: 6, title: "Table calculations", text: stage6 },
  ];
}

const defaultName = (f) => (isCalcPill(f) ? f.column : `${f.table}.${f.column}`);

/**
 * Summarises a plain sheet object into the `s` that describeEvaluation takes (pure, DOM-free).
 * `{ sharedFilters }` are the shared filters that apply to this sheet; `{ parameters }` feed Top-N;
 * `{ calcs }` is the calculation list (names); `{ isApplied(filter) }` says which own filters the query really sends (default: all); `{ dimensions }` is an explicit group-by name list (default: derived from the shelves); `{ nameOf }` names a pill (default `table.column`, calc pills by `column`).
 * A calc pill is row-level unless it is a measure with no `agg` (makeCalcPill gives row-level measures `agg: "sum"`).
 */
export function evaluationInput(sheet, { sharedFilters = [], parameters = [], calcs = [], nameOf, isApplied = () => true, dimensions } = {}) {
  const sh = sheet ?? {};
  const name = nameOf ?? ((f) => (isCalcPill(f) ? calcs.find((c) => c.id === f.calc)?.name ?? f.column : defaultName(f)));
  const levels = sh.drill?.levels ?? [];
  const drillOn = levels.length >= 2;
  const drillDim = drillOn ? levels[Math.min(sh.drill.depth ?? 0, levels.length - 1)] : null;

  const dims = [];
  if (dimensions) dims.push(...dimensions);
  else if (drillDim) dims.push(name({ ...drillDim, role: "dimension" }));
  for (const k of dimensions ? [] : ["rows", "columns", "color"]) {
    for (const f of sh[k] ?? []) if (roleOf(f) === "dimension") { const n = name(f); if (!dims.includes(n)) dims.push(n); }
  }

  const rowLevel = new Set(), aggregate = new Set();
  for (const f of pillSlots(sh)) {
    if (!isCalcPill(f)) continue;
    (roleOf(f) === "measure" && !f.agg ? aggregate : rowLevel).add(f.calc);
  }

  const tableCalcs = [];
  for (const f of [...(sh.rows ?? []), ...(sh.columns ?? [])]) {
    const t = f?.tableCalc;
    if (t && t.type !== "none") { const n = calcName(t); if (n) tableCalcs.push(n); }
  }

  const topN = effectiveTopN(sh.format, parameters, LIMITS.rows);
  const filters = (sh.filters ?? []).filter((f) => isApplied(f));
  return {
    ownFilters: filters.length,
    sharedFilters: sharedFilters.length,
    drillDepth: drillOn ? Math.min(sh.drill.depth ?? 0, levels.length - 1) : 0,
    hasPage: Boolean(sh.pages),
    hasSelection: Boolean(sh.selection),
    hasPeriod: Boolean(sh.period?.column),
    hasTopFilter: filters.some((f) => f.op === "top"),
    rowLevelCalcs: rowLevel.size,
    aggregateCalcs: aggregate.size,
    dimensions: dims,
    displayCap: topN ?? LIMITS.rows,
    otherBucket: Boolean(scalePlan(sh.chartType, { topN }, dims.length).otherBucket),
    tableCalcs,
  };
}
