// What chart.js draws for Shape: a symbol per member (or the member's own), a symbol per bin of a Shape measure, the legend icons, the tooltip's exact value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOption } from "../../src/DashboardBuilder/Features/Dashboard/chart.js";

globalThis.document ??= { documentElement: {} };
globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => "" });
const pts = (n) => Array.from({ length: n }, (_, i) => ({ value: [i, i], name: `p${i}` }));
const spec = (groups, extra = {}) => ({ type: "scatterShapes", groups, symbol: "circle", xName: "x", yName: "y", hasSize: false, format: { legend: "top" }, ...extra });
const members = (...names) => names.map((name, i) => ({ name, points: pts(1), shape: { index: i, name, raw: name } }));

test("members wear the symbols at their position in the set, as before", () => {
  const o = buildOption(spec(members("EU", "US", "JP")));
  assert.deepEqual(o.series.map((s) => s.symbol), ["circle", "rect", "triangle"]);
  assert.deepEqual(o.legend.data.map((d) => d.icon), ["circle", "rect", "triangle"]);
});

test("a member's own shape replaces its symbol in the series and its legend icon; the others keep theirs", () => {
  const o = buildOption(spec(members("EU", "US", "JP"), { memberShapes: new Map([["US", "pin"], ["JP", "roundSquare"]]) }));
  assert.deepEqual(o.series.map((s) => s.symbol), ["circle", "pin", "roundRect"]);
  assert.deepEqual(o.legend.data.map((d) => d.icon), ["circle", "pin", "roundRect"]);
});

test("a Colour · Shape pair takes its shape member's symbol", () => {
  const g = [{ name: "EU · web", points: pts(1), colour: { index: 0, name: "EU" }, shape: { index: 0, name: "web", raw: "web" } },
    { name: "EU · shop", points: pts(1), colour: { index: 0, name: "EU" }, shape: { index: 1, name: "shop", raw: "shop" } }];
  const o = buildOption(spec(g, { memberShapes: new Map([["web", "arrow"]]) }));
  assert.deepEqual(o.series.map((s) => s.symbol), ["arrow", "rect"]);
});

test("a binned Shape measure: the bin's index is its symbol (member shapes do not apply), the tooltip says the exact value", () => {
  const g = [{ name: "0 to 5", points: [{ value: [1, 1], name: "a", shapeValue: "3" }], shape: { index: 0, name: "0 to 5", raw: 0 } },
    { name: "5 to 10", points: [{ value: [2, 2], name: "b", shapeValue: "9" }], shape: { index: 1, name: "5 to 10", raw: 1 } },
    { name: "No value", points: [{ value: [3, 3], name: "c", shapeValue: "—" }], shape: { index: 6, name: "No value", raw: 6 } }];
  const o = buildOption(spec(g, { shapeName: "rating", memberShapes: new Map([["5 to 10", "pin"]]) }));
  assert.deepEqual(o.series.map((s) => s.symbol), ["circle", "rect", "arrow"]);
  assert.deepEqual(o.legend.data.map((d) => d.icon), ["circle", "rect", "arrow"]);
  const tip = o.tooltip.formatter({ seriesName: "5 to 10", data: g[1].points[0], value: [2, 2] });
  assert.match(tip, /rating:<\/b> 9/); assert.match(tip, /5 to 10/);
  assert.doesNotMatch(buildOption(spec(members("EU"))).tooltip.formatter({ seriesName: "EU", data: { name: "p" }, value: [1, 1] }), /rating/);
});
