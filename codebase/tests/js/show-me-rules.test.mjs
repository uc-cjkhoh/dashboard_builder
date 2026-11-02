import { test } from "node:test";
import assert from "node:assert/strict";
import { CHART_NEEDS, chartIssue, issueFor, roleOf, TEXT_VALUE_HINT, COLOR_SPLIT_HINT, statFieldHint }
  from "../../src/DashboardBuilder/Features/Dashboard/show-me-rules.js";
import { CHART_TYPES } from "../../src/DashboardBuilder/Features/Dashboard/viewbar-model.js";

// Verbatim copy of the original dashboards.js chartIssue() — the regression oracle.
function legacyChartIssue(type, dimCount, measureCount) {
  switch (type) {
    case "pie":
    case "donut":
      if (measureCount !== 1) return "Pie/Donut shows one measure — put exactly one measure on a shelf.";
      if (dimCount < 1) return "Pie/Donut needs a dimension to slice by — add a dimension.";
      return null;
    case "scatter":
    case "square":
    case "circle":
      if (measureCount < 2) return "A point chart plots two measures (X and Y) — add a second measure.";
      return null;
    case "combo":
      if (measureCount < 2) return "Combo (dual-axis) needs two measures — add a second measure.";
      if (dimCount < 1) return "Combo needs a dimension for the category axis — add a dimension.";
      return null;
    case "stacked":
      if (measureCount < 2) return "Stacked bar stacks two or more measures — add another measure.";
      if (dimCount < 1) return "Stacked bar needs a dimension for the category axis — add a dimension.";
      return null;
    case "heatmap":
      if (dimCount !== 2) return "Heatmap needs exactly two dimensions (the axes) — put one on Columns and one on Rows.";
      if (measureCount < 1) return "Heatmap colours by one measure — add a measure.";
      return null;
    case "treemap":
      if (dimCount < 1 || dimCount > 2) return "Treemap nests by one or two dimensions — add one or two.";
      if (measureCount < 1) return "Treemap sizes by one measure — add a measure.";
      return null;
    case "waterfall":
      if (measureCount !== 1) return "Waterfall shows one measure as a run of changes — use exactly one measure.";
      if (dimCount < 1) return "Waterfall needs a dimension for its steps (e.g. month or category) — add one.";
      return null;
    case "funnel":
      if (measureCount !== 1) return "Funnel sizes its stages by one measure — use exactly one measure.";
      if (dimCount !== 1) return "Funnel needs exactly one dimension for its stages.";
      return null;
    case "gauge":
      if (measureCount !== 1) return "Gauge shows one measure — use exactly one measure.";
      if (dimCount !== 0) return "Gauge shows a single value — remove the dimensions (or use Bullet to compare categories).";
      return null;
    case "bullet":
      if (measureCount < 1 || measureCount > 2) return "Bullet compares one measure with a target — use one measure, plus an optional second measure as its target.";
      if (dimCount > 1) return "Bullet takes at most one dimension (one bar per member).";
      return null;
    case "gantt":
      if (measureCount !== 2) return "Gantt draws each row as a bar — use exactly two measures: the start (a number or a date) and the length.";
      if (dimCount !== 1) return "Gantt needs exactly one dimension for its rows (one bar per member).";
      return null;
    case "sankey":
      if (dimCount !== 2) return "Sankey draws flows between two dimensions — put one on Columns and one on Rows.";
      if (measureCount !== 1) return "Sankey sizes each flow by one measure — use exactly one measure.";
      return null;
    case "multiples":
      if (dimCount !== 2) return "Small multiples needs two dimensions: the first makes a panel per member, the second runs along each panel.";
      if (measureCount < 1) return "Small multiples plots a measure — add one.";
      return null;
    default:
      return null;
  }
}
const counts = (o = {}) => ({ dims: 0, shelfDims: 0, measures: 0, hasDate: false, textValue: false,
  discreteColor: false, numericField: false, ...o });

test("chartIssue matches the pre-P22 switch for every type, 0–3 dims × 0–3 measures", () => {
  for (const [type] of CHART_TYPES)
    for (let d = 0; d <= 3; d++)
      for (let m = 0; m <= 3; m++)
        assert.equal(chartIssue(type, d, m), legacyChartIssue(type, d, m), `${type} d=${d} m=${m}`);
});
test("types without needs accept any mapping", () => {
  for (const t of ["bar", "line", "area", "kpi", "text", "table", "histogram", "boxplot"]) {
    assert.equal(chartIssue(t, 0, 0), null, t);
    assert.equal(chartIssue(t, 9, 9), null, t);
    assert.ok(!Object.hasOwn(CHART_NEEDS, t), t);
  }
});
test("an unknown or prototype-named type has no needs", () => {
  assert.equal(chartIssue("constructor", 0, 0), null);
  assert.equal(chartIssue("nope", 0, 0), null);
});
test("min/max of a text value wins over every other rule, except on table / text / kpi", () => {
  const c = counts({ textValue: true, measures: 1, dims: 0 });
  assert.equal(issueFor("scatter", c), TEXT_VALUE_HINT);
  assert.equal(issueFor("bar", counts({ textValue: true, discreteColor: true, measures: 2 })), TEXT_VALUE_HINT);
  for (const t of ["table", "text", "kpi"]) assert.equal(issueFor(t, c), null, t);
});
test("a discrete Colour split needs exactly one measure, on the split types only", () => {
  const two = counts({ discreteColor: true, measures: 2, dims: 2 });
  for (const t of ["bar", "stacked", "line", "area"]) assert.equal(issueFor(t, two), COLOR_SPLIT_HINT, t);
  assert.equal(issueFor("bar", counts({ discreteColor: true, measures: 1, dims: 2 })), null);
  assert.equal(issueFor("pie", two), chartIssue("pie", 2, 2)); // pie isn't a split type → its own rule
});
test("histogram and box plot need a numeric field; other tables don't block them", () => {
  assert.equal(issueFor("histogram", counts()), "A histogram needs a numeric field — add one to Columns or Rows.");
  assert.equal(issueFor("boxplot", counts()), "A box plot needs a numeric field — add one to Columns or Rows.");
  assert.equal(statFieldHint("boxplot"), "A box plot needs a numeric field — add one to Columns or Rows.");
  assert.equal(issueFor("histogram", counts({ numericField: true, dims: 5, measures: 3 })), null);
});
test("otherwise issueFor is the rule table", () => {
  assert.equal(issueFor("heatmap", counts({ dims: 1, measures: 1 })), chartIssue("heatmap", 1, 1));
  assert.equal(issueFor("heatmap", counts({ dims: 2, measures: 1 })), null);
});
test("roleOf: an explicit role wins, else numeric → measure", () => {
  assert.equal(roleOf({ category: "numeric" }), "measure");
  assert.equal(roleOf({ category: "text" }), "dimension");
  assert.equal(roleOf({ category: "numeric", role: "dimension" }), "dimension");
  assert.equal(roleOf({ category: "text", role: "measure" }), "measure");
});
test("a discrete Colour split with one measure is valid on the split types (the chart draws it)", () => {
  // renderChart sends a one-measure colour split to renderColorSplit before the rule table — Stacked
  // stacks the colour series, so its "two or more measures" need doesn't apply.
  const c = counts({ discreteColor: true, measures: 1, dims: 2 });
  for (const t of ["bar", "stacked", "line", "area"]) assert.equal(issueFor(t, c), null, t);
});
