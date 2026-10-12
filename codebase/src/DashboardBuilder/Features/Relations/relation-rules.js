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
