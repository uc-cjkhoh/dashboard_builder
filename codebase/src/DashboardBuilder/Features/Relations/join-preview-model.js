// Pure wording + comparison for the relationship dialog's "Check this join" (no DOM). Unit-tested in
// tests/js/join-preview-model.test.mjs. Input is the POST /api/relationships/preview result: per side
// { rows, nullRows, keys, matchedKeys, matchedRows, maxDuplicates, avgDuplicates } over the rows examined.
// A relationship is the user's declaration (golden rule 5): nothing here blocks anything, it only warns.

/** The request body for one key pair; each entity is { db, table }. */
export const previewRequest = (fromEntity, fromColumn, toEntity, toColumn) => ({
  from: { db: fromEntity.db, table: fromEntity.table, column: fromColumn },
  to: { db: toEntity.db, table: toEntity.table, column: toColumn },
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

function times(table, column, side) {
  if (!repeats(side)) return `each ${column} key appears once in ${table}`;
  const avg = Math.round(side.avgDuplicates * 10) / 10;
  return `each ${column} key appears about ${avg} times in ${table}`;
}

/**
 * Plain-words reading of a preview. `declared` is the saved cardinality ("1:N") or undefined for a link not yet saved.
 * Returns { observed, summary: string[], verdict, findings: [{ level: "warn" | "info", text }] }.
 */
export function describePreview(result, { fromTable, toTable, fromColumn, toColumn, declared }) {
  const { from, to } = result;
  const observed = observedCardinality(result);
  const findings = [];
  const summary = [];
  if (from.rows === 0 || to.rows === 0) {
    findings.push({ level: "info", text: `${from.rows === 0 ? fromTable : toTable} is empty (or has no rows in the examined range), so there is nothing to compare.` });
    return { observed, summary, verdict: "", findings };
  }

  const mf = share(from.matchedRows, from.rows), mt = share(to.matchedRows, to.rows);
  summary.push(`${pct(mf)} of the rows in ${fromTable} have a match in ${toTable}; ${pct(1 - mf)} don't.`);
  summary.push(`${pct(mt)} of the rows in ${toTable} have a match in ${fromTable}; ${pct(1 - mt)} don't.`);
  summary.push(`${times(fromTable, fromColumn, from).replace(/^./, (c) => c.toUpperCase())}; ${times(toTable, toColumn, to)}.`);
  const verdict = `The data looks ${READING[observed]} (${observed}).`;

  if (from.matchedKeys === 0 || to.matchedKeys === 0)
    findings.push({ level: "warn", text: `No keys match at all — check that ${fromTable}.${fromColumn} and ${toTable}.${toColumn} are the right columns.` });
  for (const [t, c, s] of [[fromTable, fromColumn, from], [toTable, toColumn, to]])
    if (s.nullRows > 0) findings.push({ level: "info", text: `${pct(share(s.nullRows, s.rows))} of ${t} rows have no ${c} (NULL); a NULL key never matches.` });

  const both = repeats(from) && repeats(to);
  if (both)
    findings.push({ level: "warn", text: `Keys repeat on both sides (many-to-many): joined rows multiply, so sums and counts from either table can double-count.` });
  if (declared && /^[1N]:[1NM]$/.test(declared)) {
    const [a, b] = declared.split(":");
    // "1" on a side declares that side's keys are unique; the data disagrees when they repeat.
    for (const [mark, t, s] of [[a, fromTable, from], [b, toTable, to]])
      if (mark === "1" && repeats(s))
        findings.push({ level: "warn", text: `${t} is declared as the "one" side, but a key there repeats (up to ${s.maxDuplicates} times) — joined rows will multiply. Declare it many or use a unique key.` });
  }
  if (result.sampled)
    findings.push({ level: "info", text: `Based on the first ${result.sampleLimit.toLocaleString("en-US")} rows of each table, not all of them.` });
  return { observed, summary, verdict, findings };
}
