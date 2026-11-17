// Pure rules for drawing a relationship by dragging one column row onto another card's column row
// (no DOM). Unit-tested in tests/js/link-drag.test.mjs. The decision reuses relation-rules.js, so a
// dropped link is refused for exactly the reasons a clicked one is.
import { linkIssue, relationBetween } from "./relation-rules.js";
import { MAX_EXTRA_PAIRS } from "./key-pairs.js";

export const COLUMN_MIME = "application/x-ch-column"; // our rows only — never arbitrary text or files

export const encodeColumnDrag = (entityId, column) => JSON.stringify({ entityId, column });

/** The dragged row's `{ entityId, column }`, or null for anything malformed. */
export function parseColumnDrag(raw) {
  let v;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v.entityId !== "string" || !v.entityId || typeof v.column !== "string" || !v.column) return null;
  return { entityId: v.entityId, column: v.column };
}

/**
 * Can `from` (the dragged row) be dropped on `to` (the row under the pointer, or null)?
 * Each end is `{ entityId, column, category, table }`. `problem` is the user-facing reason when refused.
 * When the two tables are already related, an allowed drop adds a key pair to that relationship: `extend` is its id (D127).
 */
export function dropDecision({ relationships, from, to }) {
  if (!from || !to) return { ok: false, problem: null, kind: null };
  const rels = [...relationships]; // may be an iterator: read it more than once
  const issue = linkIssue({
    relationships: rels, from: { entityId: from.entityId, column: from.column }, to: { entityId: to.entityId, column: to.column },
    fromCategory: from.category, toCategory: to.category, fromLabel: `${from.table}.${from.column}`, toLabel: `${to.table}.${to.column}`,
  });
  if (issue) return { ok: false, problem: issue.message, kind: issue.kind };
  const rel = relationBetween(rels, from.entityId, to.entityId);
  if (!rel) return { ok: true, problem: null, kind: null };
  if ((rel.pairs?.length ?? 0) >= MAX_EXTRA_PAIRS)
    return { ok: false, problem: `${from.table} and ${to.table} already match on ${MAX_EXTRA_PAIRS + 1} columns, the most a relationship can.`, kind: "other" };
  return { ok: true, problem: null, kind: null, extend: rel.id };
}
