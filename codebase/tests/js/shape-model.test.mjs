import { test } from "node:test";
import assert from "node:assert/strict";
import { SHAPE_CHOICES, SHAPE_KEYS, shapeSymbol, SHAPE_BINS_DEFAULT, SHAPE_BINS_MIN, SHAPE_BINS_MAX, shapeBinsError, shapeBinsOf, cleanShapeBins,
  binShapeValues, setMemberShape, clearFieldShapes, cleanMemberShapes, shapesByName, shapeOrder } from "../../src/DashboardBuilder/Features/Dashboard/shape-model.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

const plain = (x) => JSON.parse(JSON.stringify(x));
const fmt = (v) => String(v);

import { baseSymbolAt, SHAPE_PALETTES, SHAPE_PALETTE_DEFAULT, shapeOf, defaultShapeAt, symbolAt, assignPalette, setFieldShapes, isShapeKey } from "../../src/DashboardBuilder/Features/Dashboard/shape-model.js";
test("the symbol set is seven distinct shapes in a fixed order", () => {
  assert.deepEqual(SHAPE_KEYS, ["circle", "square", "triangle", "diamond", "roundSquare", "pin", "arrow"]);
  assert.equal(new Set(SHAPE_CHOICES.map((c) => c[1])).size, 7); // distinct names in words
  assert.deepEqual(SHAPE_KEYS.map(shapeSymbol), ["circle", "rect", "triangle", "diamond", "roundRect", "pin", "arrow"]);
  assert.equal(shapeSymbol("nope"), "circle");
});

test("shape bins: 2 to 6, default 5, a bad value is refused, never clamped", () => {
  assert.equal(SHAPE_BINS_DEFAULT, 5); assert.equal(SHAPE_BINS_MIN, 2); assert.equal(SHAPE_BINS_MAX, 6);
  for (const v of [2, 3, 6]) assert.equal(shapeBinsError(v), null);
  for (const v of [1, 7, 0, -3, 2.5, "5", NaN, null, undefined]) assert.match(shapeBinsError(v), /2 to 6/);
  assert.equal(shapeBinsOf({}), 5); assert.equal(shapeBinsOf({ shapeBins: 3 }), 3); assert.equal(shapeBinsOf({ shapeBins: 99 }), 5);
  assert.deepEqual(cleanShapeBins(5), { ok: true, value: null }); // the default stores nothing
  assert.deepEqual(cleanShapeBins(4), { ok: true, value: 4 });
  assert.equal(cleanShapeBins(9).ok, false);
});

test("equal-width bins: a boundary value belongs to the bin above, the maximum to the last bin", () => {
  const r = binShapeValues([0, 2, 4, 5, 6, 8, 10], 5, fmt); // width 2: [0,2) [2,4) [4,6) [6,8) [8,10]
  assert.deepEqual(r.binOf, [0, 1, 2, 2, 3, 4, 4]);
  assert.deepEqual(r.bins.map((b) => b.name), ["0 to 2", "2 to 4", "4 to 6", "6 to 8", "8 to 10"]);
  assert.deepEqual(r.bins.map((b) => b.index), [0, 1, 2, 3, 4]);
});

test("negative values and fractional widths", () => {
  const r = binShapeValues([-10, -5, 0, 5, 10], 4, fmt); // width 5: [-10,-5) [-5,0) [0,5) [5,10]
  assert.deepEqual(r.binOf, [0, 1, 2, 3, 3]);
  assert.deepEqual(r.bins.map((b) => b.name), ["-10 to -5", "-5 to 0", "0 to 5", "5 to 10"]);
});

test("flat data is one bin, never a divide by zero", () => {
  const r = binShapeValues([7, 7, 7], 5, fmt);
  assert.deepEqual(r.binOf, [0, 0, 0]);
  assert.equal(r.bins.length, 1);
  assert.equal(r.bins[0].name, "7");
  assert.deepEqual(binShapeValues([3], 5, fmt).binOf, [0]);
});

test("a missing value gets its own distinct symbol and a named group; empty bins are not listed", () => {
  const r = binShapeValues([1, null, 9, undefined, NaN, "x", 5], 5, fmt);
  assert.equal(r.nullIndex, SHAPE_KEYS.length - 1); // the seventh symbol, which no bin uses
  assert.deepEqual(r.binOf, [0, r.nullIndex, 4, r.nullIndex, r.nullIndex, r.nullIndex, 2]);
  const names = r.bins.map((b) => b.name);
  assert.deepEqual(names, ["1 to 2.6", "4.2 to 5.8", "7.4 to 9", "No value"]); // only bins that hold points
  assert.equal(r.bins.at(-1).index, SHAPE_KEYS.length - 1);
  assert.equal(binShapeValues([1, 2], 5, fmt).nullIndex, SHAPE_KEYS.length - 1);
  assert.ok(!binShapeValues([1, 2], 5, fmt).bins.some((b) => b.name === "No value"));
  assert.deepEqual(binShapeValues([null, null], 5, fmt).bins.map((b) => b.name), ["No value"]);
  assert.deepEqual(binShapeValues([], 5, fmt).bins, []);
});

test("legend names stay unique when formatting rounds two bounds to the same text", () => {
  const rounding = (v) => String(Math.round(v));
  const r = binShapeValues([0, 1, 2], 6, rounding);
  assert.equal(new Set(r.bins.map((b) => b.name)).size, r.bins.length);
});

test("bin indexes are the symbol indexes, so the bin keeps its symbol when the data changes", () => {
  const a = binShapeValues([0, 10], 5, fmt), b = binShapeValues([0, 5, 10], 5, fmt);
  assert.equal(a.binOf[1], 4); assert.equal(b.binOf[2], 4); // the top bin is symbol 4 either way
});

test("shapeOrder sorts groups low bin first, missing last", () => {
  const groups = [{ name: "m", shape: { index: 6 } }, { name: "hi", shape: { index: 4 } }, { name: "lo", shape: { index: 0 } }];
  assert.deepEqual(shapeOrder(groups).map((g) => g.name), ["lo", "hi", "m"]);
});

test("setMemberShape sets, replaces, resets and validates", () => {
  let m = setMemberShape({}, "t.c", "EU", "triangle");
  assert.deepEqual(plain(m.value), { "t.c": { EU: "triangle" } });
  m = setMemberShape(m.value, "t.c", "EU", "pin"); assert.deepEqual(plain(m.value), { "t.c": { EU: "pin" } });
  m = setMemberShape(m.value, "t.c", "EU", null); assert.deepEqual(plain(m.value), {});
  assert.equal(setMemberShape({}, "t.c", "EU", "hexagon").ok, false);
  assert.equal(setMemberShape({}, "t.c", "x".repeat(LIMITS.memberKey + 1), "pin").ok, false);
  const full = { "t.c": Object.fromEntries(Array.from({ length: LIMITS.memberColors }, (_, i) => [`m${i}`, "pin"])) };
  assert.equal(setMemberShape(full, "t.c", "new", "pin").ok, false);
  assert.equal(setMemberShape(full, "t.c", "m1", "arrow").ok, true);
  const proto = setMemberShape({}, "t.c", "__proto__", "pin");
  assert.equal(proto.ok, false);
});

test("a member named like an Object property is an ordinary key", () => {
  const r = setMemberShape({}, "t.c", "constructor", "diamond");
  assert.equal(r.ok, true);
  assert.equal(Object.getPrototypeOf(r.value["t.c"]), null);
  assert.equal(shapesByName(r.value["t.c"], [{ name: "constructor", raw: "constructor" }]).get("constructor"), "diamond");
  assert.equal(shapesByName({}, [{ name: "constructor", raw: "constructor" }]).size, 0);
});

test("cleanMemberShapes drops bad entries and reports, never coerces", () => {
  const issues = [];
  const out = cleanMemberShapes({ "t.c": { EU: "pin", US: "hexagon", JP: 3, ["y".repeat(101)]: "pin" }, "t.d": "no", __proto__x: 1 }, "S", issues);
  assert.deepEqual(plain(out), { "t.c": { EU: "pin" } });
  assert.equal(issues.length, 1); assert.match(issues[0], /member shape/);
  assert.equal(cleanMemberShapes(undefined, "S", []), undefined);
  const i2 = []; assert.equal(cleanMemberShapes([1], "S", i2), undefined); assert.equal(i2.length, 1);
  const raw = JSON.parse('{"t.c": {"__proto__": "pin", "ok": "arrow"}}');
  assert.deepEqual(plain(cleanMemberShapes(raw, "S", [])), { "t.c": { ok: "arrow" } });
});

test("cleanMemberShapes caps fields and members", () => {
  const raw = {};
  for (let i = 0; i < LIMITS.memberColorFields + 3; i++) raw[`t.f${i}`] = { a: "pin" };
  const issues = [];
  assert.equal(Object.keys(cleanMemberShapes(raw, "S", issues)).length, LIMITS.memberColorFields);
  assert.ok(issues.length);
  const big = { "t.c": Object.fromEntries(Array.from({ length: LIMITS.memberColors + 5 }, (_, i) => [`m${i}`, "pin"])) };
  assert.equal(Object.keys(cleanMemberShapes(big, "S", [])["t.c"]).length, LIMITS.memberColors);
  assert.equal(cleanMemberShapes({ "t.c": { a: "nope" } }, "S", []), undefined); // nothing valid left: the key is not kept
});

test("clearFieldShapes removes one field", () => {
  const r = clearFieldShapes({ "t.c": { a: "pin" }, "t.d": { b: "arrow" } }, "t.c");
  assert.deepEqual(plain(r.value), { "t.d": { b: "arrow" } });
});

test("shapesByName maps displayed names to stored symbols (the null member too)", () => {
  const m = shapesByName({ EU: "pin", "\u0000null": "arrow" }, [{ name: "EU", raw: "EU" }, { name: "—", raw: null }, { name: "US", raw: "US" }]);
  assert.equal(m.get("EU"), "pin"); assert.equal(m.get("—"), "arrow"); assert.equal(m.has("US"), false);
});

test("a span too wide for a double (about ±1e308) still cuts into equal bins, with a correct legend", () => {
  const r = binShapeValues([-1e308, 0, 1e308], 5, fmt);
  assert.deepEqual(r.binOf, [0, 2, 4]);
  assert.deepEqual(r.bins.map((b) => b.name), ["-1e+308 to -6e+307", "-2e+307 to 2e+307", "6e+307 to 1e+308"]);
  assert.ok(r.bins.every((b) => !/NaN|Infinity/.test(b.name)));
});

test("bounds beyond ±1e12 keep every digit of the data's own minimum and maximum (epoch milliseconds)", () => {
  const r = binShapeValues([1234567890123, 1234567890128, 1234567890133], 2, fmt);
  assert.deepEqual(r.binOf, [0, 1, 1]);
  assert.deepEqual(r.bins.map((b) => b.name), ["1234567890123 to 1234567890128", "1234567890128 to 1234567890133"]);
  const wide = binShapeValues([-5e14, 5e14], 4, fmt);
  assert.deepEqual(wide.binOf, [0, 3]);
  assert.deepEqual(wide.bins.map((b) => b.name), ["-500000000000000 to -250000000000000", "250000000000000 to 500000000000000"]);
});

test("palettes: Default (ten shapes, the old seven first), Outline, Arrows, Weather; every key is unique and valid", () => {
  assert.deepEqual(SHAPE_PALETTES.map((p) => p.name), ["Default", "Outline", "Arrows", "Weather"]);
  assert.equal(SHAPE_PALETTE_DEFAULT.shapes.length, 10);
  assert.deepEqual(SHAPE_PALETTE_DEFAULT.shapes.slice(0, 7).map((c) => c[0]), SHAPE_KEYS); // saved shapes keep their keys and the first seven keep their order
  const keys = SHAPE_PALETTES.flatMap((p) => p.shapes.map((c) => c[0]));
  assert.equal(new Set(keys).size, keys.length);
  for (const k of keys) { assert.ok(isShapeKey(k), k); assert.match(shapeOf(k)[3], /^M[-\d.\s,MmLlHhVvCcAaZz]+$/, k); } // a glyph is a plain path on the 20-unit grid
  assert.equal(isShapeKey("nope"), false);
});
test("a built-in symbol keeps its ECharts name; the others are drawn from their glyph path", () => {
  assert.equal(shapeSymbol("pin"), "pin");
  assert.equal(shapeSymbol("star"), `path://${shapeOf("star")[3]}`);
  assert.equal(shapeSymbol("o-circle").startsWith("path://M"), true);
});
test("the default shape wraps over the ten of the Default palette; a bin never leaves the first seven", () => {
  assert.equal(defaultShapeAt(0)[0], "circle"); assert.equal(defaultShapeAt(9)[0], "star"); assert.equal(defaultShapeAt(10)[0], "circle"); assert.equal(defaultShapeAt(-1)[0], "star");
  assert.equal(symbolAt(2), "triangle"); assert.equal(symbolAt(9), shapeSymbol("star"));
  assert.equal(baseSymbolAt(9), "triangle"); assert.equal(baseSymbolAt(7), "circle"); // bins and shapeless groups still wrap over the first seven
  assert.ok(SHAPE_BINS_MAX + 1 <= 7); // six bins and the missing group: the first seven symbols
});
test("Assign Palette hands the palette's shapes to the members in order and repeats from the first", () => {
  const arrows = SHAPE_PALETTES.find((p) => p.key === "arrows");
  const r = assignPalette(arrows, ["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
  assert.equal(r.a, "arrow-n"); assert.equal(r.h, "arrow-nw"); assert.equal(r.i, "arrow-n");
  assert.deepEqual({ ...assignPalette({ shapes: [] }, ["a"]) }, {});
  assert.equal(Object.getPrototypeOf(assignPalette(arrows, ["__proto__", "x"])), null); // a bare map, and __proto__ is never a key
  assert.equal("__proto__" in {}, true); assert.equal(Object.keys(assignPalette(arrows, ["__proto__", "x"])).join(), "x");
});
test("setFieldShapes replaces one field's shapes, keeps the others, and refuses a bad key or a limit", () => {
  const start = { f1: { a: "circle" }, f2: { z: "pin" } };
  const r = setFieldShapes(start, "f1", { b: "star", c: "o-hexagon" });
  assert.equal(r.ok, true); assert.deepEqual({ ...r.value.f1 }, { b: "star", c: "o-hexagon" }); assert.deepEqual({ ...r.value.f2 }, { z: "pin" });
  assert.equal(setFieldShapes(start, "f1", {}).value.f1, undefined); // empty = the field's shapes are gone
  assert.equal(setFieldShapes(start, "f1", { b: "hexagon" }).ok, false);
  assert.deepEqual({ ...start.f1 }, { a: "circle" }); // the input is never changed
});
