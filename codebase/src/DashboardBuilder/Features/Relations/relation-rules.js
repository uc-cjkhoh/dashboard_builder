// Pure rules for drawing a relationship (no DOM). Unit-tested in tests/js/relation-rules.test.mjs.
const KIND = { numeric: "number", text: "text", temporal: "date", boolean: "boolean" };
export const keysCompatible = (a, b) => Boolean(KIND[a]) && KIND[a] === KIND[b];
const sameEnd = (p, q) => p.entityId === q.entityId && p.column === q.column;
export function findDuplicate(relationships, from, to) {
  for (const r of relationships)
    if ((sameEnd(r.from, from) && sameEnd(r.to, to)) || (sameEnd(r.from, to) && sameEnd(r.to, from))) return r;
  return null;
}
export function linkProblem({ relationships, from, to, fromCategory, toCategory, fromLabel, toLabel }) {
  if (from.entityId === to.entityId) return "Pick a key on a different table.";
  if (findDuplicate(relationships, from, to)) return `${fromLabel} and ${toLabel} are already related.`;
  if (!keysCompatible(fromCategory, toCategory))
    return `Can't relate ${fromLabel} (${fromCategory}) to ${toLabel} (${toCategory}) — join keys must hold the same kind of value.`;
  return null;
}

// T02-12 / T02-13 join types. A relationship runs FROM → TO: FROM is the left side, TO the right.
// "left" keeps every row of FROM's table, "right" every row of TO's table, "full" both; "inner" only matches.
export const JOIN_TYPES = ["inner", "left", "right", "full"];
export const normalizeJoinType = (t) => (JOIN_TYPES.includes(t) ? t : "inner");

/** The dialog's radio options, worded with the two table names (never colour alone). A legacy left link
 *  (saved before sides were fixed) also gets its own choice, so it is never mislabelled "keep the FROM table". */
export function joinChoices(fromTable, toTable, legacy = false) {
  return [
    { value: "inner", text: "Inner — only rows that match" },
    ...(legacy ? [{ value: "legacy", text: "Keep rows of the base table (older link)" }] : []),
    { value: "left", text: `Keep all rows of ${fromTable}` },
    { value: "right", text: `Keep all rows of ${toTable}` },
    { value: "full", text: "Keep all rows of both" },
  ];
}

/** A link saved before right/full existed ("left", not tagged `joinFixed`) keeps the BASE-side table in either direction. */
export const isLegacyLeft = (type, fixed) => type === "left" && fixed !== true;
/** The radio value that stands for a saved link, and the saved fields a radio value stands for. */
export const joinSelection = (type, fixed) => (isLegacyLeft(type, fixed) ? "legacy" : normalizeJoinType(type));
export const joinFromSelection = (value) =>
  value === "legacy" ? { joinType: "left", joinFixed: false } : { joinType: normalizeJoinType(value), joinFixed: true };

/** The type to send for one join step. A fixed link's sides are its own (FROM = left, TO = right), and the view
 *  joins tables outward from its base, so a fixed link crossed TO → FROM (forward = false) swaps left and right.
 *  A legacy left (not fixed) is always LEFT: it keeps the base side in either direction. */
export function planJoinType(type, forward, fixed = false) {
  const t = normalizeJoinType(type);
  if (forward || isLegacyLeft(t, fixed) || (t !== "left" && t !== "right")) return t;
  return t === "left" ? "right" : "left";
}

export const joinBadge = (cardinality, type) => {
  const t = normalizeJoinType(type);
  return t === "inner" ? cardinality : `${cardinality} · ${t}`;
};
