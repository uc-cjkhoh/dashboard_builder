import { test } from "node:test";
import assert from "node:assert/strict";
import { SHAPE_CHOICES, SHAPE_KEYS, shapeSymbol, SHAPE_BINS_DEFAULT, SHAPE_BINS_MIN, SHAPE_BINS_MAX, shapeBinsError, shapeBinsOf, cleanShapeBins,
  binShapeValues, setMemberShape, clearFieldShapes, cleanMemberShapes, shapesByName, shapeOrder } from "../../src/DashboardBuilder/Features/Dashboard/shape-model.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

const plain = (x) => JSON.parse(JSON.stringify(x));
const fmt = (v) => String(v);

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
