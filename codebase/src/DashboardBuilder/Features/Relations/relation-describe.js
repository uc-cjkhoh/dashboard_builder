// Plain-language description of a relationship (pure, no DOM). Feeds the "Relationships" card on the Data Source.
// Written for a non-technical reader: every sentence names the table and column ("orders.user_id"), never "FROM/TO", "cardinality" or "join".
// A relationship runs FROM → TO; cardinality "1:N" means one FROM row relates to many TO rows. The title row already says the tables and the
// badge, so the body carries the columns and what they mean for the rows.

/** `a`, `b`: the two key labels, e.g. "orders.user_id" (a compound key reads "orders.user_id + orders.day"). */
const MATCH = {
  "1:1": (a, b) => `Each row in ${a} can match at most one row in ${b}, and the other way round.`,
  "1:N": (a, b) => `One row in ${a} can match many rows in ${b}.`,
  "N:1": (a, b) => `Many rows in ${a} can match the same row in ${b}.`,
  "N:M": (a, b) => `Many rows in ${a} can match many rows in ${b}.`,
};

/** Which rows are shown. `fixed === false` with "left" is a link saved before sides were fixed: it keeps the base table. */
export function keepSentence(joinType, a, b, fixed = true) {
  if (joinType === "left") return fixed === false ? "Every row of the main table is shown, even when nothing matches it." : `Every ${a} row is shown, even when nothing in ${b} matches it.`;
  if (joinType === "right") return `Every ${b} row is shown, even when nothing in ${a} matches it.`;
  if (joinType === "full") return `Every row of ${a} and ${b} is shown, even when nothing matches it.`;
  return `A row is shown only when it has a match: rows without one in ${a} or ${b} are left out.`;
}

/** `{ from, to, cardinality, joinType, joinFixed, pairs }` + the two table names → { title, sentences, tones, refs }. */
export function describeRelationship(rel, fromTable, toTable) {
  const pairs = [{ from: rel.from.column, to: rel.to.column }, ...(rel.pairs ?? [])];
  const label = (table, side) => pairs.map((p) => `${table}.${p[side]}`).join(" + ");
  const sentences = [
    (MATCH[rel.cardinality] ?? MATCH["N:M"])(label(fromTable, "from"), label(toTable, "to")),
    keepSentence(rel.joinType, fromTable, toTable, rel.joinFixed),
  ];
  const tones = ["", ""]; // parallel to sentences: "warn" = a caution (prefixed "Heads up:", never colour alone), "ok" = reassurance
  if (rel.aggregateFirst === true) {
    sentences.push("Each table is added up by this match first, so nothing is counted twice.");
    tones.push("ok", "");
    sentences.push(rel.filterDirection === "single" ? "Filtering one table does not change the other." : `Filtering ${fromTable} also filters ${toTable}, and the other way round.`);
  } else if (rel.cardinality === "1:N" || rel.cardinality === "N:M")
    tones.push("warn"), sentences.push(`Heads up: because one ${fromTable} row can match several ${toTable} rows, ${fromTable} totals may be counted more than once.`);
  // refs: the names worth marking in the text (table.column labels and table names), longest first so "a.id" wins over "a".
  const refs = [...new Set([label(fromTable, "from"), label(toTable, "to"), ...pairs.flatMap((p) => [`${fromTable}.${p.from}`, `${toTable}.${p.to}`]), fromTable, toTable])].sort((x, y) => y.length - x.length);
  return { title: `${fromTable} → ${toTable}`, sentences, tones, refs };
}
