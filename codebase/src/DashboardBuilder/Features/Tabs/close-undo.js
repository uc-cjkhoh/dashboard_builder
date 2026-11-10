// Undo for closing a tab — pure, DOM-free (tests/js/close-undo.test.mjs). Closing removes the tab and, from the other tabs,
// the dashboard widgets / story steps / button links that pointed at it. The store replaces those lists with new arrays, so
// a snapshot of the old arrays plus the new ones the close left is enough to put everything back through the store's own setters.

/** Before the close: the tab, its position, whether it was showing, and the content of every dashboard and story. Null for an unknown id. */
export function captureClose(tabs, id, wasActive) {
  const index = tabs.findIndex((t) => t.id === id);
  if (index < 0) return null;
  const others = tabs.filter((t) => t.id !== id && (t.kind === "dashboard" || t.kind === "story"))
    .map((t) => ({ id: t.id, name: t.name, kind: t.kind, before: t.kind === "dashboard" ? t.widgets : t.steps, after: null }));
  return { tab: tabs[index], index, wasActive: Boolean(wasActive), others };
}

/** After the close: remember what each dashboard and story holds now (to tell a later edit from the close's own change). */
export function sealClose(snap, tabs) {
  for (const o of snap.others) {
    const t = tabs.find((x) => x.id === o.id);
    o.after = t ? (o.kind === "dashboard" ? t.widgets : t.steps) : null;
  }
}

/** What Undo does: { ok, index, writes: [{ id, kind, value }], skipped: [names] } or { ok: false, error }. A dashboard or story edited since keeps its newer content (named in `skipped`). */
export function planRestore(snap, tabs, maxTabs) {
  if (tabs.some((t) => t.id === snap.tab.id)) return { ok: false, error: `“${snap.tab.name}” is already open.` };
  if (tabs.length >= maxTabs) return { ok: false, error: `A workbook holds at most ${maxTabs} tabs — close one first.` };
  const writes = [], skipped = [];
  for (const o of snap.others) {
    const t = tabs.find((x) => x.id === o.id);
    if (!t || o.before === o.after) continue;
    const now = o.kind === "dashboard" ? t.widgets : t.steps;
    if (now === o.after) writes.push({ id: o.id, kind: o.kind, value: o.before }); else skipped.push(o.name);
  }
  return { ok: true, index: Math.min(snap.index, tabs.length), writes, skipped };
}

/** The toast after Undo: names dashboards / stories that were edited since and so did not get their content back. */
export const restoredToast = (tab, skipped) => (skipped.length ? `Restored “${tab.name}”. ${skipped.join(", ")} changed since, so what it showed was not brought back.` : `Restored “${tab.name}”.`);

export const closedToast = (tab) => `Closed “${tab.name}”.`;
