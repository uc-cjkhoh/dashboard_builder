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
