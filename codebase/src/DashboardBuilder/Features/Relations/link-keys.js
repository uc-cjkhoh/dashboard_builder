// Pure rules for relating two columns from the keyboard (no DOM). Unit-tested in tests/js/link-keys.test.mjs.
// Flow: focus a column row, Enter/Space picks it as the source; move to a row of another table, Enter/Space
// relates them (the same dropDecision + dialog as a drag); Escape cancels. Arrow keys move between rows.

/** What a key does on a focused row. `picking` is true once a source row is chosen. */
export function linkKeyAction(key, picking) {
  if (key === "Enter" || key === " ") return picking ? "target" : "pick";
  if (key === "Escape") return picking ? "cancel" : null;
  if (key === "ArrowDown") return "next";
  if (key === "ArrowUp") return "prev";
  if (key === "Home") return "first";
  if (key === "End") return "last";
  if (key === "]") return "nextCard";
  if (key === "[") return "prevCard";
  return null;
}

/** Index of the row to focus after an arrow key, clamped to the list; -1 when there are no rows. */
export function stepIndex(current, count, dir) {
  if (count <= 0) return -1;
  const from = current < 0 ? (dir > 0 ? -1 : count) : current;
  return Math.min(count - 1, Math.max(0, from + dir));
}

/** Index of the card to jump to with `]` / `[`, wrapping around; -1 when there are no cards. */
export function cardIndex(current, count, dir) {
  if (count <= 0) return -1;
  if (current < 0) return dir > 0 ? 0 : count - 1;
  return (current + dir + count) % count;
}

const nameOf = (end) => `${end.table}.${end.column}`;

/** The visible/spoken instruction line for the current state. `decision` is dropDecision's result for the focused row, or null. */
export function linkHint(source, target, decision) {
  if (!source) return "";
  const head = `Relating ${nameOf(source)}.`;
  if (!target || (target.entityId === source.entityId && target.column === source.column)) return `${head} Move to a column in another table ([ and ] switch table), then press Enter. Escape cancels.`;
  if (decision?.ok) return `${head} Press Enter to relate it to ${nameOf(target)}.`;
  return `Can't relate to ${nameOf(target)}${decision?.problem ? `: ${decision.problem}` : "."} ${head}`;
}

/** Accessible name of a column row: its name, type and table, and "source" while it is the picked one. Instructions live in the status line / help text, not here. */
export function rowLabel(end, type, source) {
  const base = `${end.column}, ${type}, in ${end.table}`;
  return source && source.entityId === end.entityId && source.column === end.column ? `${base}, source` : base;
}
