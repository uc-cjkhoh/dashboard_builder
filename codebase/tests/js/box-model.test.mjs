import { test } from "node:test";
import assert from "node:assert/strict";
import { boxData, outlierPoints, outlierNotice, MAX_OUTLIERS } from "../../src/DashboardBuilder/Features/Dashboard/box-model.js";

const boxes = [
  { label: "a", min: 1, q1: 4, median: 5, q3: 6, max: 90, lowerWhisker: 2, upperWhisker: 9 },
  { label: null, min: 3, q1: 4, median: 5, q3: 6, max: 8 },
];

test("boxData: whiskers stop at the fences; without whisker fields it falls back to min/max", () => {
  assert.deepEqual(boxData(boxes), [[2, 4, 5, 6, 9], [3, 4, 5, 6, 8]]);
});

test("outlierPoints: [category index, value] pairs matched by label, null label as the missing group", () => {
  const outliers = [{ label: "a", value: 90 }, { label: "a", value: 1 }, { label: null, value: 20 }, { label: "zz", value: 5 }];
  assert.deepEqual(outlierPoints(boxes, outliers), [[0, 90], [0, 1], [1, 20]]);
});

test("outlierPoints: an empty-string group and a null group stay distinct", () => {
  const bs = [{ label: "" , min: 0, q1: 0, median: 0, q3: 0, max: 0 }, { label: null, min: 0, q1: 0, median: 0, q3: 0, max: 0 }];
  assert.deepEqual(outlierPoints(bs, [{ label: "", value: 1 }, { label: null, value: 2 }]), [[0, 1], [1, 2]]);
});

test("outlierPoints: no outliers", () => {
  assert.deepEqual(outlierPoints(boxes, undefined), []);
});
test("outlierNotice: only when the server truncated", () => {
  assert.equal(outlierNotice(false), null);
  assert.match(outlierNotice(true), new RegExp(`first ${MAX_OUTLIERS} outliers`));
});
