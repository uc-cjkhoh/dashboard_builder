import { test } from "node:test";
import assert from "node:assert/strict";
import { SIZE_PRESETS, sizeError, cleanSize, savedSize, sizeKey } from "../../src/DashboardBuilder/Features/Board/board-size.js";
import { layoutBoard } from "../../src/DashboardBuilder/Features/Board/board-layout.js";
import { parseWorkbook, serializeWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

test("sizeError accepts whole pixels inside the limits only", () => {
  assert.equal(sizeError({ width: 1280, height: 720 }), null);
  assert.match(sizeError({ width: 100, height: 720 }), /width/);
  assert.match(sizeError({ width: 1280, height: 5000 }), /height/);
  assert.match(sizeError({ width: 1280.5, height: 720 }), /whole/);
  assert.ok(sizeError(null));
});

test("every preset is valid; the first entry of a select is Automatic (null)", () => {
  for (const p of SIZE_PRESETS) assert.equal(sizeError(p), null);
  assert.equal(sizeKey(null), "auto");
  assert.equal(sizeKey({ width: 1280, height: 720 }), "1280x720");
});

test("cleanSize: absent is automatic; a bad shape is dropped with an issue; out-of-range is rejected, never clamped", () => {
  const issues = [];
  assert.equal(cleanSize(undefined, "D", issues), null);
  assert.equal(cleanSize(null, "D", issues), null);
  assert.deepEqual(issues, []);
  assert.deepEqual(cleanSize({ width: 1280, height: 720 }, "D", issues), { width: 1280, height: 720 });
  assert.equal(cleanSize("big", "D", issues), null);
  assert.equal(cleanSize({ width: "x", height: 720 }, "D", issues), null);
  assert.equal(cleanSize({ width: 99999, height: 10 }, "D", issues), null);
  assert.equal(cleanSize({ width: 1280.5, height: 720 }, "D", issues), null);
  assert.deepEqual(cleanSize({ width: 1000, height: 700 }, "D", issues), { width: 1000, height: 700 });
  assert.equal(issues.length, 4);
});

test("savedSize writes nothing for automatic", () => {
  assert.deepEqual(savedSize(null), {});
  assert.deepEqual(savedSize({ width: 800, height: 600 }), { size: { width: 800, height: 600 } });
});

test("fixed layout fills the box: rows stretch to the height, columns to the width, never stacked", () => {
  const widgets = [{ id: "a", x: 0, y: 0, w: 6, h: 2 }, { id: "b", x: 6, y: 2, w: 6, h: 2 }];
  const r = layoutBoard(widgets, 300, { rowH: 64, gap: 8, fixed: { width: 1200, height: 408 } });
  assert.equal(r.stacked, false);
  assert.equal(r.height, 408);
  const a = r.rects.get("a"), b = r.rects.get("b");
  assert.equal(a.left, 0);
  assert.ok(Math.abs(b.left + b.width - 1200) < 1e-6);
  assert.ok(Math.abs(b.top + b.height - 408) < 1e-6);
});

test("fixed layout of an empty board is the box", () => {
  assert.equal(layoutBoard([], 300, { rowH: 64, gap: 8, fixed: { width: 800, height: 600 } }).height, 600);
});

const wbText = (dash) => JSON.stringify({ format: "dashboard-builder-workbook", version: 2, entities: [], relationships: [], worksheets: [], dashboards: [dash] });
test("workbook: size round-trips; an older file without size opens automatic", () => {
  const wb = parseWorkbook(wbText({ name: "D", widgets: [], size: { width: 1366, height: 768 } }));
  assert.deepEqual(wb.dashboards[0].size, { width: 1366, height: 768 });
  const old = parseWorkbook(wbText({ name: "D", widgets: [] }));
  assert.equal(old.dashboards[0].size, null);
  const bad = parseWorkbook(wbText({ name: "D", widgets: [], size: 7 }));
  assert.equal(bad.dashboards[0].size, null);
  assert.ok(bad.issues.some((i) => /size/.test(i)));
});

test("serializeWorkbook writes size only for a fixed dashboard", () => {
  const base = { entities: [], relationships: [], active: null };
  const out = serializeWorkbook({ ...base, tabs: [{ kind: "dashboard", name: "A", widgets: [], size: { width: 800, height: 600 } }, { kind: "dashboard", name: "B", widgets: [], size: null }, { kind: "dashboard", name: "C", widgets: [] }] });
  assert.deepEqual(out.dashboards[0].size, { width: 800, height: 600 });
  assert.equal("size" in out.dashboards[1], false);
  assert.equal("size" in out.dashboards[2], false);
});

test("fixedRowH is floored: 96 rows in a short box do not collapse", async () => {
  const { fixedRowH } = await import("../../src/DashboardBuilder/Features/Board/board-layout.js");
  assert.ok(fixedRowH([{ y: 0, h: 96 }], { width: 800, height: 240 }, 8, 64) >= 16);
});
