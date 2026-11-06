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

// ---- Task 8b: evaluationInput + guarded cap text ----
import { evaluationInput } from "../../src/DashboardBuilder/Features/Calc/eval-order.js";

const dim = (column, extra = {}) => ({ db: "d", table: "t", column, category: "text", role: "dimension", ...extra });
const sheetOf = (o = {}) => ({ rows: [], columns: [], color: [], marks: {}, filters: [], format: {}, chartType: "bar", ...o });
const opts = { sharedFilters: [], parameters: [], calcs: [] };

test("evaluationInput counts filters, drill, period and Top-N and feeds describeEvaluation", () => {
  const sheet = sheetOf({
    rows: [dim("country")],
    filters: [{ op: "=", column: "a" }, { op: "top", column: "b" }],
    drill: { levels: [{ db: "d", table: "t", column: "a" }, { db: "d", table: "t", column: "b" }], depth: 1, path: [{ column: "a", value: "x" }] },
    period: { table: "t", column: "day", preset: "last30" },
    format: { topN: 10 },
  });
  const s = evaluationInput(sheet, { ...opts, sharedFilters: [{ op: "=" }] });
  assert.equal(s.ownFilters, 2);
  assert.equal(s.sharedFilters, 1);
  assert.equal(s.drillDepth, 1);
  assert.equal(s.hasPeriod, true);
  assert.equal(s.hasTopFilter, true);
  assert.equal(s.hasPage, false);
  assert.equal(s.hasSelection, false);
  assert.equal(s.displayCap, 10);
  assert.equal(s.otherBucket, false); // drill level + country = two dimensions
  assert.equal(s.dimensions.length, 2);
  assert.deepEqual(s.dimensions, ["t.b", "t.country"]);
  const t = describeEvaluation(s)[0].text;
  for (const p of ["2 own", "1 shared", "drill 1 level", "date range", "Top-N filter"]) assert.ok(t.includes(p), t);
});

test("evaluationInput classifies calc pills and table calcs", () => {
  const rl = { calc: "c1", db: "", table: "", column: "Margin", category: "numeric", role: "measure", agg: "sum" };
  const rlDim = { calc: "c2", db: "", table: "", column: "Band", category: "text", role: "dimension" };
  const ag = { calc: "c3", db: "", table: "", column: "Ratio", category: "numeric", role: "measure" };
  const sheet = sheetOf({
    rows: [rlDim], columns: [{ db: "d", table: "t", column: "x", category: "numeric", agg: "sum", tableCalc: { type: "running" } }, rl, rl, ag],
  });
  const s = evaluationInput(sheet, { ...opts, calcs: [{ id: "c2", name: "Band" }] });
  assert.equal(s.rowLevelCalcs, 2);
  assert.equal(s.aggregateCalcs, 1);
  assert.deepEqual(s.tableCalcs, ["running total"]);
  assert.deepEqual(s.dimensions, ["Band"]);
  assert.equal(s.displayCap, 5000);
});

test("evaluationInput honours nameOf and a sparse sheet does not throw", () => {
  const s = evaluationInput(sheetOf({ rows: [dim("country")] }), { ...opts, nameOf: (f) => `N:${f.column}` });
  assert.deepEqual(s.dimensions, ["N:country"]);
  const bare = evaluationInput({}, {});
  assert.equal(bare.ownFilters, 0);
  assert.deepEqual(bare.dimensions, []);
  assert.deepEqual(bare.tableCalcs, []);
  assert.equal(describeEvaluation(bare)[0].text, "No filters.");
  assert.doesNotThrow(() => describeEvaluation({ ownFilters: 0, sharedFilters: 0, drillDepth: 0, rowLevelCalcs: 0, aggregateCalcs: 0 }));
});

test("cap text is pluralised and guarded", () => {
  assert.ok(describeEvaluation({ ...base, displayCap: 1 })[4].text.includes("1 group") && !describeEvaluation({ ...base, displayCap: 1 })[4].text.includes("1 groups"));
  assert.ok(describeEvaluation({ ...base, displayCap: 5000 })[4].text.includes("5000 groups"));
  for (const bad of [undefined, NaN, Infinity, null]) assert.ok(describeEvaluation({ ...base, displayCap: bad })[4].text.includes("the display cap"));
  assert.equal(describeEvaluation(base)[0].text, "No filters.");
});

test("evaluationInput: a single-dimension bar gets the Other bucket", () => {
  assert.equal(evaluationInput(sheetOf({ rows: [dim("country")] }), opts).otherBucket, true);
});

test("evaluationInput counts only applied own filters and a valid Top-N", () => {
  const sheet = sheetOf({ filters: [{ op: "=", ok: true }, { op: "=", ok: false }, { op: "top", ok: false }] });
  const s = evaluationInput(sheet, { ...opts, isApplied: (f) => f.ok });
  assert.equal(s.ownFilters, 1);
  assert.equal(s.hasTopFilter, false);
  assert.equal(evaluationInput(sheet, opts).ownFilters, 3);
  assert.equal(evaluationInput(sheetOf({ filters: [{ op: "top", ok: true }] }), { ...opts, isApplied: (f) => f.ok }).hasTopFilter, true);
});

test("evaluationInput: an explicit dimensions list wins and drives the Other bucket", () => {
  const s = evaluationInput(sheetOf({ rows: [dim("country")] }), { ...opts, dimensions: ["x", "y"] });
  assert.deepEqual(s.dimensions, ["x", "y"]);
  assert.equal(s.otherBucket, false);
});

test("evaluationInput counts a filter on a calculation as a row-level calculation", () => {
  const f = { calc: "c1", db: "", table: "", column: "Net", category: "numeric", op: ">", value: "1" };
  assert.equal(evaluationInput(sheetOf({ filters: [f] }), opts).rowLevelCalcs, 1);
  assert.equal(evaluationInput(sheetOf({ filters: [f] }), { ...opts, isApplied: () => false }).rowLevelCalcs, 0);
});

test("a measure filter is said at the Aggregates stage, before the cap", () => {
  const one = describeEvaluation({ ...base, measureFilters: 1 })[3].text;
  assert.match(one, /Then 1 measure filter drops the groups whose total fails it, before the cap\./);
  assert.match(describeEvaluation({ ...base, measureFilters: 2 })[3].text, /Then 2 measure filters drop the groups whose total fails them/);
  assert.equal(describeEvaluation({ ...base })[3].text, "Each group is aggregated.");
  const m = { db: "d", table: "t", column: "x", category: "numeric", agg: "sum", having: { op: ">", value: "5" } };
  const s = evaluationInput(sheetOf({ rows: [{ db: "d", table: "t", column: "r", category: "text", role: "dimension" }], columns: [m] }), opts);
  assert.equal(s.measureFilters, 1);
  assert.equal(s.otherBucket, false); // the Other total isn't built with a measure filter
});
