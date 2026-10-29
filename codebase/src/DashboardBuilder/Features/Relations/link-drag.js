// Pure rules for drawing a relationship by dragging one column row onto another card's column row
// (no DOM). Unit-tested in tests/js/link-drag.test.mjs. The decision reuses relation-rules.js, so a
// dropped link is refused for exactly the reasons a clicked one is.
import { linkProblem } from "./relation-rules.js";

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
 */
export function dropDecision({ relationships, from, to }) {
  if (!from || !to) return { ok: false, problem: null };
  const problem = linkProblem({
    relationships, from: { entityId: from.entityId, column: from.column }, to: { entityId: to.entityId, column: to.column },
    fromCategory: from.category, toCategory: to.category, fromLabel: `${from.table}.${from.column}`, toLabel: `${to.table}.${to.column}`,
  });
  return { ok: problem === null, problem };
}
