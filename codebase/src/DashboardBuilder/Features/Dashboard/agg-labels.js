// Dashboard/agg-labels.js — plain names for the aggregations (pure, DOM-free). The saved values (`avg`, `countDistinct`…) never change;
// only what the menus, pills and captions show does.
import { isCalc, calcName } from "./table-calc.js";

export const AGG_LABELS = Object.freeze({
  sum: "Sum", avg: "Average", min: "Minimum", max: "Maximum", median: "Median", percentile: "Percentile…",
  stddev: "Standard deviation", variance: "Variance", count: "Count", countDistinct: "Count distinct",
  countNonNull: "Count non-empty", attr: "Attribute (single value)",
});
export const aggLabel = (a) => AGG_LABELS[a] ?? String(a);

/**
 * What a measure pill shows beside its name: { agg, calc } — the aggregation (raw id, "percentile p90" for a percentile) and the
 * table calculation's short name (null when none). null for a dimension pill and for a calculated field that aggregates itself.
 */
export function pillMarker(f, { measure, calcPill = false }) {
  if (!measure || (calcPill && !f.agg)) return null;
  const agg = f.agg ?? "sum";
  const pct = Number.isFinite(Number(f.p)) ? Math.round(Number(f.p) * 1000) / 10 : null;
  return { agg: agg === "percentile" && pct != null ? `percentile p${pct}` : agg, calc: isCalc(f.tableCalc) ? calcName(f.tableCalc) : null };
}
