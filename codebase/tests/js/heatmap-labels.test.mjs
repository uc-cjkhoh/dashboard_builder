// Heatmap cell labels (automatic when they fit) and the stacked-scale notice — pure models.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LABEL_FONT, labelFits, cellSizeOf, labelsShown } from "../../src/DashboardBuilder/Features/Dashboard/heatmap-model.js";
import { STACK_TINY, tinyStackedSeries, stackedScaleNotice } from "../../src/DashboardBuilder/Features/Dashboard/stack-scale-model.js";

test("a label fits a cell that holds its text plus padding and one line of 14 px type", () => {
  assert.equal(LABEL_FONT, 14);
  assert.equal(labelFits(60, 24, "1,234"), true);   // 5 chars * 8 + 8 = 48 wide, 20 tall
  assert.equal(labelFits(47, 24, "1,234"), false);  // too narrow
  assert.equal(labelFits(60, 19, "1,234"), false);  // too short
  assert.equal(labelFits(60, 24, ""), false);       // nothing to draw
});

test("cell size: the plot minus the gutters, divided by the categories", () => {
  assert.deepEqual(cellSizeOf(490, 380, 4, 3, { x: 90, y: 80 }), { w: 100, h: 100 });
  assert.deepEqual(cellSizeOf(0, 0, 4, 3, { x: 90, y: 80 }), { w: 0, h: 0 });
  assert.deepEqual(cellSizeOf(500, 400, 0, 3, { x: 90, y: 80 }), { w: 0, h: 0 });
});

test("labels are shown when forced, or when the longest label fits the cell; never when it does not", () => {
  assert.equal(labelsShown({ forced: true, cellW: 2, cellH: 2, texts: ["12345"] }), true);
  assert.equal(labelsShown({ forced: false, cellW: 100, cellH: 40, texts: ["1", "12,345"] }), true);
  assert.equal(labelsShown({ forced: false, cellW: 50, cellH: 40, texts: ["1", "12,345"] }), false); // the longest decides, so the grid is all or nothing
  assert.equal(labelsShown({ forced: false, cellW: 100, cellH: 40, texts: [] }), false);
  assert.equal(labelsShown({ forced: false, cellW: 100, cellH: 40, texts: ["", ""] }), false);
});

test("stacked scale: a measure under 2% of the tallest stack is flagged", () => {
  assert.equal(STACK_TINY, 0.02);
  const big = { name: "Revenue", data: [1000000, 800000, 900000] };
  const small = { name: "Orders", data: [50, 40, 30] };
  assert.deepEqual(tinyStackedSeries([big, small]).map((s) => s.name), ["Orders"]);
  assert.deepEqual(tinyStackedSeries([big, { name: "Mid", data: [100000, 90000, 80000] }]), []);
  assert.deepEqual(tinyStackedSeries([big, { name: "Edge", data: [20500, 0, 0] }]), []);   // the tallest stack is 1,020,500: 2% is 20,410
  assert.deepEqual(tinyStackedSeries([big, { name: "Edge", data: [20000, 0, 0] }]).map((s) => s.name), ["Edge"]);
});

test("stacked scale: needs two measures that have values; empty, zero and null series are ignored", () => {
  assert.deepEqual(tinyStackedSeries([{ name: "A", data: [5, 6] }]), []);
  assert.deepEqual(tinyStackedSeries([]), []);
  assert.deepEqual(tinyStackedSeries([{ name: "A", data: [1000, 2000] }, { name: "B", data: [0, 0] }]), []);
  assert.deepEqual(tinyStackedSeries([{ name: "A", data: [1000, 2000] }, { name: "B", data: [null, undefined] }]), []);
  assert.deepEqual(tinyStackedSeries([{ name: "A", data: [0, 0] }, { name: "B", data: [0, null] }]), []);
});

test("stacked scale: the tallest stack sums every measure per category; negatives count by size", () => {
  const a = { name: "A", data: [100, 100] }, b = { name: "B", data: [100, 100] }, c = { name: "C", data: [3, 3] };
  assert.deepEqual(tinyStackedSeries([a, b, c]).map((s) => s.name), ["C"]); // 3 < 2% of 203
  assert.deepEqual(tinyStackedSeries([{ name: "A", data: [-1000, 10] }, { name: "B", data: [5, -2] }]).map((s) => s.name), ["B"]);
});

test("stacked scale notice: plain words, names the small measure(s), says what to do", () => {
  const big = { name: "Revenue", data: [1000000] };
  assert.equal(stackedScaleNotice([big, { name: "Orders", data: [50] }]),
    "Orders is under 2% of the tallest stack, so it is almost invisible. Chart it on its own or use a Combo chart with a second axis.");
  assert.equal(stackedScaleNotice([big, { name: "Orders", data: [50] }, { name: "Visits", data: [20] }]),
    "Orders and Visits are under 2% of the tallest stack, so they are almost invisible. Chart them on their own or use a Combo chart with a second axis.");
  assert.match(stackedScaleNotice([big, { name: "A", data: [1] }, { name: "B", data: [1] }, { name: "C", data: [1] }]), /^A, B and 1 more are under 2%/);
  assert.equal(stackedScaleNotice([big, { name: "Mid", data: [500000] }]), null);
});
