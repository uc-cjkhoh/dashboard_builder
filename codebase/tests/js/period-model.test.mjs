import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRange, compareRange, rangeFilter, rangeLabel, changeOf, toneOf, pctText, alignCompare, targetProgress, newPeriod }
  from "../../src/DashboardBuilder/Features/Dashboard/period-model.js";

const today = new Date(2026, 9, 13); // 13 Oct 2026, local
const P = (preset, extra = {}) => ({ ...newPeriod({ db: "d", table: "t", column: "c", category: "temporal" }), preset, ...extra });

test("rolling presets end today and count today in", () => {
  assert.deepEqual(resolveRange(P("last7"), today), { from: "2026-10-07", to: "2026-10-13" });
  assert.deepEqual(resolveRange(P("last30"), today), { from: "2026-09-14", to: "2026-10-13" });
});
test("calendar presets", () => {
  assert.deepEqual(resolveRange(P("thisMonth"), today), { from: "2026-10-01", to: "2026-10-13" });
  assert.deepEqual(resolveRange(P("lastMonth"), today), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(resolveRange(P("thisQuarter"), today), { from: "2026-10-01", to: "2026-10-13" });
  assert.deepEqual(resolveRange(P("lastQuarter"), today), { from: "2026-07-01", to: "2026-09-30" });
  assert.deepEqual(resolveRange(P("lastYear"), today), { from: "2025-01-01", to: "2025-12-31" });
  assert.deepEqual(resolveRange(P("lastMonth"), new Date(2026, 0, 5)), { from: "2025-12-01", to: "2025-12-31" });
});
test("a custom range needs both days in order", () => {
  assert.deepEqual(resolveRange(P("custom", { from: "2026-01-01", to: "2026-01-31" })), { from: "2026-01-01", to: "2026-01-31" });
  assert.equal(resolveRange(P("custom", { from: "2026-02-01", to: "2026-01-31" })), null);
  assert.equal(resolveRange(P("custom", { from: "2026-02-01", to: null })), null);
  assert.equal(resolveRange(P("nope")), null);
});
test("previous period is the same length, immediately before", () => {
  const r = { from: "2026-09-01", to: "2026-09-30" };
  assert.deepEqual(compareRange(P("custom", { compare: "previous" }), r), { from: "2026-08-02", to: "2026-08-31" });
});
test("same period last year clamps 29 February", () => {
  assert.deepEqual(compareRange(P("custom", { compare: "lastYear" }), { from: "2024-02-01", to: "2024-02-29" }), { from: "2023-02-01", to: "2023-02-28" });
});
test("no comparison, or an incomplete custom one, is null", () => {
  const r = { from: "2026-09-01", to: "2026-09-30" };
  assert.equal(compareRange(P("x", { compare: "none" }), r), null);
  assert.equal(compareRange(P("x", { compare: "custom", compareFrom: "2026-01-01" }), r), null);
  assert.deepEqual(compareRange(P("x", { compare: "custom", compareFrom: "2025-09-01", compareTo: "2025-09-30" }), r), { from: "2025-09-01", to: "2025-09-30" });
});
test("the range filter is one bound between: days for Date, whole days for DateTime", () => {
  const r = { from: "2026-09-01", to: "2026-09-30" };
  assert.deepEqual(rangeFilter(P("x"), r, true).values, ["2026-09-01", "2026-09-30"]);
  assert.deepEqual(rangeFilter(P("x"), r, false).values, ["2026-09-01 00:00:00", "2026-09-30 23:59:59"]);
  assert.equal(rangeFilter(P("x"), r, true).op, "between");
});
test("range labels", () => {
  assert.equal(rangeLabel({ from: "2026-09-01", to: "2026-09-30" }), "1 Sept – 30 Sept 2026".replace(/Sept/g, new Date(Date.UTC(2026, 8, 1)).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })));
  assert.match(rangeLabel({ from: "2025-12-01", to: "2026-01-31" }), /2025 – .*2026/);
});
test("change, tone and percentage text", () => {
  assert.deepEqual(changeOf(110, 100), { delta: 10, pct: 10, dir: "up" });
  assert.equal(changeOf(90, 100).dir, "down");
  assert.equal(changeOf(5, 0).pct, null);
  assert.equal(changeOf(null, 3).dir, "flat");
  assert.equal(toneOf("up"), "good");
  assert.equal(toneOf("up", true), "bad");
  assert.equal(toneOf("down", true), "good");
  assert.equal(toneOf("flat"), "neutral");
  assert.equal(pctText(12.44), "+12.4%");
  assert.equal(pctText(-3), "−3.0%");
  assert.equal(pctText(null), "n/a");
});
test("comparison rows line up by position on the range's own date axis, else by key", () => {
  const cur = [{ keys: ["2026-09-01"] }, { keys: ["2026-09-02"] }];
  const prev = [{ keys: ["2026-08-02"], values: [1] }];
  assert.deepEqual(alignCompare(cur, prev, true), [prev[0], null]);
  const byKey = alignCompare([{ keys: ["UK"] }, { keys: ["FR"] }], [{ keys: ["FR"], values: [2] }], false);
  assert.deepEqual(byKey.map((r) => r?.values[0] ?? null), [null, 2]);
});
test("target progress", () => {
  assert.deepEqual(targetProgress(80, 100), { pct: 80, met: false });
  assert.equal(targetProgress(120, 100).met, true);
  assert.equal(targetProgress(5, null), null);
  assert.equal(targetProgress(5, 0), null);
});

import { withLatest, anchorLabel } from "../../src/DashboardBuilder/Features/Dashboard/period-model.js";
test("a new period counts from the data's latest day once known", () => {
  const p = newPeriod({ db: "d", table: "t", column: "c", category: "temporal" });
  assert.equal(p.anchor, "latest");
  assert.equal(p.latest, null);
  const today = new Date(2026, 10, 10);
  assert.deepEqual(resolveRange(p, today), { from: "2026-10-12", to: "2026-11-10" }); // latest unknown: today
  const q = withLatest(p, "2024-03-31");
  assert.deepEqual(resolveRange(q, today), { from: "2024-03-02", to: "2024-03-31" });
  assert.deepEqual(resolveRange({ ...q, preset: "thisMonth" }, today), { from: "2024-03-01", to: "2024-03-31" });
  assert.deepEqual(resolveRange({ ...q, preset: "lastMonth" }, today), { from: "2024-02-01", to: "2024-02-29" });
  assert.deepEqual(resolveRange({ ...q, anchor: "today" }, today), { from: "2026-10-12", to: "2026-11-10" });
  assert.deepEqual(resolveRange({ ...q, preset: "custom", from: "2020-01-01", to: "2020-01-31" }, today), { from: "2020-01-01", to: "2020-01-31" });
});
test("withLatest ignores a bad day; anchorLabel says what the range counts from", () => {
  const p = newPeriod({ db: "d", table: "t", column: "c", category: "temporal" });
  assert.equal(withLatest(p, "junk").latest, null);
  assert.equal(withLatest(p, null).latest, null);
  assert.equal(anchorLabel(withLatest(p, "2024-03-31")), "Counting from the latest data, 31 Mar 2024");
  assert.equal(anchorLabel(p), "Counting from today");
  assert.equal(anchorLabel({ ...withLatest(p, "2024-03-31"), anchor: "today" }), "Counting from today");
  assert.equal(anchorLabel({ ...withLatest(p, "2024-03-31"), preset: "custom" }), null);
});
import { sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
test("a saved period keeps its anchor and latest day; an older one counts from today", () => {
  const base = { db: "d", table: "t", column: "c", category: "temporal", preset: "last30", from: null, to: null, compare: "none", compareFrom: null, compareTo: null };
  const keep = sanitizeSheet({ period: { ...base, anchor: "latest", latest: "2024-03-31" } }, "w", []).period;
  assert.deepEqual([keep.anchor, keep.latest], ["latest", "2024-03-31"]);
  const old = sanitizeSheet({ period: base }, "w", []).period;
  assert.deepEqual([old.anchor, old.latest], [undefined, undefined]);
  assert.deepEqual(resolveRange(old, new Date(2026, 10, 10)), { from: "2026-10-12", to: "2026-11-10" });
  const bad = sanitizeSheet({ period: { ...base, latest: "nope" } }, "w", []);
  assert.equal(bad.period, null);
});
