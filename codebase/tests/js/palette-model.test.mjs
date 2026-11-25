import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PALETTE_NAME, isHex6, normHex, checkNewPalette, cleanPalettes, assignPalette, newPaletteDraft, addColour, setColour, removeColour, selectColour }
  from "../../src/DashboardBuilder/Features/Core/palette-model.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

const C = (n) => Array.from({ length: n }, (_, i) => `#${(0x100000 + i * 4099).toString(16).padStart(6, "0")}`);

test("limits: 12 palettes, 24 colours, a name of 40", () => {
  assert.deepEqual([LIMITS.palettes, LIMITS.paletteColours, LIMITS.paletteName], [12, 24, 40]);
  assert.equal(LIMITS.paletteText, undefined, "no text or file import any more");
  assert.equal(LIMITS.paletteFile, undefined);
});
test("one colour rule: six digits, # optional, any case; normalised to #rrggbb", () => {
  for (const v of ["#a1B2c3", "a1b2c3", " #A1B2C3 "]) assert.ok(isHex6(v), v);
  for (const v of ["#abc", "#a1b2c", "#a1b2c3d", "red", "", null, 12, "#gggggg"]) assert.ok(!isHex6(v), String(v));
  assert.equal(normHex(" A1B2C3 "), "#a1b2c3");
});

test("check: a good palette is trimmed and lower-cased", () => {
  assert.deepEqual(checkNewPalette({ name: "  Brand ", colours: ["#AABBCC", "112233"] }), { ok: true, palette: { name: "Brand", colours: ["#aabbcc", "#112233"] } });
});
test("check: every reason is given at once", () => {
  const r = checkNewPalette({ name: "", colours: [] });
  assert.deepEqual(r.errors, ["Name the palette.", "A palette needs at least one colour."]);
  const q = checkNewPalette({ name: "x".repeat(41), colours: C(25) });
  assert.match(q.errors[0], /at most 40/);
  assert.match(q.errors[1], /at most 24 colours \(this one has 25\)/);
});
test("check: 24 colours are fine, a colour that is not #rrggbb is refused", () => {
  assert.equal(checkNewPalette({ name: "ok", colours: C(24) }).ok, true);
  assert.deepEqual(checkNewPalette({ name: "ok", colours: ["#112233", "red"] }).errors, ["Every colour needs to be #rrggbb."]);
});
test("check: a name is unique case-insensitively, is never Default, takes no control characters", () => {
  const existing = [{ name: "Brand", colours: ["#112233"] }];
  assert.match(checkNewPalette({ name: "brand", colours: ["#112233"] }, existing).errors[0], /already exists/);
  assert.match(checkNewPalette({ name: DEFAULT_PALETTE_NAME.toUpperCase(), colours: ["#112233"] }).errors[0], /already exists/);
  assert.match(checkNewPalette({ name: "a\u0000b", colours: ["#112233"] }).errors[0], /control characters/);
  assert.equal(checkNewPalette({ name: "<b>x</b>", colours: ["#112233"] }).ok, true, "markup is only text (it is shown with textContent)");
});
test("check: the 13th palette is refused", () => {
  const full = Array.from({ length: 12 }, (_, i) => ({ name: `p${i}`, colours: ["#112233"] }));
  assert.match(checkNewPalette({ name: "extra", colours: ["#112233"] }, full).errors[0], /at most 12 palettes/);
});
test("clean: absent is none; a non-list is dropped with one issue", () => {
  const issues = [];
  assert.deepEqual(cleanPalettes(undefined, issues), []);
  assert.deepEqual(cleanPalettes(null, issues), []);
  assert.deepEqual(issues, []);
  assert.deepEqual(cleanPalettes({ a: 1 }, issues), []);
  assert.equal(issues.length, 1);
});
test("clean: bad palettes are dropped and each reported; good ones keep their order", () => {
  const issues = [];
  const out = cleanPalettes([
    { name: "A", colours: ["#112233"] },
    { name: "B", colours: ["#112233", "nope"] },
    { name: "a", colours: ["#445566"] },        // a duplicate name
    { name: "C", colours: [] },                  // no colours
    "junk", null, { name: "D" },
    { name: "E", colours: ["445566", "#AABBCC"] },
  ], issues);
  assert.deepEqual(out, [{ name: "A", colours: ["#112233"] }, { name: "E", colours: ["#445566", "#aabbcc"] }]);
  assert.equal(issues.length, 6);
  assert.match(issues[0], /“B”.*not #rrggbb/);
  assert.match(issues[1], /“a” was dropped: A palette called/);
});
test("clean: extra palettes past 12 are dropped and reported; a hostile entry is only data", () => {
  const issues = [];
  const out = cleanPalettes(Array.from({ length: 14 }, (_, i) => ({ name: `p${i}`, colours: ["#112233"] })), issues);
  assert.equal(out.length, 12);
  assert.equal(issues.length, 2);
  const bad = cleanPalettes([{ name: "__proto__", colours: ["#112233"] }, { name: "x", colours: ["#112233"], extra: { polluted: true } }], []);
  assert.deepEqual(bad.map((p) => Object.keys(p).sort()), [["colours", "name"], ["colours", "name"]], "only name and colours are kept");
  assert.equal({}.polluted, undefined);
});

test("assign: the n-th key takes the n-th colour, repeating from the first; no colours assigns nothing", () => {
  const a = assignPalette(["#111111", "#222222"], ["a", "b", "c", "d", "e"]);
  assert.deepEqual({ ...a }, { a: "#111111", b: "#222222", c: "#111111", d: "#222222", e: "#111111" });
  assert.equal(Object.getPrototypeOf(a), null, "a key named __proto__ is an ordinary key");
  assert.deepEqual({ ...assignPalette([], ["a"]) }, {});
  assert.equal(assignPalette(["#111111"], ["__proto__"])["__proto__"], "#111111");
});

test("draft: starts with one chosen colour; + adds one after it and chooses it, in creation order", () => {
  let d = newPaletteDraft("A1B2C3");
  assert.deepEqual(d, { colours: ["#a1b2c3"], selected: 0 });
  d = addColour(d, "#112233"); d = addColour(d, "445566");
  assert.deepEqual(d, { colours: ["#a1b2c3", "#112233", "#445566"], selected: 2 });
});
test("draft: the chosen colour is replaced by a good hex only; choosing is bounded", () => {
  let d = { colours: ["#111111", "#222222"], selected: 0 };
  assert.equal(setColour(d, "#12345"), d, "a half-typed colour changes nothing");
  assert.deepEqual(setColour(d, "ABCDEF").colours, ["#abcdef", "#222222"]);
  assert.equal(selectColour(d, 5), d);
  assert.equal(selectColour(d, -1), d);
  assert.equal(selectColour(d, 1).selected, 1);
  assert.deepEqual(d, { colours: ["#111111", "#222222"], selected: 0 }, "edits return a new state");
});
test("draft: removing keeps the order and moves the choice to the colour now in that place, else the last", () => {
  const d = { colours: ["#111111", "#222222", "#333333"], selected: 1 };
  assert.deepEqual(removeColour(d), { colours: ["#111111", "#333333"], selected: 1 });
  assert.deepEqual(removeColour({ ...d, selected: 2 }), { colours: ["#111111", "#222222"], selected: 1 });
  assert.equal(removeColour(d, 9), d);
});
test("draft: the 25th colour is refused, not cut", () => {
  let d = newPaletteDraft("#000000");
  for (let i = 1; i < 24; i++) d = addColour(d, C(24)[i]);
  assert.equal(d.colours.length, 24);
  assert.equal(addColour(d, "#ffffff"), d);
});
