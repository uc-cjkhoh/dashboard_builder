// Dashboard/placement-model.js — where a field lands when placed without dragging (plus button, double-click). Pure.

/** The default shelf for a field role: measures to Rows, dimensions to Columns. */
export function defaultShelf(role) {
  return role === "measure" ? { shelf: "rows", label: "Rows" } : { shelf: "columns", label: "Columns" };
}
