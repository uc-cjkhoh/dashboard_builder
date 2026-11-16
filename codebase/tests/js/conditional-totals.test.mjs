// "Include totals" in Format -> Conditional formatting: the pure model (extent, gate, stored shape) and the import check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extentOf, extentWithTotals, totalsIncluded, totalsGate, nextConditional, emptyRule, isActive, TOTALS_NOTE, TOTALS_OFF_REASON, TOTALS_IDLE_REASON }
  from "../../src/DashboardBuilder/Features/Dashboard/conditional-model.js";
import { serializeWorkbook, parseWorkbook, WORKBOOK_FORMAT } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

const scale = (extra = {}) => ({ ...emptyRule(), mode: "scale", ...extra });

test("the extent counts the totals when they are included, and only then", () => {
  assert.deepEqual(extentOf([10, 13, 15, 18]), { min: 10, max: 18 });
  assert.deepEqual(extentWithTotals([10, 13, 15, 18], [23, 33, 56]), { min: 10, max: 56 }, "a grand total is the new top of the scale");
  assert.deepEqual(extentWithTotals([10, 13], []), { min: 10, max: 13 }, "no totals: the cells' own extent");
  assert.deepEqual(extentWithTotals([10, 13], undefined), { min: 10, max: 13 });
});
test("the extent with totals: negatives, equal values, one value, blanks", () => {
  assert.deepEqual(extentWithTotals([-5, 3], [-2]), { min: -5, max: 3 }, "a total inside the range changes nothing");
  assert.deepEqual(extentWithTotals([-5, -3], [-8]), { min: -8, max: -3 }, "a negative total is the new bottom");
  assert.deepEqual(extentWithTotals([4, 4], [8]), { min: 4, max: 8 });
  assert.deepEqual(extentWithTotals([4, 4], [4]), { min: 4, max: 4 }, "all equal: a flat extent");
  assert.deepEqual(extentWithTotals([], [7]), { min: 7, max: 7 }, "one value, and it is a total");
  assert.deepEqual(extentWithTotals([5], [null, undefined, "", "x"]), { min: 5, max: 5 }, "a total shown as — never counts");
  assert.equal(extentWithTotals([null], [null]), null, "nothing numeric: no extent");
});
test("a total that is the extent's max is the scale's top", () => {
  const ext = extentWithTotals([1, 2, 3], [6]);
  assert.equal(ext.max, 6);
});

test("totals are included only while the measure draws something", () => {
  assert.equal(totalsIncluded(scale({ totals: true })), true);
  assert.equal(totalsIncluded({ ...emptyRule(), mode: "bars", totals: true }), true);
  assert.equal(totalsIncluded({ ...emptyRule(), rules: [{ op: ">", value: 1, tone: "good" }], totals: true }), true);
  assert.equal(totalsIncluded(scale()), false);
  assert.equal(totalsIncluded(scale({ totals: false })), false);
  assert.equal(totalsIncluded(scale({ totals: "yes" })), false, "only a real true counts");
  assert.equal(totalsIncluded({ ...emptyRule(), totals: true }), false, "nothing to colour with");
  assert.equal(totalsIncluded(undefined), false);
});

test("the Include totals control says why it is unavailable", () => {
  const on = { grand: true, sub: false }, off = { grand: false, sub: false };
  assert.deepEqual(totalsGate(scale(), on), { enabled: true, reason: null, note: null });
  assert.deepEqual(totalsGate(scale(), { grand: false, sub: true }), { enabled: true, reason: null, note: null });
  assert.equal(totalsGate(scale(), off).enabled, false);
  assert.equal(totalsGate(scale(), off).reason, TOTALS_OFF_REASON);
  assert.equal(TOTALS_OFF_REASON, "Turn on Grand totals or Subtotals");
  assert.equal(totalsGate(scale(), undefined).reason, TOTALS_OFF_REASON);
  const none = totalsGate(emptyRule(), on);
  assert.equal(none.enabled, false);
  assert.match(none.reason, /colour scale, data bars or a rule/);
  assert.equal(totalsGate(emptyRule(), off).reason, TOTALS_OFF_REASON, "totals off is the first thing to fix");
  // a saved "on" stays clearable even while no total is drawn, and says why nothing shows
  const idle = totalsGate(scale({ totals: true }), off);
  assert.equal(idle.enabled, true);
  assert.equal(idle.note, TOTALS_IDLE_REASON);
  assert.match(TOTALS_NOTE, /Totals are larger than single cells, so cells may look pale/);
});

test("the flag is stored only while it is on and the measure draws something", () => {
  const key = "d.t.amount:sum";
  let all = nextConditional({}, key, scale(), { totals: true });
  assert.deepEqual(all[key], { ...scale(), totals: true });
  all = nextConditional(all, key, all[key], { mode: "bars" });
  assert.equal(all[key].totals, true, "switching scale to bars keeps it");
  all = nextConditional(all, key, all[key], { totals: false });
  assert.ok(!("totals" in all[key]), "off is not stored (the entry is the same as before the feature)");
  assert.deepEqual(all[key], { ...scale(), mode: "bars" });
  // turning the last thing off removes the entry (and the flag with it)
  const on = nextConditional({}, key, scale(), { totals: true });
  assert.deepEqual(nextConditional(on, key, on[key], { mode: "none" }), {});
  // a midpoint alone keeps the entry as before, without a stale flag
  const mid = nextConditional(on, key, { ...on[key], mid: 5 }, { mode: "none" });
  assert.deepEqual(mid[key], { ...emptyRule(), mid: 5 });
  assert.equal(isActive(mid[key]), false);
  // other measures are untouched
  const two = nextConditional({ other: scale() }, key, scale(), { totals: true });
  assert.deepEqual(two.other, scale());
});

// --- import -----------------------------------------------------------------------------------------------
const wbText = (patch) => JSON.stringify({ format: WORKBOOK_FORMAT, version: 1, entities: [], relationships: [], dashboards: [], ...patch });
const sheetOf = (sheet) => parseWorkbook(wbText({ dashboards: [{ name: "S", sheet }] }));
const entryOf = (r) => r.worksheets[0].sheet.format.conditional;
const KEY = "s.orders.amount:sum";

test("import: a true flag round-trips untouched", () => {
  const good = { [KEY]: { mode: "scale", scale: "sequential", mid: null, rules: [], totals: true } };
  const r = sheetOf({ chartType: "table", format: { conditional: good } });
  assert.deepEqual(r.issues, []);
  assert.deepEqual(entryOf(r), good);
});
test("import: an old file (no flag) is unchanged, and false is not stored", () => {
  const old = { [KEY]: { mode: "bars", scale: "sequential", mid: null, rules: [] } };
  const r = sheetOf({ chartType: "table", format: { conditional: old } });
  assert.deepEqual(entryOf(r), old);
  assert.ok(!("totals" in entryOf(r)[KEY]));
  const f = sheetOf({ chartType: "table", format: { conditional: { [KEY]: { ...old[KEY], totals: false } } } });
  assert.deepEqual(f.issues, []);
  assert.deepEqual(entryOf(f), old);
});
test("import: a non-boolean flag is dropped and reported, never coerced; the rest of the entry stays", () => {
  for (const bad of ["yes", 1, 0, "true", null, {}, []]) {
    const r = sheetOf({ chartType: "table", format: { conditional: { [KEY]: { mode: "scale", scale: "sequential", mid: null, rules: [], totals: bad } } } });
    assert.deepEqual(entryOf(r), { [KEY]: { mode: "scale", scale: "sequential", mid: null, rules: [] } }, `totals: ${JSON.stringify(bad)}`);
    assert.equal(r.issues.length, 1, `reported once for ${JSON.stringify(bad)}`);
    assert.match(r.issues[0], /Include totals/);
  }
});
test("serialize then parse keeps the flag", () => {
  const sheet = { chartType: "table", columns: [], rows: [], color: [], filters: [], marks: {}, format: { conditional: { [KEY]: { mode: "scale", scale: "sequential", mid: null, rules: [], totals: true } } } };
  const saved = serializeWorkbook({ entities: new Map(), relationships: new Map(), tabs: [{ id: "ws#1", kind: "worksheet", name: "S", sheet }], active: { kind: "worksheet", id: "ws#1" } });
  const r = parseWorkbook(JSON.stringify(saved));
  assert.equal(r.worksheets[0].sheet.format.conditional[KEY].totals, true);
});
