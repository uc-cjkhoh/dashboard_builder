// Dashboard/toolbar-rules.js — which encoding tools sit in the visible row vs. the More menu (pure).
const ALWAYS = new Set(["filters", "period", "color", "label", "tooltip"]); // period = Date range
const POINTS = new Set(["scatter", "square", "circle"]);
// Size scales point marks, bar thickness, line thickness / area markers, treemap area and Text / Table font size; it stays quiet elsewhere (pie / donut have no per-slice size).
const WHEN = { size: new Set([...POINTS, "bar", "line", "area", "treemap", "text", "table"]), shape: POINTS, path: new Set(["line", "area"]), angle: new Set(["pie", "donut"]) };
// A tool whose flyout has a control for this chart type (`t.controls`, from marks-flyout-model.js) is never quiet: Marker shape lights Shape on a line.
export function visibleTools(chartType, tools) {
  const visible = [], more = [];
  for (const t of tools) (t.count > 0 || t.controls === true || ALWAYS.has(t.key) || WHEN[t.key]?.has(chartType) ? visible : more).push(t);
  return { visible, more };
}
