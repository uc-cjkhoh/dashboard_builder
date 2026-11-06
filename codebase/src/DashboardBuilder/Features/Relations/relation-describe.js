// Plain-language description of a relationship (pure, no DOM). Feeds the "Relationships" card on the Data Source.
// A relationship runs FROM → TO; cardinality "1:N" means one FROM row relates to many TO rows.

const MATCH = {
  "1:1": (a, b) => `One ${a} row matches at most one ${b} row, and the other way round.`,
  "1:N": (a, b) => `One ${a} row matches many ${b} rows.`,
  "N:1": (a, b) => `Many ${a} rows match one ${b} row.`,
  "N:M": (a, b) => `A row on either side can match many rows on the other.`,
};

/** What the join keeps. `fixed === false` with "left" is a link saved before sides were fixed: it keeps the base table. */
export function keepSentence(joinType, a, b, fixed = true) {
  if (joinType === "left") return fixed === false ? "Keeps every row of the base table; the other side is empty where nothing matches." : `Keeps every ${a} row; ${b} is empty where nothing matches.`;
  if (joinType === "right") return `Keeps every ${b} row; ${a} is empty where nothing matches.`;
  if (joinType === "full") return "Keeps every row of both tables; each side is empty where nothing matches.";
  return "Keeps only rows that match on both sides.";
}

/** `{ from, to, cardinality, joinType, joinFixed, pairs }` + the two table names → { title, keys, sentences }. */
export function describeRelationship(rel, fromTable, toTable) {
  const pairs = [{ from: rel.from.column, to: rel.to.column }, ...(rel.pairs ?? [])];
  const join = (side) => pairs.map((p) => p[side]).join(" + ");
  const sentences = [
    (MATCH[rel.cardinality] ?? MATCH["N:M"])(fromTable, toTable),
    keepSentence(rel.joinType, fromTable, toTable, rel.joinFixed),
  ];
  if (rel.cardinality === "1:N" || rel.cardinality === "N:M") sentences.push(`Totals from ${fromTable} repeat for each matching ${toTable} row.`);
  return {
    title: `${fromTable} → ${toTable}`,
    keys: `${fromTable}.${join("from")} = ${toTable}.${join("to")}`,
    sentences,
  };
}
