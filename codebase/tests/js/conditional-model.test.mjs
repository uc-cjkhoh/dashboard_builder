import { test } from "node:test";
import assert from "node:assert/strict";
import { measureKey, extentOf, midpointOf, mixHex, scaleColors, barGeometry, matchRule, isActive, emptyRule }
  from "../../src/DashboardBuilder/Features/Dashboard/conditional-model.js";
import { contrastRatio } from "../../src/DashboardBuilder/Features/Dashboard/contrast.js";

const palette = { surface: "#ffffff", high: "#2a78d6", low: "#eb6834", inks: ["#1c1719", "#ffffff", "#000000", "#ffffff"] };
const dark = { surface: "#1c181b", high: "#4d95ea", low: "#f2834f", inks: ["#f3eff0", "#1c181b", "#000000", "#ffffff"] };

test("a measure's key is its column and aggregation; the implicit count has its own", () => {
  assert.equal(measureKey({ field: { db: "d", table: "t", column: "amount" }, agg: "avg" }), "d.t.amount:avg");
  assert.equal(measureKey(undefined), "count");
});
test("extent ignores blanks and text", () => {
  assert.deepEqual(extentOf([3, null, "x", -2, "", 7]), { min: -2, max: 7 });
  assert.equal(extentOf([null, "x"]), null);
});
test("diverging midpoint: the set one, else 0 when values straddle it, else the middle", () => {
  assert.equal(midpointOf({ min: -5, max: 10 }, null), 0);
  assert.equal(midpointOf({ min: 10, max: 30 }, null), 20);
  assert.equal(midpointOf({ min: 10, max: 30 }, 12), 12);
});
test("mixing colours", () => {
  assert.equal(mixHex("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mixHex("#fff", "#000", 0), "#ffffff");
});
test("a sequential scale runs from the surface toward the high colour", () => {
  const ext = { min: 0, max: 100 };
  assert.equal(scaleColors(0, ext, { scale: "sequential" }, palette).bg, "#ffffff");
  assert.notEqual(scaleColors(100, ext, { scale: "sequential" }, palette).bg, "#ffffff");
  assert.equal(scaleColors(null, ext, { scale: "sequential" }, palette), null);
});
test("a diverging scale tints toward low below the midpoint and high above", () => {
  const ext = { min: -10, max: 10 };
  const below = scaleColors(-10, ext, { scale: "diverging", mid: null }, palette).bg;
  const above = scaleColors(10, ext, { scale: "diverging", mid: null }, palette).bg;
  assert.equal(scaleColors(0, ext, { scale: "diverging", mid: null }, palette).bg, "#ffffff");
  assert.equal(below, mixHex("#ffffff", palette.low, 0.85));
  assert.equal(above, mixHex("#ffffff", palette.high, 0.85));
});
test("every scale tint keeps its text at 4.5:1 or better, light and dark", () => {
  for (const p of [palette, dark]) for (const scale of ["sequential", "diverging"]) for (let v = -10; v <= 10; v++) {
    const c = scaleColors(v, { min: -10, max: 10 }, { scale, mid: null }, p);
    assert.ok(contrastRatio(c.ink, c.bg) >= 4.5, `${scale} ${v} ${c.bg}/${c.ink}`);
  }
});
test("data bars grow from zero; negatives extend left of it", () => {
  assert.deepEqual(barGeometry(50, { min: 0, max: 100 }), { left: 0, width: 50, neg: false });
  const neg = barGeometry(-5, { min: -10, max: 10 });
  assert.deepEqual(neg, { left: 25, width: 25, neg: true });
  assert.deepEqual(barGeometry(10, { min: -10, max: 10 }), { left: 50, width: 50, neg: false });
  assert.equal(barGeometry(null, { min: 0, max: 1 }), null);
});
test("the first matching rule wins; blanks never match", () => {
  const rules = [{ op: ">", value: 100, tone: "good" }, { op: "<", value: 0, tone: "bad" }, { op: ">=", value: 50, tone: "warn" }];
  assert.equal(matchRule(150, rules).tone, "good");
  assert.equal(matchRule(-1, rules).tone, "bad");
  assert.equal(matchRule(50, rules).tone, "warn");
  assert.equal(matchRule(20, rules), null);
  assert.equal(matchRule(null, [{ op: "<", value: 1, tone: "bad" }]), null);
  assert.equal(matchRule(0, [{ op: "=", value: 0, tone: "info" }]).tone, "info");
});
test("a setting is active with a scale, bars or any rule", () => {
  assert.equal(isActive(emptyRule()), false);
  assert.equal(isActive({ ...emptyRule(), mode: "bars" }), true);
  assert.equal(isActive({ ...emptyRule(), rules: [{ op: ">", value: 1, tone: "good" }] }), true);
});
