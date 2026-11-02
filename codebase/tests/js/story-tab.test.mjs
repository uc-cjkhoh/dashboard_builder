import { test } from "node:test";
import assert from "node:assert/strict";
import * as st from "../../src/DashboardBuilder/Features/Core/store.js";
import { serializeWorkbook, parseWorkbook, WORKBOOK_FORMAT } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { navTargets } from "../../src/DashboardBuilder/Features/Board/nav-model.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

const reset = () => { for (const t of [...st.tabs]) st.closeTab(t.id); st.showModel(); };
const state = (extra = {}) => ({ entities: new Map(), relationships: new Map(), tabs: st.tabs, active: st.currentView(), theme: null, ...extra });
const v2 = (patch) => JSON.stringify({ format: WORKBOOK_FORMAT, version: 2, entities: [], relationships: [], worksheets: [], dashboards: [], ...patch });

test("createStory: id, kind, default name, empty steps, activation", () => {
  reset();
  const s = st.createStory();
  assert.match(s.id, /^st#/);
  assert.equal(s.kind, "story");
  assert.equal(s.name, "Story 1");
  assert.deepEqual(s.steps, []);
  assert.equal(st.isStoryActive(), true);
  assert.equal(st.activeStory().id, s.id);
  assert.equal(st.activeWorksheet(), null);
  assert.equal(st.activeDashboard(), null);
  assert.equal(st.createStory().name, "Story 2");
  assert.deepEqual(st.stories().map((t) => t.name), ["Story 1", "Story 2"]);
  reset();
});

test("setSteps replaces the steps and announces story:changed", () => {
  reset();
  const w = st.createWorksheet(), s = st.createStory();
  const log = [];
  st.bus.addEventListener("story:changed", (e) => log.push(e.detail.id));
  st.setSteps(s.id, [{ caption: "a", target: w.id }]);
  assert.equal(st.tabById(s.id).steps.length, 1);
  assert.deepEqual(log, [s.id]);
  reset();
});

test("closing a worksheet or dashboard removes the steps that showed it (story notified); closing the story touches nothing else", () => {
  reset();
  const w1 = st.createWorksheet(), d1 = st.createDashboard(), s = st.createStory();
  st.setSteps(s.id, [{ caption: "a", target: w1.id }, { caption: "b", target: d1.id }, { caption: "c", target: w1.id }]);
  const log = [];
  st.bus.addEventListener("story:changed", (e) => log.push(e.detail.id));
  st.closeTab(w1.id);
  assert.deepEqual(st.tabById(s.id).steps.map((x) => x.caption), ["b"]);
  assert.deepEqual(log, [s.id]);
  st.closeTab(d1.id);
  assert.deepEqual(st.tabById(s.id).steps, []);
  st.closeTab(s.id);
  assert.equal(st.tabById(s.id), null);
  reset();
});

test("the tab limit covers stories", () => {
  reset();
  for (let i = 0; i < LIMITS.tabs; i++) st.createStory();
  assert.equal(st.createStory(), null);
  reset();
});

test("a navigation button never offers a story tab", () => {
  const tabs = [{ id: "ws#1", kind: "worksheet", name: "W" }, { id: "st#1", kind: "story", name: "S" }];
  assert.deepEqual(navTargets(tabs, "db#1").map((t) => t.id), ["ws#1"]);
});

test("a story saves and reopens: steps point at tabs by index, order and active view kept", () => {
  reset();
  const w = st.createWorksheet("Sales"), d = st.createDashboard("Board"), s = st.createStory("Tour");
  st.setSteps(s.id, [{ caption: "Start here", target: d.id }, { caption: "Then this", target: w.id }]);
  const saved = JSON.parse(JSON.stringify(serializeWorkbook(state())));
  assert.deepEqual(saved.stories, [{ name: "Tour", steps: [{ caption: "Start here", target: { kind: "dashboard", index: 0 } }, { caption: "Then this", target: { kind: "worksheet", index: 0 } }] }]);
  assert.deepEqual(saved.tabs, [{ kind: "worksheet", index: 0 }, { kind: "dashboard", index: 0 }, { kind: "story", index: 0 }]);
  assert.deepEqual(saved.active, { kind: "story", index: 0 });
  const wb = parseWorkbook(JSON.stringify(saved));
  assert.deepEqual(wb.issues, []);
  assert.deepEqual(wb.stories, [{ name: "Tour", steps: saved.stories[0].steps }]);
  assert.deepEqual(wb.tabs, saved.tabs);
  assert.deepEqual(wb.active, { kind: "story", index: 0 });
  reset();
});

test("a workbook without stories (every older file) opens with none and no issue; nothing extra is saved", () => {
  reset();
  st.createWorksheet();
  const saved = JSON.parse(JSON.stringify(serializeWorkbook(state())));
  assert.equal("stories" in saved, false);
  const wb = parseWorkbook(v2({ worksheets: [{ name: "W", sheet: {} }] }));
  assert.deepEqual(wb.stories, []);
  assert.deepEqual(wb.issues, []);
  reset();
});

test("import: a story's bad steps are reported and rejected, not clamped; names are validated", () => {
  const wb = parseWorkbook(v2({
    worksheets: [{ name: "W", sheet: {} }],
    stories: [{ name: "S", steps: [
      { caption: "fine", target: { kind: "worksheet", index: 0 } },
      { caption: "x".repeat(LIMITS.stepCaption + 1), target: { kind: "worksheet", index: 0 } },
      { caption: "dangling", target: { kind: "dashboard", index: 3 } },
    ] }],
  }));
  assert.deepEqual(wb.stories[0].steps, [{ caption: "fine", target: { kind: "worksheet", index: 0 } }]);
  assert.equal(wb.issues.length, 2);
  assert.ok(wb.issues.some((i) => i.includes("300")));
});

test("import: more than the step limit keeps the first 20 and says so; stories count toward the tab limit; a non-list is reported", () => {
  const steps = Array.from({ length: 30 }, (_, i) => ({ caption: `s${i}`, target: { kind: "worksheet", index: 0 } }));
  const wb = parseWorkbook(v2({ worksheets: [{ name: "W", sheet: {} }], stories: [{ name: "S", steps }] }));
  assert.equal(wb.stories[0].steps.length, 20);
  assert.ok(wb.issues.some((i) => /first 20 steps/.test(i)));
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `S${i}`, steps: [] }));
  const wb2 = parseWorkbook(v2({ stories: many }));
  assert.equal(wb2.tabs.length, LIMITS.tabs);
  assert.equal(wb2.stories.length, LIMITS.tabs);
  const wb3 = parseWorkbook(v2({ stories: "nope" }));
  assert.deepEqual(wb3.stories, []);
  assert.ok(wb3.issues.length >= 1);
});

test("import: a step whose worksheet was cut by the tab cap is removed and reported", () => {
  const worksheets = Array.from({ length: LIMITS.tabs }, (_, i) => ({ name: `W${i}`, sheet: {} }));
  const wb = parseWorkbook(v2({ worksheets, stories: [{ name: "S", steps: [{ caption: "c", target: { kind: "worksheet", index: 0 } }] }] }));
  // 50 worksheets fill the cap; the story is past it and dropped, so no story survives
  assert.equal(wb.stories.length, 0);
  assert.ok(wb.issues.some((i) => /first 50 tabs/.test(i)));
});
