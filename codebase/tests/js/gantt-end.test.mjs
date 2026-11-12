process.env.TZ = "America/New_York";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ganttBars, ganttNotice, ganttSplit, GANTT_LENGTH_CHOICES } from "../../src/DashboardBuilder/Features/Dashboard/gantt-model.js";
import { CLICK_TYPES } from "../../src/DashboardBuilder/Features/Dashboard/result-model.js";
import { COLOR_USES, planDims } from "../../src/DashboardBuilder/Features/Dashboard/sheet-plan.js";
import { defaultFormat, emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { parseWorkbook, serializeWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

const END = { end: true };

test("end mode, numbers: the bar spans start to end and the length is end - start", () => {
  const g = ganttBars(["a", "b"], [10, 25], [15, 40], END);
  assert.deepEqual(g.bars.map((b) => [b.name, b.start, b.end, b.duration]), [["a", 10, 15, 5], ["b", 25, 40, 15]]);
  assert.equal(g.skipped, 0);
});
test("end mode, dates: the length counts calendar days between the two dates, time of day included", () => {
  const g = ganttBars(["x", "y", "z"], ["2026-01-05", "2026-01-05", "2026-11-01"], ["2026-01-08", "2026-01-05 12:00:00", "2026-11-02"], END);
  assert.equal(g.isDate, true);
  assert.deepEqual(g.bars.map((b) => b.duration), [3, 0.5, 1]); // the last spans the 25-hour fall-back day: still one calendar day
  assert.equal(g.bars[0].end, new Date(2026, 0, 8).getTime());
  assert.equal(g.hasTime, true);
});
test("end mode skips a row whose end is missing, before the start, or the wrong kind; end = start is a thin bar", () => {
  const g = ganttBars(["a", "b", "c", "d", "e"], [10, 10, 10, 10, 10], [12, 9, null, "n/a", 10], END);
  assert.deepEqual(g.bars.map((b) => b.name), ["a", "e"]);
  assert.equal(g.skipped, 3);
  const d = ganttBars(["a", "b", "c"], ["2026-01-05", "2026-01-05", "2026-01-05"], ["2026-01-04", 7, "2026-01-05"], END);
  assert.deepEqual(d.bars.map((b) => b.name), ["c"]);
  assert.equal(d.skipped, 2);
});
test("the length mode is unchanged and is the default", () => {
  assert.equal(ganttBars(["a"], [10], [5], { end: false }).bars[0].end, 15);
  assert.equal(ganttBars(["a"], [10], [5]).bars[0].end, 15);
  assert.deepEqual(GANTT_LENGTH_CHOICES.map(([v]) => v), ["length", "end"]);
});
test("the notice names the end rule in end mode", () => {
  assert.match(ganttNotice(2, true), /end/i);
  assert.match(ganttNotice(1, false), /negative length/);
  assert.equal(ganttNotice(0, true), null);
});

test("slots and colours: rows sharing a slot share a y position; groups keep first-seen order", () => {
  const g = ganttBars(["A", "A", "B"], [1, 6, 2], [3, 2, 4], { slots: ["A", "A", "B"], colours: ["todo", "done", "todo"] });
  assert.deepEqual(g.rows, ["A", "B"]);
  assert.deepEqual(g.groups, ["todo", "done"]);
  assert.deepEqual(g.bars.map((b) => [b.i, b.group]), [[0, 0], [0, 1], [1, 0]]);
  assert.equal(g.skipped, 0);
});
test("without slots every row keeps its own slot and rows = the categories", () => {
  const g = ganttBars(["a", "b"], [1, 2], [1, 1]);
  assert.deepEqual(g.rows, ["a", "b"]);
  assert.deepEqual(g.groups, []);
  assert.equal(g.bars[0].group, -1);
});
test("a skipped row's slot still exists (no gap closes) and its group is still listed", () => {
  const g = ganttBars(["A", "B"], [null, 2], [1, 1], { slots: ["A", "B"], colours: ["x", "y"] });
  assert.deepEqual(g.rows, ["A", "B"]);
  assert.deepEqual(g.bars.map((b) => b.i), [1]);
  assert.deepEqual(g.groups, ["x", "y"]);
});

test("ganttSplit: the last key is the colour; the others label the row and make its slot", () => {
  const rows = [{ keys: ["T1", "todo"] }, { keys: ["T1", "done"] }, { keys: ["T2", null] }];
  const fmt = (k) => (k == null ? "—" : String(k));
  const s = ganttSplit(rows, fmt, true);
  assert.deepEqual(s.categories, ["T1", "T1", "T2"]);
  assert.deepEqual(s.slots, ['["T1"]', '["T1"]', '["T2"]']);
  assert.deepEqual(s.colours, ["todo", "done", "—"]);
  assert.deepEqual(s.rawRows, ["T1", "T1", "T2"]);
  const plain = ganttSplit([{ keys: ["a"] }], fmt, false);
  assert.deepEqual(plain.categories, ["a"]);
  assert.equal(plain.colours, null);
  assert.equal(plain.slots, null);
});

test("click-to-filter and Colour reach the Gantt; the colour dimension is the last key", () => {
  assert.ok(CLICK_TYPES.has("gantt"));
  assert.ok(COLOR_USES.has("gantt"));
  const f = (column, type = "String") => ({ db: "d", table: "t", column, type });
  const sheet = { ...emptySheet(), chartType: "gantt", rows: [f("task")], columns: [], color: [f("status")] };
  assert.deepEqual(planDims(sheet).keyOrder.map((k) => k.column), ["task", "status"]);
});

test("the format's Length setting defaults to length, round-trips, and resets with an issue when unknown", () => {
  assert.equal(defaultFormat().ganttLength, undefined, "kept off the defaults so older files round-trip unchanged");
  const roundTrip = (format) => {
    const sheet = { ...emptySheet(), chartType: "gantt", format };
    const state = { entities: new Map(), relationships: [], tabs: [{ id: "ws#1", kind: "worksheet", name: "D", sheet }], active: { kind: "worksheet", id: "ws#1" } };
    return parseWorkbook(JSON.stringify(serializeWorkbook(state)));
  };
  assert.equal(roundTrip({ ganttLength: "end" }).worksheets[0].sheet.format.ganttLength, "end");
  const bad = roundTrip({ ganttLength: "stop" });
  assert.equal(bad.worksheets[0].sheet.format.ganttLength, "length");
  assert.ok(bad.issues.some((i) => /length/i.test(i)));
  assert.equal(roundTrip({ target: 5 }).issues.length, 0);
});

test("raws: each slot keeps the raw value of its first row (what a click filters on)", () => {
  const g = ganttBars(["A", "A", "B"], [1, 6, 2], [3, 2, 4], { slots: ["s1", "s1", "s2"], colours: ["x", "y", "x"], raws: [10, 10, 20] });
  assert.deepEqual(g.raws, [10, 20]);
  assert.deepEqual(ganttBars(["a", "b"], [1, 2], [1, 1], { raws: [7, 8] }).raws, [7, 8]);
});
