import { test } from "node:test";
import assert from "node:assert/strict";
import { CASTS, castChoices, castAllowed, effectiveCategory, castLabel, withCasts, syncCastCategories, statCastProblem } from "../../src/DashboardBuilder/Features/Dashboard/cast-model.js";
import { CATEGORIES } from "../../src/DashboardBuilder/Features/Core/sheet-schema.js";
import { parseWorkbook, WORKBOOK_FORMAT } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

test("the casts are text, number and date", () => assert.deepEqual([...CASTS], ["text", "number", "date"]));
test("a cast decides the category", () => {
  assert.equal(effectiveCategory("text", "number"), "numeric");
  assert.equal(effectiveCategory("text", "date"), "temporal");
  assert.equal(effectiveCategory("numeric", "text"), "text");
  assert.equal(effectiveCategory("numeric", undefined), "numeric");
  for (const c of CASTS) assert.ok(CATEGORIES.has(effectiveCategory("other", c)));
});
test("the choices mirror the server's pairings (TypeCast.Apply)", () => {
  assert.deepEqual(castChoices("text"), ["number", "date"]);
  assert.deepEqual(castChoices("numeric"), ["text"]);
  assert.deepEqual(castChoices("temporal"), ["text"]);
  assert.deepEqual(castChoices("boolean"), ["text", "number"]);
  assert.deepEqual(castChoices("other"), ["text"]);
  assert.ok(castAllowed("text", "date") && !castAllowed("numeric", "date") && !castAllowed("temporal", "number"));
});
test("labels", () => { assert.equal(castLabel("number"), "Number"); assert.equal(castLabel(undefined), ""); });

const castOf = (f) => (f.column === "when_s" ? "date" : f.column === "qty_s" ? "number" : undefined);
test("withCasts adds cast to dimensions, measures, filters and a ranking measure, never to a calculation", () => {
  const plan = {
    rowDimensions: [{ db: "d", table: "t", column: "when_s", datePart: "month" }, { db: "", table: "", column: "calc", calc: {} }, { db: "d", table: "t", column: "plain" }],
    columnDimensions: [],
    measures: [{ db: "d", table: "t", column: "qty_s", agg: "sum" }, { db: "", table: "", column: "c", calc: {}, agg: "sum" }],
    filters: [{ db: "d", table: "t", column: "qty_s", op: ">", value: "1" },
      { db: "d", table: "t", column: "plain", op: "top", value: "3", topBy: { db: "d", table: "t", column: "qty_s", agg: "avg" } }],
  };
  const out = withCasts(plan, castOf);
  assert.equal(out.rowDimensions[0].cast, "date");
  assert.equal(out.rowDimensions[0].datePart, "month");
  assert.ok(!("cast" in out.rowDimensions[1]) && !("cast" in out.rowDimensions[2]));
  assert.equal(out.measures[0].cast, "number");
  assert.ok(!("cast" in out.measures[1]));
  assert.equal(out.filters[0].cast, "number");
  assert.ok(!("cast" in out.filters[1]));
  assert.equal(out.filters[1].topBy.cast, "number");
  assert.ok(!("cast" in plan.measures[0]), "the input is not mutated");
});
test("a plan with no casts is returned unchanged", () => {
  const plan = { rowDimensions: [{ db: "d", table: "t", column: "plain" }], measures: [], filters: [] };
  assert.deepEqual(withCasts(plan, castOf), plan);
});

const base = (db, table, column) => ({ qty_s: "text", when_s: "text", amount: "numeric" })[column];
test("changing a cast re-categorises pills, filters and drill levels, and fixes what no longer fits", () => {
  const sheet = {
    columns: [{ db: "d", table: "t", column: "when_s", category: "text" }],
    rows: [{ db: "d", table: "t", column: "qty_s", category: "text", agg: "max" }, { db: "d", table: "t", column: "amount", category: "numeric", agg: "sum" }],
    color: [], marks: { detail: [{ db: "d", table: "t", column: "qty_s", category: "temporal", datePart: "year" }] },
    filters: [{ db: "d", table: "t", column: "qty_s", category: "text", op: "contains", value: "1" }],
    drill: { levels: [{ db: "d", table: "t", column: "when_s", category: "text" }] },
  };
  const changed = syncCastCategories(sheet, [], castOf, base);
  assert.ok(changed);
  assert.equal(sheet.columns[0].category, "temporal");
  assert.equal(sheet.rows[0].category, "numeric");
  assert.equal(sheet.rows[0].agg, "max");
  assert.equal(sheet.rows[1].category, "numeric");
  assert.ok(!("datePart" in sheet.marks.detail[0]), "a date part only means something on a date field");
  assert.equal(sheet.filters[0].category, "numeric");
  assert.equal(sheet.filters[0].op, "=", "a text-match operator doesn't fit a number");
  assert.equal(sheet.filters[0].value, "");
  assert.equal(sheet.drill.levels[0].category, "temporal");
  assert.equal(syncCastCategories(sheet, [], castOf, base), false, "second pass changes nothing");
});
test("removing a cast restores the column's own category and an invalid aggregation is replaced", () => {
  const sheet = { columns: [], rows: [{ db: "d", table: "t", column: "qty_s", category: "numeric", agg: "sum" }], filters: [], marks: {} };
  assert.ok(syncCastCategories(sheet, [], () => undefined, base));
  assert.equal(sheet.rows[0].category, "text");
  assert.equal(sheet.rows[0].agg, "count");
});
test("shared filters are re-categorised too", () => {
  const shared = [{ db: "d", table: "t", column: "qty_s", category: "text", op: "=", value: "5" }];
  assert.ok(syncCastCategories({ columns: [], rows: [], filters: [], marks: {} }, shared, castOf, base));
  assert.equal(shared[0].category, "numeric");
  assert.equal(shared[0].value, "5", "a value that still fits is kept");
});

test("the histogram refuses a cast field (the box plot casts like any chart), with a message", () => {
  const sheet = { chartType: "histogram", columns: [], rows: [{ db: "d", table: "t", column: "qty_s" }], filters: [] };
  assert.match(statCastProblem(sheet, castOf), /cast/i);
  assert.equal(statCastProblem({ ...sheet, rows: [{ db: "d", table: "t", column: "plain" }] }, castOf), null);
  assert.equal(statCastProblem({ ...sheet, chartType: "bar" }, castOf), null);
  assert.equal(statCastProblem({ ...sheet, chartType: "boxplot" }, castOf), null);
});

const wb = (fields) => JSON.stringify({ format: WORKBOOK_FORMAT, version: 1, entities: [], relationships: [], dashboards: [], fields });
test("a field cast round-trips through the workbook; an unknown one is dropped and counted", () => {
  const ok = parseWorkbook(wb({ "d.t.c": { cast: "number", alias: "N" } }));
  assert.deepEqual(ok.fields, { "d.t.c": { cast: "number", alias: "N" } });
  const bad = parseWorkbook(wb({ "d.t.c": { cast: "int" }, "d.t.k": { cast: "date" } }));
  assert.deepEqual(bad.fields, { "d.t.k": { cast: "date" } });
  assert.ok(bad.issues.some((i) => /invalid/.test(i)));
});
