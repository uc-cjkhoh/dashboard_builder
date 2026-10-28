import { test } from "node:test";
import assert from "node:assert/strict";
import { SWATCHES, memberKey, fieldColorKey, cleanMemberColors, setMemberColor, clearFieldColors, colourOf, colorsByName, orderedPalette, rampStops }
  from "../../src/DashboardBuilder/Features/Dashboard/colour-model.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
import { sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { emptySheet, defaultFormat } from "../../src/DashboardBuilder/Features/Core/store.js";

const plain = (x) => JSON.parse(JSON.stringify(x));
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
  assert.deepEqual(plain(m.value), { "t.c": { EU: "#aa00bb" } });
  m = setMemberColor(m.value, "t.c", "EU", null);
  assert.deepEqual(plain(m.value), {}); // empty field entry pruned
  assert.equal(setMemberColor({}, "t.c", "EU", "red").ok, false);
  assert.equal(setMemberColor({}, "t.c", "x".repeat(101), "#000000").ok, false);
  const full = { "t.c": Object.fromEntries(Array.from({ length: LIMITS.memberColors }, (_, i) => [`m${i}`, "#000000"])) };
  assert.equal(setMemberColor(full, "t.c", "new", "#111111").ok, false);
  assert.equal(setMemberColor(full, "t.c", "m1", "#111111").ok, true); // replace is fine
});
test("cleanMemberColors drops bad entries and reports", () => {
  const issues = [];
  const out = cleanMemberColors({ "t.c": { EU: "#AABBCC", US: "blue", ["y".repeat(101)]: "#000000" }, "t.d": "no" }, "S", issues);
  assert.deepEqual(plain(out), { "t.c": { EU: "#aabbcc" } });
  assert.equal(issues.length, 1); assert.match(issues[0], /3 invalid/);
  assert.deepEqual(plain(cleanMemberColors(undefined, "S", [])), {});
  const i2 = []; assert.deepEqual(plain(cleanMemberColors([1], "S", i2)), {}); assert.equal(i2.length, 1);
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
test("sheet round trip: memberColors + paletteReverse; old sheets unchanged", () => {
  const s = emptySheet();
  assert.deepEqual(s.memberColors, {});
  assert.equal(defaultFormat().paletteReverse, false);
  const issues = [];
  const out = sanitizeSheet({ ...s, memberColors: { "t.c": { EU: "#ABCDEF", bad: "x" } }, format: { ...s.format, paletteReverse: true } }, "S", issues);
  assert.deepEqual(plain(out.memberColors), { "t.c": { EU: "#abcdef" } });
  assert.equal(out.format.paletteReverse, true);
  assert.ok(issues.some((i) => /colour/i.test(i)));
  const old = sanitizeSheet({ chartType: "bar" }, "S", []);
  assert.deepEqual(old.memberColors, {}); assert.equal(old.format.paletteReverse, false);
  const bad = []; sanitizeSheet({ format: { paletteReverse: "yes" } }, "S", bad);
  assert.ok(bad.some((i) => /paletteReverse/.test(i)));
});
test("member names that are Object.prototype members are ordinary keys", () => {
  const names = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];
  let map = {};
  for (const n of names) {
    assert.equal(colourOf(map["t.c"], n), undefined, `${n} looks coloured before any pick`);
    const r = setMemberColor(map, "t.c", n, "#123456");
    assert.ok(r.ok, n); map = r.value;
    assert.equal(colourOf(map["t.c"], n), "#123456", n);
  }
  assert.equal(Object.keys(map["t.c"]).length, names.length);
  assert.equal(Object.getPrototypeOf({}).polluted, undefined);
});
test("the cap is not bypassed by prototype names", () => {
  const full = { "t.c": Object.fromEntries(Array.from({ length: LIMITS.memberColors }, (_, i) => [`m${i}`, "#000000"])) };
  assert.equal(setMemberColor(full, "t.c", "constructor", "#111111").ok, false);
  const fields = Object.fromEntries(Array.from({ length: LIMITS.memberColorFields }, (_, i) => [`t.f${i}`, { a: "#000000" }]));
  assert.equal(setMemberColor(fields, "constructor", "a", "#111111").ok, false);
});
test("cleanMemberColors drops an imported __proto__ key and reports it", () => {
  const raw = JSON.parse('{"__proto__":{"x":"#000000"},"t.c":{"__proto__":"#111111","ok":"#222222"}}');
  const issues = [];
  const out = cleanMemberColors(raw, "S", issues);
  assert.deepEqual(plain(out), { "t.c": { ok: "#222222" } });
  assert.equal(Object.getPrototypeOf(out["t.c"]), null);
  assert.equal(({}).x, undefined);
  assert.match(issues[0], /2 invalid/);
});
test("clearFieldColors removes one field, including stale members", () => {
  const m = { "t.c": { gone: "#000000", EU: "#111111" }, "t.d": { a: "#222222" } };
  assert.deepEqual(plain(clearFieldColors(m, "t.c").value), { "t.d": { a: "#222222" } });
  assert.deepEqual(plain(clearFieldColors(m, "nope").value), plain(m));
  // freeing the cap: a full field accepts a new member after clearing
  const full = { "t.c": Object.fromEntries(Array.from({ length: LIMITS.memberColors }, (_, i) => [`m${i}`, "#000000"])) };
  assert.ok(setMemberColor(clearFieldColors(full, "t.c").value, "t.c", "new", "#111111").ok);
});
test("memberField limit comes from LIMITS", () => {
  const issues = []; const out = cleanMemberColors({ ["f".repeat(LIMITS.memberField + 1)]: { a: "#000000" } }, "S", issues);
  assert.deepEqual(plain(out), {}); assert.equal(issues.length, 1);
});
