// A date dimension's axis labels: "all" keeps a slot and a label for every member (the pane scrolls),
// "thin" (the default) fits the axis to the pane and lets labels thin out so a long date range does
// not turn into a wall of text. Saved on the pill as `dateLabels`. Pure: unit-tested in tests/js/date-labels.test.mjs.
export const DATE_LABEL_MODES = ["all", "thin"];

export const normalizeDateLabels = (v) => (v === "all" ? "all" : "thin");
export const toggleDateLabels = (v) => (normalizeDateLabels(v) === "all" ? "thin" : "all");

/** The setting for a sheet's chart: undefined unless its primary dimension is a (non-calculated) date field. */
export function dateLabelsOf(sheet, primary) {
  const f = primary(sheet);
  if (!f || f.category !== "temporal" || f.calc !== undefined) return undefined;
  return normalizeDateLabels(f.dateLabels);
}

/** The Format → Fit mode with the date axis's direction forced by the setting (undefined setting: unchanged).
 *  `orientation` "horizontal" puts the date axis on the left (height), anything else on the bottom (width). */
export function dateFitMode(mode, dateLabels, orientation) {
  if (dateLabels === undefined) return mode;
  let w = mode === "width" || mode === "entire", h = mode === "height" || mode === "entire";
  const on = dateLabels !== "all";
  if (orientation === "horizontal") h = on; else w = on;
  return w && h ? "entire" : w ? "width" : h ? "height" : "standard";
}
