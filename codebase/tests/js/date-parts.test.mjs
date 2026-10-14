import { test } from "node:test";
import assert from "node:assert/strict";
import { stepPart, partLabel, labelParts, isGroupingPart, DATE_PART_CHOICES } from "../../src/DashboardBuilder/Features/Dashboard/date-parts.js";
import { DATE_PARTS } from "../../src/DashboardBuilder/Features/Core/sheet-schema.js";

test("every picker choice is a known part", () => {
  for (const [v] of DATE_PART_CHOICES) assert.ok(DATE_PARTS.has(v), v);
});
test("+ / − step through year → quarter → month → day → hour", () => {
  assert.equal(stepPart("year", 1), "quarter");
  assert.equal(stepPart("month", 1), "day");
  assert.equal(stepPart("day", -1), "month");
  assert.equal(stepPart("hour", 1), null);
  assert.equal(stepPart("year", -1), null);
  assert.equal(stepPart("auto", 1), "year");
  assert.equal(stepPart("monthOfYear", -1), "hour");
  assert.equal(stepPart("week", 1), "day"); // week sits beside month
});
test("a Date column stops at day", () => {
  assert.equal(stepPart("day", 1, true), null);
  assert.equal(stepPart("auto", -1, true), "day");
});
test("labels per part", () => {
  assert.equal(partLabel("year", "2024-01-01"), "2024");
  assert.equal(partLabel("quarter", "2024-07-01"), "2024 Q3");
  assert.equal(partLabel("month", "2024-03-01"), "Mar 2024");
  assert.equal(partLabel("week", "2024-03-04"), "Week of 2024-03-04");
  assert.equal(partLabel("hour", "2024-03-04 13:00:00"), "2024-03-04 13:00");
  assert.equal(partLabel("monthOfYear", "12"), "Dec");
  assert.equal(partLabel("dayOfWeek", "1"), "Mon");
  assert.equal(partLabel("dayOfWeek", "7"), "Sun");
  assert.equal(partLabel("quarterOfYear", "2"), "Q2");
  assert.equal(partLabel("hourOfDay", "9"), "09:00");
  assert.equal(partLabel("month", null), null);
});
test("only grouping parts relabel, and only their own key", () => {
  assert.equal(isGroupingPart("auto"), false);
  assert.equal(isGroupingPart("exact"), false);
  assert.equal(isGroupingPart("evil"), false);
  const r = { rows: [{ keys: ["2024-03-01", "UK"], values: [1] }, { keys: ["Other (3 more)"], values: [2], isOther: true }] };
  const out = labelParts(r, ["month", null]);
  assert.deepEqual(out.rows[0].keys, ["Mar 2024", "UK"]);
  assert.deepEqual(out.rows[1].keys, ["Other (3 more)"]);
  assert.equal(labelParts(r, [null, "auto"]), r);
});
