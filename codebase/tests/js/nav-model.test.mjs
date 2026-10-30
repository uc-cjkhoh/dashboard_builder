import { test } from "node:test";
import assert from "node:assert/strict";
import { validateNavEdit, navTargets, navChanged, clearNavTarget } from "../../src/DashboardBuilder/Features/Board/nav-model.js";
import { cleanWidgets, savedWidgets, placeNew, checkPlacement, DEFAULT_SIZE } from "../../src/DashboardBuilder/Features/Board/board-model.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

const nw = (x, y, o = {}) => ({ kind: "nav", label: "Go", tip: "", target: null, x, y, w: 4, h: 2, ...o });
const clean = (raw, o = {}) => { const issues = []; return { out: cleanWidgets(raw, { worksheetCount: 2, dashboardCount: 2, where: 'Dashboard "D"', ...o }, issues), issues }; };

test("nav limits and default size", () => {
  assert.equal(LIMITS.navLabel, 40);
  assert.equal(LIMITS.navTip, 200);
  assert.deepEqual(DEFAULT_SIZE.nav, { w: 4, h: 2 });
});

test("a nav button may be one row tall and is placed like any widget", () => {
  assert.equal(checkPlacement([], { kind: "nav", x: 0, y: 0, w: 2, h: 1 }).ok, true);
  assert.equal(placeNew([], "nav").ok, true);
});

test("validateNavEdit: label required and trimmed, tip optional, target must be offered", () => {
  const ok = validateNavEdit({ label: "  Overview ", tip: " Back ", target: "db#1" }, ["db#1", "ws#2"]);
  assert.deepEqual(ok, { ok: true, value: { label: "Overview", tip: "Back", target: "db#1" } });
  assert.deepEqual(validateNavEdit({ label: "A", tip: "", target: "" }, []).value.target, null);
  assert.match(validateNavEdit({ label: " ", tip: "", target: "" }, []).errors.label, /required/);
  assert.match(validateNavEdit({ label: "x".repeat(41), tip: "", target: "" }, []).errors.label, /at most 40/);
  assert.match(validateNavEdit({ label: "A", tip: "x".repeat(201), target: "" }, []).errors.tip, /at most 200/);
  assert.match(validateNavEdit({ label: "A", tip: "", target: "ws#9" }, ["ws#1"]).errors.target, /tab/);
});

test("navTargets lists every tab but the dashboard itself; navChanged compares the three fields", () => {
  const tabs = [{ id: "ws#1", kind: "worksheet", name: "S" }, { id: "db#1", kind: "dashboard", name: "D" }, { id: "db#2", kind: "dashboard", name: "E" }];
  assert.deepEqual(navTargets(tabs, "db#1").map((t) => t.id), ["ws#1", "db#2"]);
  assert.equal(navChanged(nw(0, 0), { label: "Go", tip: "", target: null }), false);
  assert.equal(navChanged(nw(0, 0), { label: "Go", tip: "t", target: null }), true);
});

test("clearNavTarget unlinks buttons that pointed at a closed tab and keeps the same array when none did", () => {
  const ws = [{ id: "w1", ...nw(0, 0, { target: "ws#1" }) }, { id: "w2", ...nw(4, 0, { target: "db#2" }) }];
  const next = clearNavTarget(ws, "ws#1");
  assert.equal(next[0].target, null);
  assert.equal(next[1], ws[1]);
  assert.equal(clearNavTarget(ws, "ws#9"), ws);
});

test("cleanWidgets keeps a valid nav widget with an indexed target", () => {
  const w = nw(0, 0, { label: "Next", tip: "Open it", target: { kind: "dashboard", index: 1 } });
  const { out, issues } = clean([w]);
  assert.deepEqual(out, [w]);
  assert.deepEqual(issues, []);
});

test("cleanWidgets: a dangling or malformed target is cleared and reported; label and tip are cut", () => {
  for (const target of [{ kind: "worksheet", index: 5 }, { kind: "dashboard", index: -1 }, { kind: "x", index: 0 }, "db#1", 3]) {
    const { out, issues } = clean([nw(0, 0, { target })]);
    assert.equal(out[0].target, null);
    assert.match(issues[0], /button's tab is missing/);
  }
  const r = clean([nw(0, 0, { label: "l".repeat(60), tip: "t".repeat(300) })]);
  assert.equal(r.out[0].label.length, 40);
  assert.equal(r.out[0].tip.length, 200);
  assert.equal(r.issues.length, 2);
  const e = clean([nw(0, 0, { label: "  " })]);
  assert.equal(e.out[0].label, "Go to");
  assert.match(e.issues[0], /label/);
});

test("savedWidgets writes a nav target by tab index and kind", () => {
  const ws = [{ id: "a", ...nw(0, 0, { target: "ws#4" }) }, { id: "b", ...nw(4, 0, { target: "db#7" }) }, { id: "c", ...nw(8, 0, { target: "ws#gone" }) }];
  const out = savedWidgets(ws, new Map([["ws#4", 2]]), new Map([["db#7", 1]]));
  assert.deepEqual(out.map((w) => w.target), [{ kind: "worksheet", index: 2 }, { kind: "dashboard", index: 1 }, null]);
  assert.deepEqual(Object.keys(out[0]).sort(), ["h", "kind", "label", "target", "tip", "w", "x", "y"]);
});

test("cleanWidgets: a button that points at its own dashboard is dangling", () => {
  const issues = [];
  const out = cleanWidgets([nw(0, 0, { target: { kind: "dashboard", index: 1 } }), nw(4, 0, { target: { kind: "dashboard", index: 0 } })], { worksheetCount: 0, dashboardCount: 2, ownDashboard: 1, where: "D" }, issues);
  assert.equal(out[0].target, null);
  assert.deepEqual(out[1].target, { kind: "dashboard", index: 0 });
  assert.equal(issues.length, 1);
});
