import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleTools } from "../../src/DashboardBuilder/Features/Dashboard/toolbar-rules.js";
const KEYS = ["color", "size", "label", "detail", "tooltip", "shape", "path", "angle", "filters", "drill", "pages"];
const tools = (counts = {}) => KEYS.map((key) => ({ key, count: counts[key] ?? 0 }));
const keys = (list) => list.map((t) => t.key);
test("a bar chart shows the everyday tools, Size included (bar thickness)", () => {
  const r = visibleTools("bar", tools());
  assert.deepEqual(keys(r.visible), ["color", "size", "label", "tooltip", "filters"]);
  assert.deepEqual(keys(r.more), ["detail", "shape", "path", "angle", "drill", "pages"]);
});
test("chart-specific tools surface for their chart types", () => {
  assert.ok(keys(visibleTools("scatter", tools()).visible).includes("size"));
  assert.ok(keys(visibleTools("square", tools()).visible).includes("shape"));
  assert.ok(keys(visibleTools("area", tools()).visible).includes("path"));
  assert.ok(keys(visibleTools("donut", tools()).visible).includes("angle"));
});
test("a tool in use is never hidden behind More", () => {
  const r = visibleTools("bar", tools({ detail: 1, pages: 1 }));
  assert.ok(keys(r.visible).includes("detail")); assert.ok(keys(r.visible).includes("pages"));
});
