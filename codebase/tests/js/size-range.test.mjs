import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sizeScaleOf, sizeScaleIsDefault, cleanSizeScale, measureShares, measureShareFn, sizeLegendText, sizeVary, sizeEnds, sizeVaryError, sizeEndsError, sizeEndsEdit, setSizeVary, SIZE_VALUE_LIMIT,
} from "../../src/DashboardBuilder/Features/Dashboard/size-scale-model.js";

// Edit Sizes → Sizes vary (Automatic / By range / From zero) and a typed Start / End value: the pure maths (no DOM).
const D = sizeScaleOf({});
const sc = (o) => sizeScaleOf({ sizeScale: o });
const round = (a) => a.map((x) => (x == null ? x : Math.round(x * 1000) / 1000));

test("Automatic is today's per-chart default: nothing stored reads exactly as before, with no typed ends", () => {
  assert.deepEqual(D, { smallest: 0, largest: 100, fromZero: null, reversed: false, start: null, end: null });
  assert.equal(sizeVary(D), "automatic");
  assert.equal(sizeScaleIsDefault({}), true);
  assert.equal(sizeScaleIsDefault({ sizeScale: { start: 1 } }), false);
  assert.equal(sizeScaleIsDefault({ sizeScale: { vary: "zero" } }), false);
});
test("an old saved fromZero reads as the same mode; vary wins when both are stored", () => {
  assert.equal(sc({ fromZero: true }).fromZero, true);
  assert.equal(sizeVary(sc({ fromZero: true })), "zero");
  assert.equal(sizeVary(sc({ fromZero: false })), "range");
  assert.equal(sc({ vary: "zero" }).fromZero, true);
  assert.equal(sc({ vary: "range" }).fromZero, false);
  assert.equal(sc({ vary: "range", fromZero: true }).fromZero, false, "vary wins");
  assert.equal(sc({ vary: "nonsense", fromZero: true }).fromZero, true, "a bad vary falls back to the old key");
  assert.equal(sizeVary(sc({ vary: "automatic" })), "automatic");
});
test("a stored Start / End is read only when finite numbers within the limit and start is below end", () => {
  assert.deepEqual([sc({ start: 10, end: 50 }).start, sc({ start: 10, end: 50 }).end], [10, 50]);
  assert.deepEqual([sc({ start: -2.5 }).start, sc({ start: -2.5 }).end], [-2.5, null], "start only");
  assert.deepEqual([sc({ end: 7 }).start, sc({ end: 7 }).end], [null, 7], "end only");
  for (const bad of [NaN, Infinity, -Infinity, "5", true, SIZE_VALUE_LIMIT * 10]) { assert.equal(sc({ start: bad }).start, null, String(bad)); assert.equal(sc({ end: bad }).end, null, String(bad)); }
  assert.deepEqual(sizeEnds(sc({ start: 50, end: 10 }), false), { start: null, end: null }, "crossed: both ignored");
  assert.deepEqual(sizeEnds(sc({ start: 5, end: 5 }), false), { start: null, end: null }, "equal: both ignored");
  assert.deepEqual(sizeEnds(sc({ start: 10, end: 5 }), true), { start: null, end: 5 }, "a start that does not apply cannot cross the end");
  assert.equal(sc({ vary: "zero", start: 5 }).start, null, "From zero starts at zero: a start is ignored");
  assert.equal(sc({ fromZero: true, start: 5 }).start, null);
  assert.equal(sc({ vary: "zero", end: 5 }).end, 5, "an end applies under From zero");
});
test("sizeEnds: a point chart's default (Automatic = From zero) also ignores a start", () => {
  assert.deepEqual(sizeEnds(sc({ start: 5, end: 9 }), true), { start: null, end: 9 });
  assert.deepEqual(sizeEnds(sc({ start: 5, end: 9 }), false), { start: 5, end: 9 });
  assert.deepEqual(sizeEnds(sc({ vary: "range", start: 5 }), true), { start: 5, end: null }, "an explicit range beats the point chart's default");
});
test("By range with typed ends: the span is the typed ends, a value outside saturates (never hidden)", () => {
  const s = sc({ start: 10, end: 50 });
  assert.deepEqual(round(measureShares([10, 30, 50], { zero: false, scale: s })), [0, 0.5, 1]);
  assert.deepEqual(round(measureShares([0, 5, 60, 1000, 10, 50], { zero: false, scale: s })), [0, 0, 1, 1, 0, 1], "below start = smallest, above end = largest");
  assert.deepEqual(measureShares([null, 30], { zero: false, scale: s }), [null, 0.5]);
});
test("start only: the end is the data's largest; end only: the start is the data's smallest", () => {
  assert.deepEqual(round(measureShares([20, 30, 60], { zero: false, scale: sc({ start: 0 }) })), [0.333, 0.5, 1]);
  assert.deepEqual(round(measureShares([2, 4, 20], { zero: false, scale: sc({ start: 3 }) })), [0, 0.059, 1]);
  assert.deepEqual(round(measureShares([10, 20, 40], { zero: false, scale: sc({ end: 30 }) })), [0, 0.5, 1]);
  assert.deepEqual(round(measureShares([10, 20, 40], { zero: false, scale: sc({ end: 5 }) })), [1, 1, 1], "end below every value: all largest");
  assert.deepEqual(round(measureShares([10, 20, 40], { zero: false, scale: sc({ start: 99 }) })), [0, 0, 0], "start above every value: all smallest");
  assert.deepEqual(round(measureShares([40, 40], { zero: false, scale: sc({ start: 40 }) })), [0, 0], "all equal at the start");
  assert.deepEqual(round(measureShares([40, 40], { zero: false, scale: sc({ end: 40 }) })), [1, 1], "all equal at the end");
});
test("negative data and all-equal data with typed ends", () => {
  assert.deepEqual(round(measureShares([-10, -5, 0], { zero: false, scale: sc({ start: -10, end: 0 }) })), [0, 0.5, 1]);
  assert.deepEqual(round(measureShares([-20, -5, 5], { zero: false, scale: sc({ start: -10, end: 0 }) })), [0, 0.5, 1]);
  assert.deepEqual(round(measureShares([5, 5, 5], { zero: false, scale: sc({ start: 0, end: 10 }) })), [0.5, 0.5, 0.5], "typed ends give equal data a real place");
  assert.deepEqual(measureShares([5, 5], { zero: false, scale: D }), [1, 1], "untyped all-equal stays full size");
});
test("From zero with an end: the span runs from min(0, smallest) to the end; the point floor of 1 only without one", () => {
  const z = sc({ vary: "zero", end: 100 });
  assert.deepEqual(round(measureShares([25, 50, 100, 300], { zero: true, scale: z })), [0.25, 0.5, 1, 1]);
  assert.deepEqual(round(measureShares([-50, 50], { zero: true, scale: z })), [0, 0.667], "negative data: from the smallest to the end");
  assert.deepEqual(round(measureShares([0.2, 0.5], { zero: true, point: true, scale: D })), [0.2, 0.5], "bubble floor of 1, no end");
  assert.deepEqual(round(measureShares([0.2, 0.5], { zero: true, point: true, scale: sc({ vary: "zero", end: 1 }) })), [0.2, 0.5]);
  assert.deepEqual(round(measureShares([0.2, 0.5], { zero: true, point: true, scale: sc({ vary: "zero", end: 0.5 }) })), [0.4, 1], "an end below the floor replaces it");
  assert.deepEqual(round(measureShares([10, 20], { zero: true, scale: sc({ vary: "zero", end: -5 }) })), [1, 1], "an end below the base: every value is above it");
  assert.deepEqual(round(measureShares([10, 20], { zero: true, scale: sc({ vary: "zero", start: 15 }) })), [0.5, 1], "start ignored under From zero");
});
test("Reversed with each mode; typed ends are reversed too, and saturation flips with it", () => {
  const r = (o) => ({ ...sc(o), reversed: true });
  assert.deepEqual(round(measureShares([10, 20, 30], { zero: false, scale: r({}) })), [1, 0.5, 0]);
  assert.deepEqual(round(measureShares([10, 20, 40], { zero: true, scale: r({ vary: "zero" }) })), [0.75, 0.5, 0], "reversed + From zero draws as it always did");
  assert.deepEqual(round(measureShares([0, 30, 99], { zero: false, scale: r({ start: 10, end: 50 }) })), [1, 0.5, 0], "below start: smallest value gets the largest mark");
  assert.deepEqual(round(measureShares([5, 5], { zero: false, scale: r({}) })), [1, 1], "untyped all-equal is never reversed");
});
test("smallest / largest compose with the typed ends", () => {
  const s = { ...sc({ start: 0, end: 10 }), smallest: 20, largest: 60 };
  assert.deepEqual(round(measureShares([-5, 5, 99], { zero: false, scale: s })), [0.2, 0.4, 0.6]);
});
test("a non-finite value gets no mark share; Infinity / NaN in the data never poison the span", () => {
  assert.deepEqual(round(measureShares([10, NaN, 30, Infinity], { zero: false, scale: sc({ start: 10, end: 30 }) })), [0, null, 1, null]);
  assert.equal(measureShareFn([], { zero: false, scale: sc({ start: 1, end: 2 }) })(5), null);
});
test("cleanSizeScale: vary, start and end are validated like the other parts; bad ones are dropped and reported, never clamped", () => {
  assert.deepEqual(cleanSizeScale({ vary: "range", start: 10, end: 50 }), { value: { vary: "range", start: 10, end: 50 }, issues: [] });
  assert.deepEqual(cleanSizeScale({ vary: "automatic" }), { value: null, issues: [] }, "Automatic is the default: not stored");
  assert.deepEqual(cleanSizeScale({ vary: "zero", end: 3 }), { value: { vary: "zero", end: 3 }, issues: [] });
  assert.deepEqual(cleanSizeScale({ fromZero: true, reversed: true }), { value: { fromZero: true, reversed: true }, issues: [] }, "an old file keeps both, valid and drawn as before");
  const v = cleanSizeScale({ vary: "sideways" });
  assert.equal(v.value, null); assert.match(v.issues[0], /Sizes vary "sideways"/);
  for (const bad of [NaN, Infinity, "7", null, SIZE_VALUE_LIMIT * 10]) {
    const r = cleanSizeScale({ start: bad });
    if (bad === null) { assert.equal(r.value, null); continue; } // null = not set
    assert.equal(r.value, null, String(bad)); assert.match(r.issues.join(" "), /start value/);
  }
  const cross = cleanSizeScale({ start: 9, end: 3, vary: "range" });
  assert.deepEqual(cross.value, { vary: "range" }); assert.match(cross.issues.join(" "), /start.*below.*end/);
  const eq = cleanSizeScale({ start: 4, end: 4 }); assert.equal(eq.value, null); assert.equal(eq.issues.length, 1);
  const z = cleanSizeScale({ vary: "zero", start: 2, end: 8 });
  assert.deepEqual(z.value, { vary: "zero", end: 8 }); assert.match(z.issues.join(" "), /From zero.*start/);
  const zl = cleanSizeScale({ fromZero: true, start: 2 }); assert.equal(zl.value.start, undefined); assert.equal(zl.issues.length, 1);
  assert.equal(cleanSizeScale({ start: 0 }).value.start, 0, "zero is a real start");
  assert.equal(cleanSizeScale({ start: -3.5, end: 12.25 }).issues.length, 0);
});
test("sizeVaryError / sizeEndsError / setSizeVary: what the control accepts and writes", () => {
  assert.equal(sizeVaryError("range"), null);
  assert.match(sizeVaryError("x"), /Automatic, By range or From zero/);
  assert.equal(sizeEndsError(null, null), null);
  assert.equal(sizeEndsError(10, null), null);
  assert.equal(sizeEndsError(10, 50), null);
  assert.match(sizeEndsError(50, 10), /below/);
  assert.match(sizeEndsError(10, 10), /below/);
  assert.match(sizeEndsError(NaN, null), /number/);
  assert.match(sizeEndsError(null, Infinity), /number/);
  assert.match(sizeEndsError(SIZE_VALUE_LIMIT * 10, null), /between/);
  // the stored shape after picking a mode: the old key is dropped, and From zero removes what it makes meaningless
  assert.deepEqual(setSizeVary({ fromZero: false, smallest: 10 }, "zero"), { vary: "zero", smallest: 10 });
  assert.deepEqual(setSizeVary({ vary: "range", start: 3, end: 9, reversed: true }, "zero"), { vary: "zero", end: 9 }, "From zero drops start and Reversed");
  assert.deepEqual(setSizeVary({ vary: "zero", end: 9 }, "automatic"), { end: 9 });
  assert.deepEqual(setSizeVary({ fromZero: true }, "range"), { vary: "range" });
  assert.deepEqual(setSizeVary(undefined, "range"), { vary: "range" });
});
test("sizeLegendText names typed ends in words, and says which are set", () => {
  const fmtVal = String, range = { min: 3, max: 41 };
  assert.equal(sizeLegendText("sum qty", { range, fmtVal, ends: { start: 10, end: 50 } }), "Size: sum qty (10 to 50, set)");
  assert.equal(sizeLegendText("sum qty", { range, fmtVal, ends: { start: 10, end: null } }), "Size: sum qty (10 to 41, start set)");
  assert.equal(sizeLegendText("sum qty", { range, fmtVal, ends: { start: null, end: 50 } }), "Size: sum qty (3 to 50, end set)");
  assert.equal(sizeLegendText("sum qty", { range, fmtVal, ends: { start: 10, end: 50 }, reversed: true }), "Size: sum qty (10 to 50, set, reversed)");
  assert.equal(sizeLegendText("sum qty", { range, fmtVal, ends: { start: null, end: null } }), "Size: sum qty (3 to 41)");
  assert.equal(sizeLegendText("sum qty", { range, fmtVal }), "Size: sum qty (3 to 41)");
  assert.equal(sizeLegendText("region", { members: ["A", "B"], ends: { start: 1, end: 2 } }), "Size: region (A to B, 2 steps)", "a dimension ignores typed ends");
});
test("a start that does not apply never blocks or cancels an end: bubbles drop it (By range, start 10, back to Automatic, then End 5)", () => {
  // bubble chart: Automatic = From zero, so the Start field is off
  const back = setSizeVary({ vary: "range", start: 10 }, "automatic", true);
  assert.deepEqual(back, {}, "Automatic on a zero-default chart drops the start");
  assert.deepEqual(setSizeVary({ vary: "range", start: 10 }, "automatic", false), { start: 10 }, "a bar keeps it: Automatic is By range there");
  const r = sizeEndsEdit(back, true, "end", 5);
  assert.equal(r.error, null);
  assert.deepEqual(r.value, { end: 5 });
  assert.deepEqual(round(measureShares([2, 5, 9], { zero: true, point: true, scale: sc(r.value) })), [0.4, 1, 1], "the end draws");
  // a start left over where it does not apply (the chart type changed under the setting): typing an end drops it, and is accepted
  const left = sizeEndsEdit({ start: 10 }, true, "end", 5);
  assert.equal(left.error, null); assert.deepEqual(left.value, { end: 5 });
  assert.deepEqual(sizeEnds(sc({ start: 10, end: 5 }), true), { start: null, end: 5 }, "and the drawing never lets an inert start cross the end");
  // the bar case: the start applies, so End 5 is refused and End 50 accepted
  assert.match(sizeEndsEdit({ start: 10 }, false, "end", 5).error, /below/);
  assert.deepEqual(sizeEndsEdit({ start: 10 }, false, "end", 50).value, { start: 10, end: 50 });
  // By range on the bubble chart brings the start back into play
  assert.match(sizeEndsEdit({ vary: "range", start: 10 }, true, "end", 5).error, /below/);
  // explicit From zero: the start is off whatever the chart
  assert.deepEqual(sizeEndsEdit({ vary: "zero", start: 10 }, false, "end", 5).value, { vary: "zero", end: 5 });
  // clearing and the start key itself
  assert.deepEqual(sizeEndsEdit({ start: 10, end: 5 }, false, "end", null).value, { start: 10 });
  assert.match(sizeEndsEdit({ end: 5 }, false, "start", 9).error, /below/);
  assert.deepEqual(sizeEndsEdit({ end: 50 }, false, "start", 9).value, { end: 50, start: 9 });
  assert.equal(sizeEndsEdit(undefined, false, "end", 3).error, null);
});
