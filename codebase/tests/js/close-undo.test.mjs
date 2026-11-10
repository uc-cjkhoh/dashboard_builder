import { test } from "node:test";
import assert from "node:assert/strict";
import { captureClose, sealClose, planRestore, closedToast, restoredToast } from "../../src/DashboardBuilder/Features/Tabs/close-undo.js";

const ws = (id, name) => ({ id, kind: "worksheet", name, sheet: {} });
const db = (id, name, widgets) => ({ id, kind: "dashboard", name, widgets, size: null, notes: "" });
const st = (id, name, steps) => ({ id, kind: "story", name, steps });

// Mimic store.closeTab: remove the tab, drop its widgets / steps / button links (new arrays).
function close(tabs, id) {
  const snap = captureClose(tabs, id, true);
  const i = tabs.findIndex((t) => t.id === id);
  tabs.splice(i, 1);
  for (const t of tabs) {
    if (t.kind === "dashboard" && t.widgets.some((w) => w.sheetId === id || w.target === id)) t.widgets = t.widgets.filter((w) => w.sheetId !== id).map((w) => (w.target === id ? { ...w, target: null } : w));
    if (t.kind === "story" && t.steps.some((s) => s.target === id)) t.steps = t.steps.filter((s) => s.target !== id);
  }
  sealClose(snap, tabs);
  return snap;
}

test("capture remembers the tab, its position and whether it was showing", () => {
  const tabs = [ws("a", "A"), ws("b", "B")];
  const snap = captureClose(tabs, "b", false);
  assert.equal(snap.tab, tabs[1]);
  assert.equal(snap.index, 1);
  assert.equal(snap.wasActive, false);
  assert.equal(captureClose(tabs, "zzz", false), null);
});

test("restore puts the tab back at its position with the widgets, steps and links the close removed", () => {
  const widgets = [{ id: "w1", kind: "sheet", sheetId: "a" }, { id: "w2", kind: "nav", target: "a" }];
  const steps = [{ caption: "x", target: "a" }, { caption: "y", target: "b" }];
  const tabs = [ws("a", "A"), db("d", "D", widgets), ws("b", "B"), st("s", "S", steps)];
  const snap = close(tabs, "a");
  assert.equal(tabs[0].id, "d");
  const plan = planRestore(snap, tabs, 50);
  assert.equal(plan.ok, true);
  assert.equal(plan.index, 0);
  assert.deepEqual(plan.writes.map((w) => [w.id, w.kind, w.value]), [["d", "dashboard", widgets], ["s", "story", steps]]);
});

test("a dashboard or story that changed since the close keeps its newer content and is named as skipped", () => {
  const tabs = [ws("a", "A"), db("d", "D", [{ id: "w1", kind: "sheet", sheetId: "a" }]), db("e", "E", [{ id: "w9", kind: "sheet", sheetId: "a" }])];
  const snap = close(tabs, "a");
  tabs[0].widgets = [{ id: "w3", kind: "text" }]; // edited meanwhile
  const plan = planRestore(snap, tabs, 50);
  assert.deepEqual(plan.writes.map((w) => w.id), ["e"]);
  assert.deepEqual(plan.skipped, ["D"]);
});

test("a dashboard or story the close did not touch is left alone", () => {
  const tabs = [ws("a", "A"), db("d", "D", [{ id: "w1", kind: "text" }])];
  const plan = planRestore(close(tabs, "a"), tabs, 50);
  assert.deepEqual(plan.writes, []);
  assert.deepEqual(plan.skipped, []);
});

test("closing a dashboard or story restores it whole (it carries its own content)", () => {
  const tabs = [ws("a", "A"), db("d", "D", [{ id: "w1", kind: "sheet", sheetId: "a" }])];
  const snap = close(tabs, "d");
  tabs.push(ws("c", "C"));
  const plan = planRestore(snap, tabs, 50);
  assert.equal(plan.index, 1);
  assert.equal(snap.tab.widgets.length, 1);
});

test("the position is clamped when tabs after it were closed too", () => {
  const tabs = [ws("a", "A"), ws("b", "B"), ws("c", "C")];
  const snap = close(tabs, "c");
  assert.equal(planRestore(snap, tabs, 50).index, 2);
  tabs.splice(0, 2);
  assert.equal(planRestore(snap, tabs, 50).index, 0);
});

test("refused when the tab is already back or the workbook is full", () => {
  const tabs = [ws("a", "A"), ws("b", "B")];
  const snap = close(tabs, "b");
  assert.match(planRestore(snap, [ws("a", "A"), snap.tab], 50).error, /already/);
  const full = planRestore(snap, tabs, 1);
  assert.equal(full.ok, false);
  assert.match(full.error, /at most 1 tabs|close one first/);
});

test("the toasts name the tab; restoring reports dashboards skipped because they changed", () => {
  assert.equal(closedToast({ name: "Worksheet 1" }), "Closed “Worksheet 1”.");
  assert.equal(restoredToast({ name: "W" }, []), "Restored “W”.");
  assert.equal(restoredToast({ name: "W" }, ["D", "E"]), "Restored “W”. D, E changed since, so what it showed was not brought back.");
  const tabs = [ws("a", "A"), db("d", "D", [{ id: "w1", kind: "sheet", sheetId: "a" }])];
  const snap = close(tabs, "a");
  tabs[0].widgets = [];
  assert.match(restoredToast(snap.tab, planRestore(snap, tabs, 50).skipped), /D changed since/);
});
