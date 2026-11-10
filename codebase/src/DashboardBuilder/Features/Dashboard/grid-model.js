// Pure helpers that pivot flat grouped rows into the nested tuples a crosstab, colour split, heatmap or treemap
// needs. No DOM, no state — shared by the render modules and unit-tested in tests/js/result-model.test.mjs.

/** A tuple of group-by values as one string key (null and "" are the same member). */
export function tupleKey(tuple) { return tuple.map((v) => (v ?? "")).join("\u0000"); }

/** The distinct tuples of a list, in first-seen order. */
export function uniqueTuples(list) {
  const seen = new Set(); const out = [];
  for (const t of list) { const k = tupleKey(t); if (!seen.has(k)) { seen.add(k); out.push(t); } }
  return out;
}
// Run-length groups of consecutive leaves sharing keyFn — for colSpan on the top header.
export function runs(leaves, keyFn) {
  const out = [];
  for (let i = 0; i < leaves.length;) {
    let j = i + 1; const k = keyFn(leaves[i]);
    while (j < leaves.length && keyFn(leaves[j]) === k) j++;
    out.push({ leaf: leaves[i], span: j - i });
    i = j;
  }
  return out;
}
// Per-leaf rowSpan for dimension level `ll`: the group size at each group's first leaf, else 0
// (that cell is covered by the rowSpan above) — for merging repeated row-stub headers.
export function levelSpans(leaves, ll) {
  const spans = new Array(leaves.length).fill(0);
  for (let i = 0; i < leaves.length;) {
    let j = i + 1; const k = tupleKey(leaves[i].tuple.slice(0, ll + 1));
    while (j < leaves.length && tupleKey(leaves[j].tuple.slice(0, ll + 1)) === k) j++;
    spans[i] = j - i;
    i = j;
  }
  return spans;
}

/**
 * Column members in ascending order (numbers numerically, text naturally, empty last), so the headers follow the same rule as the
 * rows (a saved descending sort gives descending headers; empty stays last). `keepOrder` leaves the query's order alone — a sort on a measure orders the columns too.
 */
export function orderColumnTuples(tuples, keepOrder, dir = "asc") {
  if (keepOrder) return tuples;
  const cmp = (a, b) => {
    if (a == null || a === "") return b == null || b === "" ? 0 : 1;
    if (b == null || b === "") return -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  };
  const sign = dir === "desc" ? -1 : 1;
  return [...tuples].sort((x, y) => { for (let i = 0; i < Math.max(x.length, y.length); i++) { const a = x[i], b = y[i]; const empty = (v) => v == null || v === ""; if (empty(a) !== empty(b)) return empty(a) ? 1 : -1; const c = cmp(a, b); if (c) return sign * c; } return 0; });
}
