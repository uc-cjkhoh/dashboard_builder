// Field choices (P40): a shelf slot may carry alternative fields; pure helpers over the slot object.
import { aggsFor } from "./filter-rules.js";

export const sameRef = (a, b) => a.db === b.db && a.table === b.table && a.column === b.column;
export function choicesOf(f) { return f.choices?.length ? f.choices : [{ db: f.db, table: f.table, column: f.column, category: f.category }]; }

// Put a choice in the slot: the field changes, the slot's role stays; a measure keeps its aggregation
// when the new field supports it, else takes the first it does.
export function switchField(f, c) {
  Object.assign(f, { db: c.db, table: c.table, column: c.column, category: c.category });
  if (c.category !== "temporal") delete f.datePart; // a date part only means something on a date field
  if (f.agg && !aggsFor(c.category).includes(f.agg)) { f.agg = aggsFor(c.category)[0]; delete f.p; }
}

// Remove choice `c` from slot `f`. Removing the shown one shows the next; fewer than two left collapses to a plain field.
// The slot's last field is never removed (a slot always has a field): that leaves it a plain field, and returns false.
export function removeChoice(f, c) {
  const rest = choicesOf(f).filter((x) => !sameRef(x, c));
  if (!rest.length) { delete f.choices; return false; }
  if (sameRef(f, c)) switchField(f, rest[0]);
  if (rest.length >= 2) f.choices = rest; else delete f.choices;
  return true;
}
