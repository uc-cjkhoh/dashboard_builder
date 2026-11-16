// Pure wording + comparison for the relationship dialog's "Check this join" (no DOM). Unit-tested in
// tests/js/join-preview-model.test.mjs. Input is the POST /api/relationships/preview result: per side
// { rows, nullRows, keys, matchedKeys, matchedRows, maxDuplicates, avgDuplicates } over the rows examined.
// A relationship is the user's declaration (golden rule 5): nothing here blocks anything, it only warns.

import { sqlWire } from "../Core/source-model.js";

// One end: the table and key column, plus the card's custom SQL (`source`) when it has any, so the check reads the query's rows.
const end = (entity, column) => ({ db: entity.db, table: entity.table, column, ...(entity.customSql ? { source: sqlWire(entity.db, entity.table, entity.customSql) } : {}) });

/** The request body for one key (a pair, plus extra `pairs` [{ from, to }] for a compound one); each entity is { db, table }. */
export const previewRequest = (fromEntity, fromColumn, toEntity, toColumn, pairs = []) => ({
  from: end(fromEntity, fromColumn),
  to: end(toEntity, toColumn),
  ...(pairs.length ? { pairs: pairs.map((p) => ({ left: p.from, right: p.to })) } : {}), // a compound key's extra pairs
});

/** A share as whole-number text; never a false "0%" or "100%" for a share that isn't quite. */
export function pct(share) {
  if (share <= 0) return "0%";
  if (share >= 1) return "100%";
  if (share < 0.01) return "<1%";
  if (share > 0.995) return ">99%";
  return `${Math.round(share * 100)}%`;
}

const repeats = (side) => side.maxDuplicates > 1;
const share = (n, of) => (of > 0 ? n / of : 0);

/** "1:1" | "1:N" | "N:1" | "N:M": the shape the data shows. The first letter is the FROM side; a side is "N" when one of its keys repeats. */
export function observedCardinality(result) {
  const f = repeats(result.from), t = repeats(result.to);
  return f && t ? "N:M" : `${f ? "N" : "1"}:${t ? "N" : "1"}`;
}

const READING = { "1:1": "one-to-one", "1:N": "one-to-many", "N:1": "many-to-one", "N:M": "many-to-many" };

/** A side repeats "materially" when its keys average at least this many rows each (10% more rows than keys). One stray
 *  duplicate among thousands of keys is not a fan-out worth an amber warning. */
export const MATERIAL_AVG = 1.1;
export const repeatsMaterially = (side) => repeats(side) && side.avgDuplicates >= MATERIAL_AVG;

function times(table, column, side) {
  if (!repeats(side)) return `each ${column} key appears once in ${table}`;
  const avg = Math.round(side.avgDuplicates * 10) / 10;
  return `each ${column} key appears about ${avg} times in ${table}`;
}

/**
 * Plain-words reading of a preview. `declared` is the saved cardinality ("1:N") or undefined for a link not yet saved.
 * Returns { observed, summary, verdict, findings: [{ level: "warn" | "info", text }] }.
 * A sampled result (either side reached the row bound) covers arbitrary, possibly non-overlapping slices of the two
 * tables: shares are worded "within the sample", the sampling caveat comes first, and conclusions that need the two
 * slices to overlap (no matches; fan-out across the join) are information, never a warning. A repeat inside one side
 * is a fact about that table either way, so a declared "one" side that repeats still warns.
 */
export function describePreview(result, { fromTable, toTable, fromColumn, toColumn, declared }) {
  const { from, to } = result;
  const sampled = result.sampled === true;
  const observed = observedCardinality(result);
  const findings = [];
  const summary = [];
  if (sampled)
    findings.push({ level: "info", text: `Based on the first ${result.sampleLimit.toLocaleString("en-US")} rows of each table, in no particular order. The two samples may not overlap, and a table read twice can give different rows, so the whole tables may read differently.` });
  if (from.rows === 0 || to.rows === 0) {
    findings.push({ level: "info", text: `${from.rows === 0 ? fromTable : toTable} is empty (or has no rows in the examined range), so there is nothing to compare.` });
    return { observed, summary, verdict: "", findings };
  }

  const mf = share(from.matchedRows, from.rows), mt = share(to.matchedRows, to.rows);
  const lead = sampled ? "Within the sample, " : "";
  const rowsOf = sampled ? "the rows read from" : "the rows in";
  summary.push(`${lead}${pct(mf)} of ${rowsOf} ${fromTable} have a match in ${toTable}; ${pct(1 - mf)} don't.`);
  summary.push(`${lead}${pct(mt)} of ${rowsOf} ${toTable} have a match in ${fromTable}; ${pct(1 - mt)} don't.`);
  summary.push(`${times(fromTable, fromColumn, from).replace(/^./, (c) => c.toUpperCase())}; ${times(toTable, toColumn, to)}.`);
  const verdict = `The data looks ${READING[observed]} (${observed})${sampled ? " within the sample" : ""}.`;

  if (from.matchedKeys === 0 || to.matchedKeys === 0)
    findings.push(sampled
      ? { level: "info", text: `No keys match within the sample. A sample can't tell whether ${fromTable}.${fromColumn} and ${toTable}.${toColumn} match across the whole tables.` }
      : { level: "warn", text: `No keys match at all. Check that ${fromTable}.${fromColumn} and ${toTable}.${toColumn} are the right columns.` });
  for (const [t, c, s] of [[fromTable, fromColumn, from], [toTable, toColumn, to]])
    if (s.nullRows > 0) findings.push({ level: "info", text: `${pct(share(s.nullRows, s.rows))} of ${t} rows have no ${c} (NULL); a NULL key never matches.` });

  const oneMarks = declared && /^[1N]:[1NM]$/.test(declared) ? declared.split(":") : [];
  const declaredOne = (i) => oneMarks[i] === "1";
  if (repeats(from) && repeats(to)) {
    if (sampled)
      findings.push({ level: "info", text: "Keys repeat on both sides within the sample, so the join may be many-to-many: joined rows could multiply and sums and counts could double-count." });
    else if (repeatsMaterially(from) && repeatsMaterially(to))
      findings.push({ level: "warn", text: `Keys repeat on both sides (many-to-many): joined rows multiply, so sums and counts from either table can double-count.${declaredOne(0) || declaredOne(1) ? ` You chose ${declared}.` : ""}` });
    else
      findings.push({ level: "info", text: "A few keys repeat on both sides (the average is close to one row per key), so only a few rows multiply." });
  }
  // "1" on a side declares that side's keys unique; the data disagrees when they repeat. When both sides repeat the
  // combined note above already says so, so this adds a warning only for the one-sided case.
  if (!(repeats(from) && repeats(to)))
    for (const [i, t, s] of [[0, fromTable, from], [1, toTable, to]])
      if (declaredOne(i) && repeats(s))
        findings.push({ level: "warn", text: `You chose ${t} as the "one" side, but a key there repeats up to ${s.maxDuplicates} times, so joined rows will multiply. Make it the many side or use a unique key.` });
  return { observed, summary, verdict, findings };
}

const count = (n) => Number(n).toLocaleString("en-US");
const withShare = (n, of) => `${count(n)} (${pct(share(n, of))})`;
const avgText = (side) => (side.keys > 0 ? String(Math.round(side.avgDuplicates * 10) / 10) : "—");

/**
 * The evidence behind the suggestion, from the same preview result: why each side reads as "one" or "many"
 * (`reasons`, one per side, the FROM side first) and the raw counts per side (`rows`: { label, from, to } as text).
 * An empty side gives no reasons (there is nothing to read a shape from). On a sampled result a "one" side is worded as what the
 * sample shows, not as a fact about the table.
 */
export function joinEvidence(result, { fromTable, toTable, fromColumn, toColumn }) {
  const { from, to } = result;
  const sampled = result.sampled === true;
  const reasons = [];
  if (from.rows > 0 && to.rows > 0)
    for (const [t, c, s] of [[fromTable, fromColumn, from], [toTable, toColumn, to]])
      reasons.push(repeats(s)
        ? { side: "many", text: `${c} repeats in ${t}: up to ${count(s.maxDuplicates)} rows for one key (about ${avgText(s)} on average), so ${t} is the "many" side.` }
        : sampled // a sample can show a repeat, never that every key is unique
          ? { side: "one", text: `${c} doesn't repeat in the rows read from ${t}, so ${t} looks like the "one" side. Rows past the sample could still repeat a key.` }
          : { side: "one", text: `${c} is unique in ${t}: every key has one row, so ${t} is the "one" side.` });
  const rows = [
    { label: "Rows read", from: count(from.rows), to: count(to.rows) },
    { label: "Rows with no key (NULL)", from: withShare(from.nullRows, from.rows), to: withShare(to.nullRows, to.rows) },
    { label: "Distinct keys", from: count(from.keys), to: count(to.keys) },
    { label: "Keys found in the other table", from: withShare(from.matchedKeys, from.keys), to: withShare(to.matchedKeys, to.keys) },
    { label: "Rows with a match", from: withShare(from.matchedRows, from.rows), to: withShare(to.matchedRows, to.rows) },
    { label: "Most rows for one key", from: count(from.maxDuplicates), to: count(to.maxDuplicates) },
    { label: "Average rows per key", from: avgText(from), to: avgText(to) },
  ];
  return { reasons, rows };
}

/** The suggestion's headline: "N:1 · many-to-one". */
export const suggestionLabel = (observed) => `${observed} · ${READING[observed]}`;
