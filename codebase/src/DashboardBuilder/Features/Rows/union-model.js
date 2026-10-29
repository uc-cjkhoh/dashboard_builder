// Pure rules for the table union (no DOM): which tables may be stacked and the POST /api/union request. The limits
// mirror ClickHouse/RequestValidation.cs (ApiLimits.MaxUnionTables); the server picks the shared columns.
import { LIMITS } from "../Core/validate.js";

export const UNION_LIMIT = 20; // like a table preview: a small first look

const HINT = `Pick 2 to ${LIMITS.unionTables} tables.`;

/** Can these tables be stacked? `hint` says why not. */
export function unionPickState(tables) {
  const n = tables.length;
  return n >= 2 && n <= LIMITS.unionTables ? { ok: true, hint: "" } : { ok: false, hint: HINT };
}

/** The POST /api/union body for the first rows of `tables` stacked. Throws a sentence when they can't be. */
export function unionRequest(db, tables, limit = UNION_LIMIT) {
  if (!unionPickState(tables).ok) throw new Error(`A union needs between 2 and ${LIMITS.unionTables} tables.`);
  if (new Set(tables).size !== tables.length) throw new Error("Pick different tables.");
  return { db, tables: [...tables], limit };
}
