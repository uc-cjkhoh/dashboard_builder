import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
import { validateNotes, cleanNotes, savedNotes, printLines } from "../../src/DashboardBuilder/Features/Board/board-notes.js";
import { parseWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

test("the notes limit is 1000 characters", () => assert.equal(LIMITS.dashboardNotes, 1000));

test("validateNotes trims, allows empty, rejects over the limit (never cuts)", () => {
  assert.deepEqual(validateNotes("  hi  "), { ok: true, value: "hi" });
  assert.deepEqual(validateNotes(""), { ok: true, value: "" });
  assert.equal(validateNotes("x".repeat(LIMITS.dashboardNotes)).ok, true);
  const long = validateNotes("x".repeat(LIMITS.dashboardNotes + 1));
  assert.equal(long.ok, false);
  assert.match(long.error, /1000/);
  assert.equal(validateNotes(5).ok, false);
});

test("cleanNotes: absent is empty; a non-string or over-long value is dropped with an issue, not cut", () => {
  const issues = [];
  assert.equal(cleanNotes(undefined, "D", issues), "");
  assert.equal(cleanNotes("ok", "D", issues), "ok");
  assert.deepEqual(issues, []);
  assert.equal(cleanNotes(7, "D", issues), "");
  assert.equal(cleanNotes("x".repeat(1001), "D", issues), "");
  assert.equal(issues.length, 2);
});

test("savedNotes writes nothing when empty", () => {
  assert.deepEqual(savedNotes(""), {});
  assert.deepEqual(savedNotes(undefined), {});
  assert.deepEqual(savedNotes("a"), { notes: "a" });
});

test("printLines: name, worksheets, filter, updated, notes — only what is present", () => {
  assert.deepEqual(printLines({ name: "Ov", sheets: ["A", "B"], filter: "region = EU", printedAt: "Printed 10:00:00", notes: "line1\nline2" }),
    ["Worksheets: A, B", "Filtered by region = EU", "Printed 10:00:00", "line1\nline2"]);
  assert.deepEqual(printLines({ name: "Ov", sheets: [], filter: null, printedAt: null, notes: "" }), []);
});

test("notes round-trip through the workbook; an over-long saved note is rejected with an issue", () => {
  const base = JSON.stringify({ format: "dashboard-builder-workbook", version: 2, entities: [], relationships: [], worksheets: [], dashboards: [{ name: "D", widgets: [], notes: "hello" }, { name: "E", widgets: [], notes: "x".repeat(1001) }, { name: "F", widgets: [] }] });
  const r = parseWorkbook(base);
  assert.equal(r.dashboards[0].notes, "hello");
  assert.equal(r.dashboards[1].notes, "");
  assert.equal(r.dashboards[2].notes, "");
  assert.ok(r.issues.some((i) => /notes/i.test(i)));
});
