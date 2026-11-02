process.env.TZ = "America/New_York"; // fall-back day 2026-11-01 is 25 h long
import { test } from "node:test";
import assert from "node:assert/strict";
import { ganttBars, ganttTime, ganttLabelMargin, ganttAxisTime } from "../../src/DashboardBuilder/Features/Dashboard/gantt-model.js";
import { chartIssue } from "../../src/DashboardBuilder/Features/Dashboard/show-me-rules.js";
import { chartFit, markCount } from "../../src/DashboardBuilder/Features/Dashboard/chart-fit.js";
import { CHART_TYPES, chartIcon } from "../../src/DashboardBuilder/Features/Dashboard/viewbar-model.js";
import { CHART_TYPE_IDS } from "../../src/DashboardBuilder/Features/Core/sheet-schema.js";
import { P36_TYPES } from "../../src/DashboardBuilder/Features/Dashboard/result-model.js";
import { TEXT_VALUE_TYPES } from "../../src/DashboardBuilder/Features/Dashboard/filter-rules.js";

test("numeric start + duration: the bar runs from start to start + duration", () => {
  const g = ganttBars(["a", "b"], [10, 25], [5, 10]);
  assert.equal(g.isDate, false);
  assert.deepEqual(g.bars.map((b) => [b.name, b.start, b.end, b.duration]), [["a", 10, 15, 5], ["b", 25, 35, 10]]);
  assert.equal(g.skipped, 0);
});
test("a date start (text) takes a duration in days and keeps the category order", () => {
  const g = ganttBars(["x", "y"], ["2026-01-05", "2026-01-10 12:00:00"], [2, 0.5]);
  assert.equal(g.isDate, true);
  assert.equal(g.bars[0].start, new Date(2026, 0, 5).getTime());
  assert.equal(g.bars[0].end, g.bars[0].start + 2 * 86400000);
  assert.equal(g.bars[1].start, new Date(2026, 0, 10, 12).getTime());
  assert.equal(g.bars[1].end - g.bars[1].start, 43200000);
  assert.equal(g.hasTime, true);
});
test("rows with no valid start or a negative / non-numeric duration are skipped and counted", () => {
  const g = ganttBars(["a", "b", "c", "d"], [1, null, 3, "n/a"], [1, 1, -2, 1]);
  assert.deepEqual(g.bars.map((b) => b.name), ["a"]);
  assert.equal(g.skipped, 3);
});
test("a zero duration is kept (drawn as a thin bar)", () => {
  assert.equal(ganttBars(["a"], [4], [0]).bars.length, 1);
});
test("ganttTime: date only at midnight, else with the time", () => {
  assert.equal(ganttTime(new Date(2026, 0, 5).getTime(), false), "2026-01-05");
  assert.equal(ganttTime(new Date(2026, 0, 5, 9, 30).getTime(), true), "2026-01-05 09:30");
});
test("gantt needs one dimension and exactly two measures", () => {
  assert.equal(chartIssue("gantt", 1, 2), null);
  assert.match(chartIssue("gantt", 1, 1), /start/i);
  assert.match(chartIssue("gantt", 1, 3), /start/i);
  assert.match(chartIssue("gantt", 0, 2), /dimension/i);
  assert.match(chartIssue("gantt", 2, 2), /dimension/i);
});
test("gantt is pickable, saveable, drawn from the query result, reads date text, and scrolls by rows", () => {
  assert.deepEqual(CHART_TYPES.find(([v]) => v === "gantt"), ["gantt", "Gantt"]);
  assert.equal([...CHART_TYPE_IDS].filter((t) => t === "gantt").length, 1);
  assert.equal(P36_TYPES.has("gantt"), true);
  assert.equal(TEXT_VALUE_TYPES.has("gantt"), true);
  assert.equal(TEXT_VALUE_TYPES.has("bar"), false);
  assert.equal(chartIcon("gantt"), "chart-gantt");
  assert.ok(chartFit({ type: "gantt", categories: Array.from({ length: 60 }, (_, i) => `r${i}`) }, 600, 400).minHeight > 400);
});

test("an end that is not a finite number (huge length) skips the row", () => {
  assert.equal(ganttBars(["a"], [1e308], [1e308]).skipped, 1);
  assert.equal(ganttBars(["a"], [1], [Infinity]).skipped, 1);
  const g = ganttBars(["a", "b"], ["2026-01-05", "2026-01-05"], [1e12, 3]);
  assert.equal(g.skipped, 1);
  assert.deepEqual(g.bars.map((b) => b.name), ["b"]);
});
test("a day length is calendar days: across the fall-back day it ends at the same local time", () => {
  const g = ganttBars(["a"], ["2026-11-01"], [1]);
  assert.equal(g.bars[0].end, new Date(2026, 10, 2).getTime());
  const h = ganttBars(["a"], ["2026-11-01"], [1.5]);
  assert.equal(h.bars[0].end, new Date(2026, 10, 2).getTime() + 43200000);
});
test("date axis shows the time when the bars have a time and span under three days", () => {
  const day = 86400000;
  assert.equal(ganttAxisTime([{ start: 0, end: day }], true), true);
  assert.equal(ganttAxisTime([{ start: 0, end: 10 * day }], true), false);
  assert.equal(ganttAxisTime([{ start: 0, end: day }], false), false);
});
test("the right margin grows with the widest length label", () => {
  assert.equal(ganttLabelMargin(["3"]), 56);
  assert.ok(ganttLabelMargin(["365.5 days", "1,234,567 days"]) > 56);
  assert.ok(ganttLabelMargin(["x".repeat(200)]) <= 240);
});
test("gantt mark count is one per row and it only scrolls vertically", () => {
  const spec = { type: "gantt", categories: ["a", "b", "c"] };
  assert.equal(markCount(spec), 3);
  assert.equal(chartFit(spec, 600, 400).minWidth, 0);
});
