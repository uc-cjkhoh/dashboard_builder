// Dashboard/fields-pane-model.js — the field pane's hide / show state (pure). Same idea as the sidebar's rail (Shell/sidebar.js):
// one remembered flag, one toggle whose label names the action it will do.
export const FIELDS_COLLAPSED_KEY = "dashboardbuilder.fields.collapsed";

export const fieldsPaneView = (collapsed) => ({ expanded: !collapsed, label: collapsed ? "Show field list" : "Hide field list" });

/** The remembered state from a Storage-like; blocked or missing storage starts expanded. */
export function readCollapsed(storage) {
  try { return storage?.getItem(FIELDS_COLLAPSED_KEY) === "1"; } catch { return false; }
}

// The Marks block of the pane: open or collapsed, remembered per browser. With nothing remembered it starts collapsed only while no
// slot is set, so set marks are never hidden; collapsed, it shows a one-line summary of the slots in use.
export const MARKS_PREF_KEY = "dashboardbuilder.marks.pref";
export function readMarksPref(storage) {
  try { const v = storage?.getItem(MARKS_PREF_KEY); return v === "open" || v === "closed" ? v : null; } catch { return null; }
}
export const marksOpen = (pref, setCount) => (pref === "open" ? true : pref === "closed" ? false : setCount > 0);
/** "Color, Detail (2)" — the slots that hold something ("" when none). */
export const marksSummary = (tools) => tools.filter((t) => t.count > 0).map((t) => (t.count > 1 ? `${t.label} (${t.count})` : t.label)).join(", ");
