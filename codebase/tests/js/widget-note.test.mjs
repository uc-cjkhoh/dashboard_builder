import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
import { validateWidgetNote, cleanWidgetNote, widgetNoteLines } from "../../src/DashboardBuilder/Features/Board/widget-note.js";
import { cleanWidgets, savedWidgets } from "../../src/DashboardBuilder/Features/Board/board-model.js";
import { printLines } from "../../src/DashboardBuilder/Features/Board/board-notes.js";
import { parseWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

test("the widget note limit is 300 characters", () => assert.equal(LIMITS.widgetNote, 300));

test("validateWidgetNote trims, allows empty, rejects over the limit (never cuts)", () => {
  assert.deepEqual(validateWidgetNote("  hi "), { ok: true, value: "hi" });
  assert.deepEqual(validateWidgetNote(""), { ok: true, value: "" });
  assert.equal(validateWidgetNote("x".repeat(300)).ok, true);
  const r = validateWidgetNote("x".repeat(301));
  assert.equal(r.ok, false);
  assert.match(r.error, /300/);
  assert.equal(validateWidgetNote(3).ok, false);
});

test("cleanWidgetNote: absent is empty; a non-string or over-long note is dropped with an issue", () => {
  const issues = [];
  assert.equal(cleanWidgetNote(undefined, "D", issues), "");
  assert.equal(cleanWidgetNote("ok", "D", issues), "ok");
  assert.equal(issues.length, 0);
  assert.equal(cleanWidgetNote(1, "D", issues), "");
  assert.equal(cleanWidgetNote("x".repeat(301), "D", issues), "");
  assert.equal(issues.length, 2);
});

test("widgetNoteLines: one line per noted worksheet widget, named, in reading order", () => {
  const ws = [{ id: "a", kind: "sheet", sheetId: "s1", x: 6, y: 0, note: "B note" }, { id: "b", kind: "sheet", sheetId: "s2", x: 0, y: 0, note: "A note" },
    { id: "c", kind: "sheet", sheetId: "s3", x: 0, y: 5 }, { id: "d", kind: "text", x: 0, y: 9, note: "ignored" }];
  assert.deepEqual(widgetNoteLines(ws, (w) => ({ s1: "Beta", s2: "Alpha", s3: "Gamma" })[w.sheetId]), ["Note on Alpha: A note", "Note on Beta: B note"]);
  assert.deepEqual(widgetNoteLines([], () => "x"), []);
});

test("printLines carries the widget notes before the dashboard note", () => {
  assert.deepEqual(printLines({ sheets: ["A"], widgetNotes: ["Note on A: n"], notes: "dash" }), ["Worksheets: A", "Note on A: n", "dash"]);
});

test("a sheet widget's note is saved only when present and survives import", () => {
  const saved = savedWidgets([{ id: "w#1", kind: "sheet", sheetId: "s", x: 0, y: 0, w: 4, h: 4, note: "n" }, { id: "w#2", kind: "sheet", sheetId: "s", x: 4, y: 0, w: 4, h: 4 }], new Map([["s", 0]]));
  assert.equal(saved[0].note, "n");
  assert.equal("note" in saved[1], false);
  const issues = [];
  const out = cleanWidgets([{ kind: "sheet", sheet: 0, x: 0, y: 0, w: 4, h: 4, note: "n" }, { kind: "sheet", sheet: 0, x: 4, y: 0, w: 4, h: 4, note: "x".repeat(301) }], { worksheetCount: 1, where: "D" }, issues);
  assert.equal(out[0].note, "n");
  assert.equal("note" in out[1], false);
  assert.ok(issues.some((i) => /note/i.test(i)));
});

test("a widget note round-trips through parseWorkbook", () => {
  const wb = JSON.stringify({ format: "dashboard-builder-workbook", version: 2, entities: [], relationships: [], worksheets: [{ name: "W" }], dashboards: [{ name: "D", widgets: [{ kind: "sheet", sheet: 0, x: 0, y: 0, w: 4, h: 4, note: "hello" }] }] });
  const r = parseWorkbook(wb);
  assert.equal(r.dashboards[0].widgets[0].note, "hello");
});
