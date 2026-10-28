import { test } from "node:test";
import assert from "node:assert/strict";
import { SWATCHES, memberKey, fieldColorKey, cleanMemberColors, setMemberColor, colorsByName, orderedPalette, rampStops, inkFor }
  from "../../src/DashboardBuilder/Features/Dashboard/colour-model.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
import { sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { emptySheet, defaultFormat } from "../../src/DashboardBuilder/Features/Core/store.js";
import { contrastRatio } from "../../src/DashboardBuilder/Features/Dashboard/contrast.js";

test("swatches are valid distinct #rrggbb", () => {
  assert.ok(SWATCHES.length >= 12);
  for (const s of SWATCHES) assert.match(s, /^#[0-9a-f]{6}$/);
  assert.equal(new Set(SWATCHES).size, SWATCHES.length);
});
test("memberKey stringifies, null is its own key", () => {
  assert.equal(memberKey(5), "5");
  assert.equal(memberKey(null), "\u0000null");
  assert.equal(fieldColorKey({ table: "t", column: "c" }), "t.c");
});
test("setMemberColor sets, replaces, resets and validates", () => {
  let m = setMemberColor({}, "t.c", "EU", "#AA00bb");
  assert.deepEqual(m.value, { "t.c": { EU: "#aa00bb" } });
  m = setMemberColor(m.value, "t.c", "EU", null);
  assert.deepEqual(m.value, {}); // empty field entry pruned
  assert.equal(setMemberColor({}, "t.c", "EU", "red").ok, false);
  assert.equal(setMemberColor({}, "t.c", "x".repeat(101), "#000000").ok, false);
  const full = { "t.c": Object.fromEntries(Array.from({ length: LIMITS.memberColors }, (_, i) => [`m${i}`, "#000000"])) };
  assert.equal(setMemberColor(full, "t.c", "new", "#111111").ok, false);
  assert.equal(setMemberColor(full, "t.c", "m1", "#111111").ok, true); // replace is fine
});
test("cleanMemberColors drops bad entries and reports", () => {
  const issues = [];
  const out = cleanMemberColors({ "t.c": { EU: "#AABBCC", US: "blue", ["y".repeat(101)]: "#000000" }, "t.d": "no" }, "S", issues);
  assert.deepEqual(out, { "t.c": { EU: "#aabbcc" } });
  assert.equal(issues.length, 1); assert.match(issues[0], /3 invalid/);
  assert.deepEqual(cleanMemberColors(undefined, "S", []), {});
  const i2 = []; assert.deepEqual(cleanMemberColors([1], "S", i2), {}); assert.equal(i2.length, 1);
});
test("cleanMemberColors caps fields and members", () => {
  const raw = {};
  for (let i = 0; i < LIMITS.memberColorFields + 3; i++) raw[`t.f${i}`] = { a: "#000000" };
  const issues = [];
  assert.equal(Object.keys(cleanMemberColors(raw, "S", issues)).length, LIMITS.memberColorFields);
  assert.ok(issues.length);
  const big = { "t.c": Object.fromEntries(Array.from({ length: LIMITS.memberColors + 5 }, (_, i) => [`m${i}`, "#000000"])) };
  assert.equal(Object.keys(cleanMemberColors(big, "S", [])["t.c"]).length, LIMITS.memberColors);
});
test("colorsByName maps displayed names to stored colours", () => {
  const m = colorsByName({ EU: "#112233", "\u0000null": "#445566" }, [{ name: "EU", raw: "EU" }, { name: "—", raw: null }, { name: "US", raw: "US" }]);
  assert.equal(m.get("EU"), "#112233"); assert.equal(m.get("—"), "#445566"); assert.equal(m.has("US"), false);
  assert.equal(colorsByName(undefined, [{ name: "a", raw: "a" }]).size, 0);
});
test("orderedPalette reverses a copy; rampStops swaps ends", () => {
  const p = ["a", "b", "c"];
  assert.deepEqual(orderedPalette(p, true), ["c", "b", "a"]); assert.deepEqual(p, ["a", "b", "c"]);
  assert.deepEqual(orderedPalette(p, false), p);
  assert.deepEqual(rampStops("lo", "hi", true), ["hi", "lo"]);
  assert.deepEqual(rampStops("lo", "hi", false), ["lo", "hi"]);
});
test("inkFor picks a readable ink on any custom colour", () => {
  for (const bg of ["#000000", "#ffffff", "#ffff00", "#0000ff", "#808080"]) {
    const ink = inkFor(bg, "#111111", "#ffffff");
    assert.ok(contrastRatio(ink, bg) >= 3.5, bg);
  }
});
test("sheet round trip: memberColors + paletteReverse; old sheets unchanged", () => {
  const s = emptySheet();
  assert.deepEqual(s.memberColors, {});
  assert.equal(defaultFormat().paletteReverse, false);
  const issues = [];
  const out = sanitizeSheet({ ...s, memberColors: { "t.c": { EU: "#ABCDEF", bad: "x" } }, format: { ...s.format, paletteReverse: true } }, "S", issues);
  assert.deepEqual(out.memberColors, { "t.c": { EU: "#abcdef" } });
  assert.equal(out.format.paletteReverse, true);
  assert.ok(issues.some((i) => /colour/i.test(i)));
  const old = sanitizeSheet({ chartType: "bar" }, "S", []);
  assert.deepEqual(old.memberColors, {}); assert.equal(old.format.paletteReverse, false);
  const bad = []; sanitizeSheet({ format: { paletteReverse: "yes" } }, "S", bad);
  assert.ok(bad.some((i) => /paletteReverse/.test(i)));
});
