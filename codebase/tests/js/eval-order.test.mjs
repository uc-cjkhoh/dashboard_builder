// Calculated fields — the "How this is computed" explainer text, generated from a sheet summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeEvaluation } from "../../src/DashboardBuilder/Features/Calc/eval-order.js";

const base = {
  ownFilters: 0, sharedFilters: 0, drillDepth: 0, hasPage: false, hasSelection: false, hasPeriod: false,
  hasTopFilter: false, rowLevelCalcs: 0, aggregateCalcs: 0, dimensions: [], displayCap: 5000,
  otherBucket: false, tableCalcs: [],
};
const full = {
  ownFilters: 3, sharedFilters: 1, drillDepth: 2, hasPage: false, hasSelection: false, hasPeriod: true,
  hasTopFilter: true, rowLevelCalcs: 1, aggregateCalcs: 0, dimensions: ["customers.country"], displayCap: 5000,
  otherBucket: true, tableCalcs: ["running total"],
};

test("six entries, numbered, in the documented order", () => {
  const out = describeEvaluation(full);
  assert.deepEqual(out.map((e) => e.n), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(out.map((e) => e.title),
    ["Filters", "Row-level calculations", "Group by", "Aggregates", "Cap and Other", "Table calculations"]);
  for (const e of out) assert.equal(typeof e.text, "string");
});

test("stage 1 lists every filter kind that is present", () => {
  const t = describeEvaluation(full)[0].text;
  for (const piece of ["3 own", "1 shared", "drill 2 levels", "date range", "Top-N filter", "ClickHouse"]) {
    assert.ok(t.includes(piece), `${piece} in: ${t}`);
  }
  assert.ok(!t.includes("page"));
  assert.ok(!t.includes("selection"));
});

test("stage 1 mentions page and selection only when present, and singular drill", () => {
  const t = describeEvaluation({ ...base, hasPage: true, hasSelection: true, drillDepth: 1 })[0].text;
  assert.ok(t.includes("page"));
  assert.ok(t.includes("selection"));
  assert.ok(t.includes("drill 1 level") && !t.includes("drill 1 levels"));
});

test("with nothing filtering, stage 1 is exactly 'No filters.'", () => {
  assert.equal(describeEvaluation(base)[0].text, "No filters.");
});

test("stage 6 names the table calculations and says they run in the browser", () => {
  const t = describeEvaluation(full)[5].text;
  assert.ok(t.includes("running total"));
  assert.ok(t.includes("browser"));
});

test("stage 6 with none says so", () => {
  const t = describeEvaluation(base)[5].text;
  assert.ok(/no table calculations/i.test(t));
});

test("middle stages describe calculations, dimensions, cap and Other", () => {
  const out = describeEvaluation(full);
  assert.ok(out[1].text.includes("1 row-level"));
  assert.ok(out[2].text.includes("customers.country"));
  assert.ok(out[4].text.includes("5000"));
  assert.ok(/Other/.test(out[4].text));
  const zero = describeEvaluation(base);
  assert.ok(/no row-level/i.test(zero[1].text));
  assert.ok(/no dimensions|one group|single/i.test(zero[2].text));
  assert.ok(!/Other/.test(zero[4].text) || /no Other/i.test(zero[4].text));
});

test("aggregates stage counts aggregate calculations", () => {
  assert.ok(describeEvaluation({ ...base, aggregateCalcs: 2 })[3].text.includes("2 aggregate calculations"));
  assert.ok(describeEvaluation({ ...base, aggregateCalcs: 1 })[3].text.includes("1 aggregate calculation"));
});

test("every entry is a single sentence-style string", () => {
  for (const s of [base, full]) for (const e of describeEvaluation(s)) {
    assert.ok(e.text.length > 0);
    assert.ok(!e.text.includes("\n"));
  }
});
