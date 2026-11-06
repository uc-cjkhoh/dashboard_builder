// Dashboard/placement-model.js — where a field lands when placed without dragging (plus button, double-click). Pure.

/** The default shelf for a field role: measures to Rows, dimensions to Columns. */
export function defaultShelf(role) {
  return role === "measure" ? { shelf: "rows", label: "Rows" } : { shelf: "columns", label: "Columns" };
}

/** Whether a double-click on `target` means "place this field": not when it lands on a button, input, select or editable text. */
export function placesOnDblClick(target) {
  return Boolean(target?.closest) && !target.closest("input, button, select, [contenteditable]");
}
