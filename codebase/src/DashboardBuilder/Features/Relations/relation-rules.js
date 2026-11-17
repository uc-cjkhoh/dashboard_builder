// Pure rules for drawing a relationship (no DOM). Unit-tested in tests/js/relation-rules.test.mjs.
const KIND = { numeric: "number", text: "text", temporal: "date", boolean: "boolean" };
export const keysCompatible = (a, b) => Boolean(KIND[a]) && KIND[a] === KIND[b];
const sameEnd = (p, q) => p.entityId === q.entityId && p.column === q.column;
export function findDuplicate(relationships, from, to) {
  for (const r of relationships)
    if ((sameEnd(r.from, from) && sameEnd(r.to, to)) || (sameEnd(r.from, to) && sameEnd(r.to, from))) return r;
  return null;
}
/** Every column end a relationship uses: its first pair, then the extra pairs of a compound key (`pairs: [{ from, to }]`, column names on the same two tables). */
export const relEnds = (r) => [r.from, r.to, ...(r.pairs ?? []).flatMap((p) => [{ entityId: r.from.entityId, column: p.from }, { entityId: r.to.entityId, column: p.to }])];
/** The key columns of card `entityId` whose kind (number / text / date / boolean) would change, with a new `columns` list (what an edited query
 *  or the table itself returns), to one that no longer fits the column on the other end of a relationship (`keysCompatible`). A key that is
 *  gone from `columns` is not reported here (`lostKeys` does that); a key whose kind is unchanged is never reported.
 *  `relationships` is any iterable of relationships (the card's, or all), `entities` the store's Map; returns [{ column, now, other, partner }]: the column, the kind it would have, the kind
 *  the other end has, and that end as "table.column". */
export function keyKindBreaks(entityId, relationships, entities, columns) {
  const mine = entities.get(entityId), out = [], seen = new Set();
  for (const r of relationships) {
    const ends = [[r.from, r.to], ...(r.pairs ?? []).map((p) => [{ entityId: r.from.entityId, column: p.from }, { entityId: r.to.entityId, column: p.to }])];
    for (const [a, b] of ends) {
      const [self, other] = a.entityId === entityId ? [a, b] : b.entityId === entityId ? [b, a] : [null, null];
      if (!self || seen.has(self.column)) continue;
      const now = columns.find((c) => c.name === self.column);
      const was = mine?.columns?.find((c) => c.name === self.column);
      const partner = entities.get(other.entityId), theirs = partner?.columns?.find((c) => c.name === other.column);
      if (!now || !theirs || was?.category === now.category || keysCompatible(now.category, theirs.category)) continue;
      seen.add(self.column);
      out.push({ column: self.column, now: kindLabel(now.category), other: kindLabel(theirs.category), partner: `${partner.table}.${other.column}` });
    }
  }
  return out;
}

/** The relationship a column is already in (a column holds at most one), or null. */
export function relationshipOf(relationships, end) {
  for (const r of relationships) if (relEnds(r).some((e) => sameEnd(e, end))) return r;
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

/** The relationship that already joins cards `a` and `b` (either way round), or null. A table pair holds one relationship (D127):
 *  relating two more of their columns adds a key pair to it instead of making a second one. */
export function relationBetween(relationships, a, b) {
  for (const r of relationships)
    if ((r.from.entityId === a && r.to.entityId === b) || (r.from.entityId === b && r.to.entityId === a)) return r;
  return null;
}

/** Ends `a` / `b` (any order) as a key pair of `rel`, oriented to its sides: { from, to } column names. */
export const pairFor = (rel, a, b) => (rel.from.entityId === a.entityId ? { from: a.column, to: b.column } : { from: b.column, to: a.column });

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

// Join types. A relationship runs FROM → TO: FROM is the left side, TO the right.
// "left" keeps every row of FROM's table, "right" every row of TO's table, "full" both; "inner" only matches.
export const JOIN_TYPES = ["inner", "left", "right", "full"];
export const normalizeJoinType = (t) => (JOIN_TYPES.includes(t) ? t : "inner");

/** The dialog's cardinality cards, in the 2 x 2 order (1:1, 1:N / N:1, N:M): the kind in words with its short code, no hint (the code
 *  is what the canvas badge and the suggestion show). */
export function cardinalityChoices() {
  return [
    { value: "1:1", text: "One to one (1:1)" },
    { value: "1:N", text: "One to many (1:N)" },
    { value: "N:1", text: "Many to one (N:1)" },
    { value: "N:M", text: "Many to many (N:M)" },
  ];
}

/** The dialog's join cards: the SQL join name only, no hint (the Relationships card says in words which rows are shown). A legacy
 *  left link (saved before sides were fixed) also gets its own choice, so it is never mislabelled "keep the FROM table". */
export function joinChoices(legacy = false) {
  return [
    { value: "inner", text: "Inner join" },
    ...(legacy ? [{ value: "legacy", text: "Left join (older link)" }] : []),
    { value: "left", text: "Left join" },
    { value: "right", text: "Right join" },
    { value: "full", text: "Full outer join" },
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

/** The badge text; `extra` is the number of extra key pairs (a compound key says how many keys it joins on). */
export const joinBadge = (cardinality, type, extra = 0) => {
  const t = normalizeJoinType(type);
  const base = t === "inner" ? cardinality : `${cardinality} · ${t}`;
  return extra > 0 ? `${base} · ${extra + 1} keys` : base;
};

// Aggregate before joining (P43). A relationship may ask the view to total each table by the join key before the two meet, so a measure
// is not repeated when the other side repeats the key. `filterDirection` is "both" (a filter on either table also limits the other; the default,
// never stored) or "single" (a filter changes only its own table). Saved as `aggregateFirst` / `filterDirection` on the relationship.
export const FILTER_DIRECTIONS = ["both", "single"];
export const normalizeFilterDirection = (d) => (d === "single" ? "single" : "both");
/** Put the dialog's two choices on a relationship: only what differs from the plain join is stored. */
export function applyAggregate(rel, { aggregate, direction }) {
  delete rel.aggregateFirst; delete rel.filterDirection;
  if (aggregate !== true) return rel;
  rel.aggregateFirst = true;
  if (normalizeFilterDirection(direction) === "single") rel.filterDirection = "single";
  return rel;
}
/** A saved relationship's two dialog controls. */
export const aggregateChoice = (rel) => ({ aggregate: rel?.aggregateFirst === true, direction: rel?.aggregateFirst === true ? normalizeFilterDirection(rel.filterDirection) : "both" });

// The cardinality a new link's dialog starts on, read from the two column names (the user still picks; Confirm saves).
// A column is the table's own key when it is "id" / "key" or "<table>_id" / "<table>id" (table name singular or plural):
// orders.customer_id dropped on customers.id reads many-to-one (N:1); the reverse drag reads 1:N; key to key reads 1:1.
// Names that say nothing keep the old default, 1:N.
export const singular = (t) => (t.endsWith("ies") ? `${t.slice(0, -3)}y` : t.endsWith("ses") ? t.slice(0, -2) : t.endsWith("s") ? t.slice(0, -1) : t);
export function isOwnKey(column, table) {
  const c = String(column ?? "").toLowerCase(), t = String(table ?? "").toLowerCase();
  if (c === "id" || c === "key") return true;
  return [t, singular(t)].some((n) => n && (c === `${n}_id` || c === `${n}id` || c === `${n}_key`));
}
export function guessCardinality(fromColumn, fromTable, toColumn, toTable) {
  const fromKey = isOwnKey(fromColumn, fromTable), toKey = isOwnKey(toColumn, toTable);
  if (fromKey && toKey) return "1:1";
  if (toKey) return "N:1";
  return "1:N";
}
