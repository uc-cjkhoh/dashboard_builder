import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateCaption, addStep, removeStep, moveStep, setCaption, goTo, dropTarget, offeredTargets, stepName,
  savedSteps, cleanSteps, targetKind,
} from "../../src/DashboardBuilder/Features/Story/story-model.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

const S = (caption, target) => ({ caption, target });

test("limits are defined and sane", () => {
  assert.equal(LIMITS.storySteps, 20);
  assert.equal(LIMITS.stepCaption, 300);
});

test("validateCaption trims, allows empty, and rejects (never cuts) an over-long caption", () => {
  assert.deepEqual(validateCaption("  Q1 was strong "), { ok: true, value: "Q1 was strong" });
  assert.deepEqual(validateCaption(""), { ok: true, value: "" });
  const long = validateCaption("x".repeat(LIMITS.stepCaption + 1));
  assert.equal(long.ok, false);
  assert.match(long.error, /300/);
  assert.equal(validateCaption("x".repeat(LIMITS.stepCaption)).ok, true);
  assert.equal(validateCaption(42).ok, false);
});

test("addStep appends, and refuses past the step limit", () => {
  const r = addStep([], "ws#1", "Hello");
  assert.deepEqual(r, { ok: true, steps: [S("Hello", "ws#1")], index: 0 });
  const full = Array.from({ length: LIMITS.storySteps }, (_, i) => S(`s${i}`, "ws#1"));
  const over = addStep(full, "ws#1", "one more");
  assert.equal(over.ok, false);
  assert.match(over.error, /20 steps/);
  assert.equal(addStep([], "ws#1", "x".repeat(301)).ok, false);
  assert.equal(addStep([], "", "x").ok, false); // a step needs a tab
});

test("removeStep drops one and leaves the input untouched", () => {
  const a = [S("a", "x"), S("b", "x"), S("c", "x")];
  assert.deepEqual(removeStep(a, 1).map((s) => s.caption), ["a", "c"]);
  assert.equal(a.length, 3);
  assert.equal(removeStep(a, 9), a); // out of range: unchanged
});

test("moveStep swaps with the neighbour; at an end it changes nothing", () => {
  const a = [S("a", "x"), S("b", "x"), S("c", "x")];
  assert.deepEqual(moveStep(a, 1, -1), { steps: [a[1], a[0], a[2]], index: 0 });
  assert.deepEqual(moveStep(a, 1, 1), { steps: [a[0], a[2], a[1]], index: 2 });
  assert.deepEqual(moveStep(a, 0, -1), { steps: a, index: 0 });
  assert.deepEqual(moveStep(a, 2, 1), { steps: a, index: 2 });
});

test("setCaption validates and replaces only that step", () => {
  const a = [S("a", "x"), S("b", "y")];
  const r = setCaption(a, 1, " new ");
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps, [a[0], S("new", "y")]);
  assert.equal(setCaption(a, 1, "x".repeat(400)).ok, false);
  assert.equal(setCaption(a, 5, "ok").ok, false);
});

test("goTo moves one step, jumps, and never wraps or clamps past the ends", () => {
  assert.equal(goTo(1, 3, "next"), 2);
  assert.equal(goTo(2, 3, "next"), 2);
  assert.equal(goTo(0, 3, "prev"), 0);
  assert.equal(goTo(2, 3, "prev"), 1);
  assert.equal(goTo(1, 3, "first"), 0);
  assert.equal(goTo(1, 3, "last"), 2);
  assert.equal(goTo(0, 0, "next"), 0);
  assert.equal(goTo(1, 3, 2), 2);
  assert.equal(goTo(1, 3, 7), 1); // an index outside the story is refused, not clamped
});

test("dropTarget removes the steps that showed a closed tab (same array when none)", () => {
  const a = [S("a", "ws#1"), S("b", "ws#2"), S("c", "ws#1")];
  assert.deepEqual(dropTarget(a, "ws#1").map((s) => s.caption), ["b"]);
  assert.equal(dropTarget(a, "ws#9"), a);
});

test("offeredTargets lists worksheets and dashboards only", () => {
  const tabs = [{ id: "ws#1", kind: "worksheet", name: "W" }, { id: "db#1", kind: "dashboard", name: "D" }, { id: "st#1", kind: "story", name: "S" }];
  assert.deepEqual(offeredTargets(tabs), [{ id: "ws#1", name: "W", kind: "worksheet" }, { id: "db#1", name: "D", kind: "dashboard" }]);
  assert.equal(targetKind(tabs, "db#1"), "dashboard");
  assert.equal(targetKind(tabs, "zzz"), null);
  assert.equal(stepName(tabs, S("", "ws#1")), "W");
  assert.equal(stepName(tabs, S("", "zzz")), "Closed tab");
});

test("savedSteps writes targets as { kind, index } and drops a step whose tab is gone", () => {
  const ws = new Map([["ws#1", 0]]), db = new Map([["db#1", 2]]);
  assert.deepEqual(savedSteps([S("a", "ws#1"), S("b", "db#1"), S("c", "gone")], ws, db),
    [{ caption: "a", target: { kind: "worksheet", index: 0 } }, { caption: "b", target: { kind: "dashboard", index: 2 } }]);
});

test("cleanSteps accepts good steps and reports (never cuts) bad ones", () => {
  const issues = [];
  const ctx = { worksheetCount: 2, dashboardCount: 1, where: 'Story "S"' };
  const out = cleanSteps([
    { caption: "ok", target: { kind: "worksheet", index: 1 } },
    { caption: "ok2", target: { kind: "dashboard", index: 0 } },
    { caption: "x".repeat(301), target: { kind: "worksheet", index: 0 } },
    { caption: "gone", target: { kind: "worksheet", index: 5 } },
    { caption: "gone2", target: { kind: "dashboard", index: undefined } },
    { caption: 5, target: { kind: "worksheet", index: 0 } },
    { caption: "story", target: { kind: "story", index: 0 } },
    "junk", null,
  ], ctx, issues);
  assert.deepEqual(out, [{ caption: "ok", target: { kind: "worksheet", index: 1 } }, { caption: "ok2", target: { kind: "dashboard", index: 0 } }]);
  assert.equal(issues.length, 7);
  assert.ok(issues.every((i) => i.startsWith('Story "S"')));
  assert.ok(issues.some((i) => /300/.test(i)));
});

test("cleanSteps: absent is empty; a non-list is reported; past the limit the rest are dropped and reported", () => {
  const ctx = { worksheetCount: 1, dashboardCount: 0, where: "S" };
  let issues = [];
  assert.deepEqual(cleanSteps(undefined, ctx, issues), []);
  assert.deepEqual(issues, []);
  assert.deepEqual(cleanSteps({}, ctx, issues), []);
  assert.equal(issues.length, 1);
  issues = [];
  const many = Array.from({ length: 25 }, () => ({ caption: "c", target: { kind: "worksheet", index: 0 } }));
  assert.equal(cleanSteps(many, ctx, issues).length, 20);
  assert.match(issues[0], /first 20 steps/);
});
