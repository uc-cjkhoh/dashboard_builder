// Pure rules for the unpivot preview (no DOM): which columns may be turned into rows and the POST /api/unpivot request.
// The limits mirror ClickHouse/RequestValidation.cs (ApiLimits.MaxUnpivotColumns / MaxUnpivotKeep); the server re-checks
// that the columns exist and share a kind.
import { LIMITS } from "../Core/validate.js";

export const UNPIVOT_LIMIT = 20; // like a table preview: a small first look

const HINT = `Pick 2 to ${LIMITS.unpivotColumns} columns to turn into rows.`;
const KIND_HINT = "Columns to turn into rows must be the same kind (all numbers, all text, …).";

/** Can these `columns` (names) be unpivoted from the table's `cols` ({ name, category })? `hint` says why not. */
export function unpivotPickState(cols, columns, keep) {
  const n = columns.length;
  if (n < 2 || n > LIMITS.unpivotColumns) return { ok: false, hint: HINT };
  const kind = (name) => cols.find((c) => c.name === name)?.category;
  if (columns.some((c) => kind(c) !== kind(columns[0]))) return { ok: false, hint: KIND_HINT };
  if (keep.length > LIMITS.unpivotKeep) return { ok: false, hint: `Keep at most ${LIMITS.unpivotKeep} columns.` };
  return { ok: true, hint: `${n} columns become rows.` };
}

/** The POST /api/unpivot body for the first rows of `table` with `columns` turned into rows. Throws a sentence when it can't be. */
export function unpivotRequest(db, table, columns, keep = [], limit = UNPIVOT_LIMIT) {
  if (columns.length < 2 || columns.length > LIMITS.unpivotColumns) throw new Error(`An unpivot needs between 2 and ${LIMITS.unpivotColumns} columns.`);
  if (keep.length > LIMITS.unpivotKeep) throw new Error(`An unpivot can keep at most ${LIMITS.unpivotKeep} columns.`);
  if (new Set([...columns, ...keep]).size !== columns.length + keep.length) throw new Error("Pick different columns for each role.");
  return { db, table, columns: [...columns], keep: [...keep], limit };
}
