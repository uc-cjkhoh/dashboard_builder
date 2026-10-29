// Dashboard/fields-pane-model.js — the field pane's hide / show state (pure). Same idea as the sidebar's rail (Shell/sidebar.js):
// one remembered flag, one toggle whose label names the action it will do.
export const FIELDS_COLLAPSED_KEY = "dashboardbuilder.fields.collapsed";

export const fieldsPaneView = (collapsed) => ({ expanded: !collapsed, label: collapsed ? "Show field list" : "Hide field list" });

/** The remembered state from a Storage-like; blocked or missing storage starts expanded. */
export function readCollapsed(storage) {
  try { return storage?.getItem(FIELDS_COLLAPSED_KEY) === "1"; } catch { return false; }
}
