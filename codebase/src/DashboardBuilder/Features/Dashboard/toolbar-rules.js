// Dashboard/toolbar-rules.js — which encoding tools sit in the visible row vs. the More menu (pure).
const ALWAYS = new Set(["filters", "period", "color", "label", "tooltip"]); // period = Date range
const POINTS = new Set(["scatter", "square", "circle"]);
// Size scales point marks, bar thickness, line thickness / area markers, treemap area and Text / Table font size; it stays quiet elsewhere (pie / donut have no per-slice size).
const WHEN = { size: new Set([...POINTS, "bar", "line", "area", "treemap", "text", "table"]), shape: POINTS, path: new Set(["line", "area"]), angle: new Set(["pie", "donut"]) };
export function visibleTools(chartType, tools) {
  const visible = [], more = [];
  for (const t of tools) (t.count > 0 || ALWAYS.has(t.key) || WHEN[t.key]?.has(chartType) ? visible : more).push(t);
  return { visible, more };
}
