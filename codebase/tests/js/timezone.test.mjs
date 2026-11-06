import { test } from "node:test";
import assert from "node:assert/strict";
import { appTimeZone, clockIn, dateIn, dateTimeIn, todayIn, offsetLabel, FALLBACK_TZ } from "../../src/DashboardBuilder/Features/Core/timezone.js";
import { resolveRange } from "../../src/DashboardBuilder/Features/Dashboard/period-model.js";

const KL = "Asia/Kuala_Lumpur";
const t = Date.UTC(2026, 10, 3, 17, 30, 5); // 17:30:05 UTC on 3 Nov = 01:30:05 on 4 Nov in Kuala Lumpur

test("the page-less default zone is Malaysia time (UTC+8)", () => {
  assert.equal(FALLBACK_TZ, KL);
  assert.equal(appTimeZone(), KL); // no document in node: the fallback
});
test("clock and date are read in the zone, across midnight", () => {
  assert.equal(clockIn(t, KL), "01:30:05");
  assert.equal(dateIn(t, KL), "2026-11-04");
  assert.equal(dateTimeIn(t, KL), "2026-11-04 01:30:05");
  assert.equal(clockIn(t, "UTC"), "17:30:05");
  assert.equal(dateIn(t, "UTC"), "2026-11-03");
  assert.equal(clockIn(t), "01:30:05"); // default = the app zone
});
test("todayIn is the zone's calendar date", () => {
  const d = todayIn(KL, t);
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [2026, 10, 4]);
  const u = todayIn("UTC", t);
  assert.deepEqual([u.getFullYear(), u.getMonth(), u.getDate()], [2026, 10, 3]);
});
test("offsetLabel names the UTC offset", () => {
  assert.equal(offsetLabel(KL, t), "UTC+8");
  assert.equal(offsetLabel("UTC", t), "UTC");
  assert.equal(offsetLabel("Asia/Kolkata", t), "UTC+5:30");
  assert.equal(offsetLabel("America/Sao_Paulo", t), "UTC-3");
});
test("the date range presets start from the zone's today", () => {
  const today = todayIn(KL, t); // 4 Nov in Kuala Lumpur, still 3 Nov in UTC
  assert.deepEqual(resolveRange({ preset: "last7" }, today), { from: "2026-10-29", to: "2026-11-04" });
});
