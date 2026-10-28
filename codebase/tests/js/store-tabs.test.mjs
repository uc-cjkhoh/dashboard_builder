import { test } from "node:test";
import assert from "node:assert/strict";
import * as st from "../../src/DashboardBuilder/Features/Core/store.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

const reset = () => { for (const t of [...st.tabs]) st.closeTab(t.id); st.showModel(); };
const events = (...types) => { const log = []; for (const t of types) st.bus.addEventListener(t, (e) => log.push([t, e.detail?.id])); return log; };

test("createWorksheet / createDashboard: ids, kinds, default names, activation, one ordered list", () => {
  reset();
  const w1 = st.createWorksheet(), d1 = st.createDashboard(), w2 = st.createWorksheet();
  assert.deepEqual(st.tabs.map((t) => [t.id.slice(0, 3), t.kind, t.name]), [["ws#", "worksheet", "Worksheet 1"], ["db#", "dashboard", "Dashboard 1"], ["ws#", "worksheet", "Worksheet 2"]]);
  assert.deepEqual(d1.widgets, []);
  assert.ok(w1.sheet.columns && w2.sheet.marks);
  assert.deepEqual(st.currentView(), { kind: "worksheet", id: w2.id });
  assert.equal(st.activeWorksheet().id, w2.id);
  assert.equal(st.activeDashboard(), null);
  assert.equal(st.isWorksheetActive(), true);
  st.switchTab(d1.id);
  assert.equal(st.isDashboardActive(), true);
  assert.equal(st.isWorksheetActive(), false);
  assert.equal(st.activeWorksheet(), null);
  assert.equal(st.activeDashboard().id, d1.id);
  assert.deepEqual(st.worksheets().map((t) => t.name), ["Worksheet 1", "Worksheet 2"]);
  assert.deepEqual(st.dashboards().map((t) => t.name), ["Dashboard 1"]);
  reset();
});

test("the tab limit covers both kinds and creation returns null with a message", () => {
  reset();
  assert.equal(st.tabLimitError(), null);
  for (let i = 0; i < LIMITS.tabs; i++) assert.ok(i % 2 ? st.createDashboard() : st.createWorksheet());
  assert.match(st.tabLimitError(), /at most 50 tabs/);
  assert.equal(st.createWorksheet(), null);
  assert.equal(st.createDashboard(), null);
  assert.equal(st.tabs.length, 50);
  assert.equal(st.duplicateWorksheet(st.worksheets()[0].id).ok, false);
  reset();
});

test("closing a worksheet removes its widgets from every dashboard and notifies each; the text widgets stay", () => {
  reset();
  const w1 = st.createWorksheet(), w2 = st.createWorksheet(), d1 = st.createDashboard(), d2 = st.createDashboard(), d3 = st.createDashboard();
  const sheetW = (id, sheetId, y) => ({ id, kind: "sheet", sheetId, x: 0, y, w: 6, h: 4 });
  st.setWidgets(d1.id, [sheetW("w#a", w1.id, 0), { id: "w#t", kind: "text", heading: "h", body: "", x: 0, y: 4, w: 12, h: 1 }, sheetW("w#b", w2.id, 5)]);
  st.setWidgets(d2.id, [sheetW("w#c", w1.id, 0)]);
  st.setWidgets(d3.id, [sheetW("w#d", w2.id, 0)]);
  const log = events("dashboard:changed", "tabs:changed", "view:changed");
  st.closeTab(w1.id);
  assert.deepEqual(d1.widgets.map((w) => w.id), ["w#t", "w#b"]);
  assert.deepEqual(d2.widgets, []);
  assert.deepEqual(d3.widgets.map((w) => w.id), ["w#d"]);
  assert.deepEqual(log.filter(([t]) => t === "dashboard:changed").map(([, id]) => id), [d1.id, d2.id]);
  reset();
});

test("closing a dashboard touches no worksheet; closing the active tab activates its neighbour, then the model", () => {
  reset();
  const w = st.createWorksheet(), d = st.createDashboard();
  st.setWidgets(d.id, [{ id: "w#1", kind: "sheet", sheetId: w.id, x: 0, y: 0, w: 6, h: 4 }]);
  st.closeTab(d.id);
  assert.equal(st.worksheets().length, 1);
  assert.equal(st.worksheetById(w.id).sheet, w.sheet);
  assert.deepEqual(st.currentView(), { kind: "worksheet", id: w.id });
  st.closeTab(w.id);
  assert.deepEqual(st.currentView(), { kind: "model" });
  assert.equal(st.isModelActive(), true);
});

test("events: updateSheet -> worksheet:changed, setWidgets -> dashboard:changed (never the other way round)", () => {
  reset();
  const w = st.createWorksheet(), d = st.createDashboard();
  const log = events("worksheet:changed", "dashboard:changed");
  st.updateSheet(w.id, { ...w.sheet, chartType: "line" });
  st.setWidgets(d.id, []);
  st.updateSheet(d.id, {}); // not a worksheet: ignored
  st.setWidgets(w.id, []); // not a dashboard: ignored
  assert.deepEqual(log, [["worksheet:changed", w.id], ["dashboard:changed", d.id]]);
  assert.equal(st.worksheetById(w.id).sheet.chartType, "line");
  reset();
});

test("duplicateWorksheet copies after the source and activates; renameTab and nextWidgetId", () => {
  reset();
  const a = st.createWorksheet(), d = st.createDashboard(), b = st.createWorksheet();
  const r = st.duplicateWorksheet(a.id);
  assert.equal(r.ok, true);
  assert.deepEqual(st.tabs.map((t) => t.name), ["Worksheet 1", "Worksheet 1 copy", "Dashboard 1", "Worksheet 2"]);
  assert.equal(st.activeWorksheet().id, r.tab.id);
  assert.equal(st.duplicateWorksheet(d.id).ok, false); // dashboards are not duplicated
  st.renameTab(d.id, "Overview");
  assert.equal(st.tabById(d.id).name, "Overview");
  assert.notEqual(st.nextWidgetId(), st.nextWidgetId());
  assert.match(st.nextWidgetId(), /^w#\d+$/);
  assert.ok(b);
  reset();
});

test("worksheetHasContent is about worksheets", () => {
  reset();
  const w = st.createWorksheet(), d = st.createDashboard();
  assert.equal(st.worksheetHasContent(w.id), false);
  st.updateSheet(w.id, { ...w.sheet, columns: [{ db: "d", table: "t", column: "c", category: "text" }] });
  assert.equal(st.worksheetHasContent(w.id), true);
  assert.equal(st.worksheetHasContent(d.id), false);
  reset();
});
