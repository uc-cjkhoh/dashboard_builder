// Pure rules for drawing a relationship (no DOM). Unit-tested in tests/js/relation-rules.test.mjs.
const KIND = { numeric: "number", text: "text", temporal: "date", boolean: "boolean" };
export const keysCompatible = (a, b) => Boolean(KIND[a]) && KIND[a] === KIND[b];
const sameEnd = (p, q) => p.entityId === q.entityId && p.column === q.column;
export function findDuplicate(relationships, from, to) {
  for (const r of relationships)
    if ((sameEnd(r.from, from) && sameEnd(r.to, to)) || (sameEnd(r.from, to) && sameEnd(r.to, from))) return r;
  return null;
}
/** The relationship a column is already in (a column holds at most one), or null. */
export function relationshipOf(relationships, end) {
  for (const r of relationships) if (sameEnd(r.from, end) || sameEnd(r.to, end)) return r;
  return null;
}

/** Ids of the cards that take part in no relationship. With fewer than two relatable cards nothing can be related, so none are flagged.
 *  `cards` is `[{ id, source }]`; a union / unpivot (`source`) takes no relationship and is left out. */
export function unlinkedCards(cards, relationships) {
  const relatable = cards.filter((c) => !c.source);
  if (relatable.length < 2) return [];
  const linked = new Set();
  for (const r of relationships) { linked.add(r.from.entityId); linked.add(r.to.entityId); }
  return relatable.filter((c) => !linked.has(c.id)).map((c) => c.id);
}

/** The word a column's category goes by on screen: number, text, date, boolean (anything else keeps its own name). */
export const kindLabel = (category) => KIND[category] ?? category ?? "unknown";

/** Why a link can't be made, or null. `kind` is "type" when the two columns hold different kinds of value (or a kind keys can't use), else "other". */
export function linkIssue({ relationships, from, to, fromCategory, toCategory, fromLabel, toLabel }) {
  const rels = [...relationships]; // may be an iterator: read it more than once
  if (from.entityId === to.entityId) return { kind: "other", message: "Pick a key on a different table." };
  if (findDuplicate(rels, from, to)) return { kind: "other", message: `${fromLabel} and ${toLabel} are already related.` };
  for (const [end, label] of [[from, fromLabel], [to, toLabel]])
    if (relationshipOf(rels, end)) return { kind: "other", message: `${label} is already in a relationship. A column can be in only one.` };
  if (!keysCompatible(fromCategory, toCategory))
    return { kind: "type", message: `Can't relate ${fromLabel} (${fromCategory}) to ${toLabel} (${toCategory}) — join keys must hold the same kind of value.` };
  return null;
}

export function linkProblem(args) { return linkIssue(args)?.message ?? null; }

/** The order a card's pinned key rows take so its links never cross: by where the partner card sits (top edge, top to bottom),
 *  then by when the relationship was made. Both cards of a pair see the same order, so their links run in parallel.
 *  `rows` is [{ column, partnerTop, seq }]; returns the column names. */
export function pinOrder(rows) {
  return [...rows].sort((a, b) => a.partnerTop - b.partnerTop || a.seq - b.seq).map((r) => r.column);
}

/** The cards held out of worksheets: table cards in no relationship while the model has two or more of them. `entities` / `relationships` are the store's Maps. */
export function heldOutCards(entities, relationships) {
  const cards = [...(entities?.values?.() ?? [])].map((e) => ({ id: e.id, source: Boolean(e.source), db: e.db, table: e.table }));
  const lone = new Set(unlinkedCards(cards, relationships?.values?.() ?? []));
  return cards.filter((c) => lone.has(c.id));
}

/** The sentence that refuses a view reading a held-out table, or null. `keys` are "db\0table" (sheet-plan keyOf). */
export function heldOutProblem(keys, entities, relationships) {
  const hit = heldOutCards(entities, relationships).find((c) => keys.includes(`${c.db}\u0000${c.table}`));
  return hit ? `${hit.table} isn't related to another table yet. Relate it in the Data Source to use its fields.` : null;
}

/** Up to `limit` column names of `columns` ([{ name, category }]) that could be joined to a `category` key and are not in a relationship yet. */
export function matchingColumns(columns, category, usedNames = [], limit = 5) {
  const used = new Set(usedNames);
  return columns.filter((c) => keysCompatible(category, c.category) && !used.has(c.name)).slice(0, limit).map((c) => c.name);
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
