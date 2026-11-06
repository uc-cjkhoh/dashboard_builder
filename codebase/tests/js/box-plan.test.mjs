import { test } from "node:test";
import assert from "node:assert/strict";
import { boxPlan, boxFields } from "../../src/DashboardBuilder/Features/Dashboard/box-plan.js";

const ctx = {
  calculations: [], entities: new Map(), relationships: new Map(), sharedFilters: [], parameters: [],
  metaOf: () => ({}), nameOf: (f) => f.column, columnType: () => "Float64",
};
const sheet = (columns, rows, extra = {}) => ({ chartType: "boxplot", rows, columns, filters: [], marks: {}, format: {}, color: [], ...extra });
const dim = { db: "d", table: "t", column: "region", category: "text", role: "dimension" };
const num = { db: "d", table: "t", column: "amount", category: "numeric", agg: "sum", having: { op: ">", value: "1" } };

test("boxFields: the first numeric field is the value, the first other field the group", () => {
  assert.deepEqual(boxFields(sheet([dim], [num])), { value: num, group: dim });
  assert.deepEqual(boxFields(sheet([], [num])), { value: num, group: null });
  assert.equal(boxFields(sheet([dim], [])).value, null);
});

test("boxPlan: the value rides as the one row dimension, the group as the one column dimension, no measures", () => {
  const p = boxPlan(sheet([dim], [num]), ctx);
  assert.deepEqual(p.rowDimensions.map((r) => r.column), ["amount"]);
  assert.equal("agg" in p.rowDimensions[0], false);
  assert.deepEqual(p.columnDimensions.map((r) => r.column), ["region"]);
  assert.deepEqual(p.measures, []);
  assert.deepEqual(p.from, { db: "d", table: "t" });
});

test("boxPlan: no group, a group cap from Top-N, and none of the grouped-chart extras", () => {
  const p = boxPlan(sheet([], [num], { format: { topN: 12 } }), ctx);
  assert.deepEqual(p.columnDimensions, []);
  assert.equal(p.limit, 12);
  for (const k of ["having", "otherBucket", "dateBucket", "approximate", "sort", "offset"]) assert.equal(k in p, false, k);
});

test("boxPlan: with no Top-N the group cap is the full row limit", () => {
  assert.equal(boxPlan(sheet([dim], [num]), ctx).limit, 5000);
});

test("boxPlan: no numeric field is no plan", () => {
  assert.equal(boxPlan(sheet([dim], []), ctx), null);
});
