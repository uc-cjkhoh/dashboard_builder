// P23 undo / redo — pure, DOM-free (unit-tested in tests/js/history.test.mjs). One stack per worksheet of
// sheet snapshots: every committed change records the sheet as it was; undo swaps back, redo forward.
export const HISTORY_LIMIT = 50;

export function createHistory(limit = HISTORY_LIMIT) {
  const stacks = new Map(); // worksheet id → { undo: [], redo: [] }
  const of = (id) => { if (!stacks.has(id)) stacks.set(id, { undo: [], redo: [] }); return stacks.get(id); };
  const copy = (s) => structuredClone(s);
  return {
    /** Record the sheet as it was before a change (a new change clears redo). */
    record(id, before) {
      const st = of(id);
      st.undo.push(copy(before));
      if (st.undo.length > limit) st.undo.shift();
      st.redo.length = 0;
    },
    /** The sheet to go back to (or null), given the current one (which becomes redoable). */
    undo(id, current) {
      const st = of(id);
      if (!st.undo.length) return null;
      st.redo.push(copy(current));
      return st.undo.pop();
    },
    redo(id, current) {
      const st = of(id);
      if (!st.redo.length) return null;
      st.undo.push(copy(current));
      return st.redo.pop();
    },
    canUndo: (id) => (stacks.get(id)?.undo.length ?? 0) > 0,
    canRedo: (id) => (stacks.get(id)?.redo.length ?? 0) > 0,
    forget: (id) => stacks.delete(id),
    clear: () => stacks.clear(),
  };
}
