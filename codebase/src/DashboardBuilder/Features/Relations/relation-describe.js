// Plain-language description of a relationship (pure, no DOM). Feeds the relationship dialog's "What this link does" block, which rewrites it as the picks change.
// Written for a non-technical reader: every sentence names the table and column ("orders.user_id"), never "FROM/TO", "cardinality" or "join".
// Built for people who skim: short lines, each saying what it is about.
// A relationship runs FROM → TO; cardinality "1:N" means one FROM row relates to many TO rows.

/** `t`, `u`: the two table names; `a`, `b`: their key labels, e.g. "orders.user_id" (a compound key reads "orders.user_id + orders.day").
 *  Two short sentences read faster than one long one: who matches whom, then the key columns that do the matching. */
const MATCH = {
  "1:1": (t, u) => `Each ${t} row matches at most one ${u} row, and the other way around.`,
  "1:N": (t, u) => `One ${t} row can match many ${u} rows.`,
  "N:1": (t, u) => `Many ${t} rows can match the same ${u} row.`,
  "N:M": (t, u) => `Many ${t} rows can match many ${u} rows.`,
};

/** The relationship in three or four plain words (the canvas badge keeps the short "1:N"). */
const KIND = { "1:1": "one to one", "1:N": "one to many", "N:1": "many to one", "N:M": "many to many" };
export const kindWords = (cardinality) => KIND[cardinality] ?? KIND["N:M"];

/** Which rows are shown. `fixed === false` with "left" is a link saved before sides were fixed: it keeps the base table. */
export function keepSentence(joinType, a, b, fixed = true) {
  if (joinType === "left") return fixed === false ? "All rows of the main table, even with no match." : `All ${a} rows, even with no match in ${b}.`;
  if (joinType === "right") return `All ${b} rows, even with no match in ${a}.`;
  if (joinType === "full") return `All rows of ${a} and ${b}, even with no match.`;
  return "Only rows with a match. The others are left out.";
}

/** `{ from, to, cardinality, joinType, joinFixed, pairs }` + the two table names → { title, kind, heads, sentences, tones, refs }. */
export function describeRelationship(rel, fromTable, toTable) {
  const pairs = [{ from: rel.from.column, to: rel.to.column }, ...(rel.pairs ?? [])];
  const label = (table, side) => pairs.map((p) => `${table}.${p[side]}`).join(" + ");
  const sentences = [
    `${(MATCH[rel.cardinality] ?? MATCH["N:M"])(fromTable, toTable)} Matched on ${label(fromTable, "from")} and ${label(toTable, "to")}.`,
    keepSentence(rel.joinType, fromTable, toTable, rel.joinFixed),
  ];
  const tones = ["", ""]; // parallel to sentences: "warn" = a caution (prefixed "Heads up:", never colour alone), "ok" = reassurance
  if (rel.aggregateFirst === true) {
    sentences.push("Each table is totalled by the key first, so nothing is counted twice.");
    tones.push("ok", "");
    sentences.push(rel.filterDirection === "single" ? "Filtering one table does not change the other." : `Filtering ${fromTable} also filters ${toTable}, and the other way around.`);
  } else if (rel.cardinality === "1:N" || rel.cardinality === "N:M")
    tones.push("warn"), sentences.push(`Heads up: totals from ${fromTable} may be counted more than once. Turn on Totals to count each once.`);
  // refs: the names worth marking in the text (table.column labels and table names), longest first so "a.id" wins over "a".
  const refs = [...new Set([label(fromTable, "from"), label(toTable, "to"), ...pairs.flatMap((p) => [`${fromTable}.${p.from}`, `${toTable}.${p.to}`]), fromTable, toTable])].sort((x, y) => y.length - x.length);
  return { title: `${fromTable} → ${toTable}`, kind: kindWords(rel.cardinality), sentences, tones, refs };
}
