import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDateLabel, shortDateLabels, axisLabelPlan } from "../../src/DashboardBuilder/Features/Dashboard/date-axis.js";

const px7 = (s) => s.length * 7; // 7px per glyph
const hourly = (n, start = Date.UTC(2026, 9, 1)) => Array.from({ length: n }, (_, i) => new Date(start + i * 3600e3).toISOString().slice(0, 19).replace("T", " "));
const daily = (n, time = "00:00:00") => Array.from({ length: n }, (_, i) => `${new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10)} ${time}`);

test("parses date and datetime strings, rejects the rest", () => {
  assert.equal(parseDateLabel("2026-10-01 05:30:15").ms, Date.UTC(2026, 9, 1, 5, 30, 15));
  assert.equal(parseDateLabel("2026-10-01T05:30").hasTime, true);
  assert.equal(parseDateLabel("2026-10-01").hasTime, false);
  for (const s of ["Oct 1, 2026", "—", "", "2026-10", "a / 2026-10-01", null]) assert.equal(parseDateLabel(s), null);
});

test("short labels: midnight-only datetimes read as dates", () => {
  assert.deepEqual(shortDateLabels(daily(3)).texts, ["2026-10-01", "2026-10-02", "2026-10-03"]);
});
test("short labels: hourly data within one year drops the year and the zero seconds", () => {
  assert.deepEqual(shortDateLabels(hourly(3, Date.UTC(2026, 9, 1, 23))).texts, ["10-01 23:00", "10-02 00:00", "10-02 01:00"]);
});
test("short labels: one day of hours shows time only", () => {
  assert.deepEqual(shortDateLabels(hourly(24)).texts.slice(0, 2), ["00:00", "01:00"]);
});
test("short labels: seconds are kept only when they vary", () => {
  const l = ["2026-10-01 00:00:05", "2026-10-01 00:00:10"];
  assert.deepEqual(shortDateLabels(l).texts, ["00:00:05", "00:00:10"]);
});
test("short labels: several years keep the year", () => {
  assert.deepEqual(shortDateLabels(["2025-12-31 10:00:00", "2026-01-01 11:00:00"]).texts, ["2025-12-31 10:00", "2026-01-01 11:00"]);
});
test("short labels: anything unparsable is left as is", () => {
  const l = ["Oct 1", "Oct 2"];
  assert.deepEqual(shortDateLabels(l).texts, l);
  assert.deepEqual(shortDateLabels(["2026-10-01 00:00:00", "Other"]).texts, ["2026-10-01 00:00:00", "Other"]);
});

const gapOk = (idx, n, length, w, gap, ends = 0) => { // consecutive shown labels need w+gap px between tick centres (more at the ends, whose outer label hangs inward)
  const slot = (length * (n - 1) / n) / (n - 1);
  for (let i = 1; i < idx.length; i++) if ((idx[i] - idx[i - 1]) * slot < w + gap + (i === 1 || i === idx.length - 1 ? ends : 0) - 1e-6) return false;
  return true;
};

test("plan keeps first and last and never lets labels touch, over many widths and counts", () => {
  for (const n of [2, 3, 7, 24, 60, 200, 999]) for (const length of [120, 240, 420, 800, 1600]) {
    for (const side of ["bottom", "left"]) {
      const p = axisLabelPlan({ labels: hourly(n), length, side, measure: px7 });
      assert.equal(p.indices[0], 0, `${n}/${length}/${side} first`);
      assert.equal(p.indices.at(-1), n - 1, `${n}/${length}/${side} last`);
      assert.ok(new Set(p.indices).size === p.indices.length, "unique");
      const widest = Math.max(...p.indices.map((i) => px7(p.texts[i])));
      if (side === "left") assert.ok(gapOk(p.indices, n, length, 14, 4) || p.indices.length === 2, `${n}/${length} left spacing`);
      else if (p.rotate === 0 && p.indices.length > 2) assert.ok(gapOk(p.indices, n, length, widest, 8, widest / 2), `${n}/${length} bottom spacing`);
    }
  }
});
test("a roomy axis keeps every label", () => {
  const p = axisLabelPlan({ labels: daily(5), length: 800, side: "bottom", measure: px7 });
  assert.deepEqual(p.indices, [0, 1, 2, 3, 4]);
  assert.equal(p.rotate, 0);
});
test("a tight bottom axis thins out; thinner still turns the labels upright", () => {
  const wide = axisLabelPlan({ labels: hourly(60), length: 600, side: "bottom", measure: px7 });
  assert.ok(wide.indices.length > 3 && wide.indices.length < 60);
  assert.equal(wide.rotate, 0);
  const narrow = axisLabelPlan({ labels: hourly(60), length: 120, side: "bottom", measure: px7 });
  assert.equal(narrow.rotate, 90);
  assert.ok(narrow.indices.length >= 3);
});
test("labels days apart lose their time part", () => {
  const p = axisLabelPlan({ labels: hourly(24 * 40), length: 500, side: "bottom", measure: px7 });
  assert.ok(p.indices.length < 24 * 40);
  for (const i of p.indices) assert.match(p.texts[i], /^\d{4}-\d{2}-\d{2}$/, p.texts[i]);
});
test("labels hours apart keep it", () => {
  const p = axisLabelPlan({ labels: hourly(40), length: 700, side: "bottom", measure: px7 });
  assert.match(p.texts[p.indices[1]], /\d{2}:\d{2}$/);
});
test("a single label, and no labels, are fine", () => {
  assert.deepEqual(axisLabelPlan({ labels: ["2026-10-01"], length: 100, side: "bottom", measure: px7 }).indices, [0]);
  assert.deepEqual(axisLabelPlan({ labels: [], length: 100, side: "left", measure: px7 }).indices, []);
});
test("non-date labels thin the same way and keep their text", () => {
  const labels = Array.from({ length: 100 }, (_, i) => `Week ${i + 1}`);
  const p = axisLabelPlan({ labels, length: 400, side: "bottom", measure: px7 });
  assert.equal(p.texts[0], "Week 1");
  assert.ok(p.indices.length < 100 && p.indices.at(-1) === 99);
});
test("left axes get a row per label height", () => {
  const p = axisLabelPlan({ labels: hourly(60), length: 300, side: "left", measure: px7 });
  assert.ok(p.indices.length <= 300 / 18 + 1 && p.indices.length > 3);
  assert.equal(p.rotate, 0);
});
