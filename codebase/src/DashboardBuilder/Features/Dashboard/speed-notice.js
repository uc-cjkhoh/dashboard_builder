// The approximate-mode line of the info bar (pure, DOM-free; tests/js/speed-notice.test.mjs).
// Counts and sums are scaled back up from a sample; these aggregations are not, so the line says so.
const UNSCALED_AGGS = new Set(["median", "stddev", "variance", "percentile", "attr"]);
export const UNSCALED_NOTE = "median, percentile, standard deviation, variance and ATTR are computed on the sample, not scaled";

const treeUses = (n) => n !== null && typeof n === "object"
  && ((n.k === "agg" && UNSCALED_AGGS.has(n.fn)) || treeUses(n.arg) || treeUses(n.l) || treeUses(n.r) || (Array.isArray(n.args) && n.args.some(treeUses))
  || (Array.isArray(n.whens) && n.whens.some((w) => treeUses(w?.c) || treeUses(w?.t))) || treeUses(n.else));

/** Whether any measure of a request is a median / percentile / stddev / variance / ATTR (plain or inside a calculation). */
export const usesUnscaledAgg = (measures) => (measures ?? []).some((m) => UNSCALED_AGGS.has(m?.agg) || treeUses(m?.calc));

/** The approximate-mode line for a result's `approx` ({ distinct, sample }) and the request's measures; null when exact. */
export function approxNotice(approx, measures) {
  if (!approx) return null;
  const sampled = Boolean(approx.sample);
  const base = `Approximate${approx.distinct ? " — distinct counts estimated" : ""}${sampled ? `${approx.distinct ? ";" : " —"} a ${Math.round(approx.sample * 100)}% sample, scaled up` : ""}`;
  return sampled && usesUnscaledAgg(measures) ? `${base} (${UNSCALED_NOTE})` : base;
}
