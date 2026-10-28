import { test } from "node:test";
import assert from "node:assert/strict";
import { aliasOf, setAlias, clearAliases, cleanMemberAliases, keyAliasMaps, withMemberLabels, labelOf, aliasesFromInputs, memberRows }
  from "../../src/DashboardBuilder/Features/Dashboard/member-labels.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

// T02-29 member aliases: a per-field raw value -> display label map. Display only; every lookup is by own key.
const plain = (x) => JSON.parse(JSON.stringify(x));

test("limits: 200 entries per field, label 80, key 100", () => {
  assert.equal(LIMITS.memberAliases, 200);
  assert.equal(LIMITS.memberLabel, 80);
  assert.equal(LIMITS.memberKey, 100);
});
test("aliasOf reads own keys only: constructor / __proto__ / toString are ordinary members", () => {
  assert.equal(aliasOf(undefined, "x"), undefined);
  assert.equal(aliasOf({}, "constructor"), undefined);
  assert.equal(aliasOf({}, "__proto__"), undefined);
  assert.equal(aliasOf({}, "toString"), undefined);
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const r = setAlias(undefined, key, `L-${key}`);
    assert.ok(r.ok, key);
    assert.equal(aliasOf(r.value, key), `L-${key}`);
    assert.equal(aliasOf(r.value, "other"), undefined);
    assert.equal(Object.getPrototypeOf(r.value), null, "a null-prototype map");
  }
});
test("a stored map holding __proto__ as an own key survives a JSON round trip and still answers", () => {
  const parsed = JSON.parse('{"__proto__":"Proto","a":"A"}');
  const issues = [];
  const clean = cleanMemberAliases(parsed, "Field s.t.c", issues);
  assert.equal(aliasOf(clean, "__proto__"), "Proto");
  assert.equal(aliasOf(clean, "a"), "A");
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(({}).Proto, undefined);
  assert.deepEqual(issues, []);
});
test("a null raw value is never labelled; numbers key as their text", () => {
  assert.equal(aliasOf({ "5": "Five" }, 5), "Five");
  assert.equal(aliasOf({ "null": "x" }, null), undefined);
  assert.equal(aliasOf({ "\u0000null": "x" }, null), undefined);
  assert.equal(setAlias(undefined, null, "x").ok, false);
});
test("setAlias validates, replaces, clears on blank and enforces the limits", () => {
  let m = setAlias(undefined, "EU", "Europe").value;
  m = setAlias(m, "US", "United States").value;
  assert.deepEqual(plain(m), { EU: "Europe", US: "United States" });
  assert.deepEqual(plain(setAlias(m, "EU", "  ").value), { US: "United States" }, "blank clears");
  assert.equal(setAlias(m, "EU", "x".repeat(81)).ok, false);
  assert.match(setAlias(m, "EU", "x".repeat(81)).error, /at most 80/);
  assert.equal(setAlias(m, "k".repeat(101), "x").ok, false);
  assert.equal(setAlias(setAlias(undefined, "EU", "Europe").value, "EU", "").value, undefined, "the last one removed -> no map");
  let big = undefined;
  for (let i = 0; i < 200; i++) big = setAlias(big, `m${i}`, `L${i}`).value;
  assert.equal(setAlias(big, "extra", "x").ok, false);
  assert.match(setAlias(big, "extra", "x").error, /At most 200/);
  assert.equal(setAlias(big, "m3", "changed").ok, true, "replacing an entry at the cap is fine");
});
test("the input never mutates the map it was given", () => {
  const m = setAlias(undefined, "a", "A").value;
  const before = plain(m);
  setAlias(m, "b", "B");
  setAlias(m, "a", "");
  assert.deepEqual(plain(m), before);
});
test("cleanMemberAliases drops bad entries and reports them; absent = undefined", () => {
  assert.equal(cleanMemberAliases(undefined, "w", []), undefined);
  const issues = [];
  assert.equal(cleanMemberAliases("nope", "w", issues), undefined);
  assert.equal(issues.length, 1);
  const i2 = [];
  const raw = { ok: "Fine", empty: "", num: 5, long: "x".repeat(81), ["k".repeat(101)]: "x", arr: ["a"] };
  const c = cleanMemberAliases(raw, "w", i2);
  assert.deepEqual(plain(c), { ok: "Fine" });
  assert.equal(i2.length, 1);
  assert.match(i2[0], /5 invalid member label/);
  const many = {};
  for (let i = 0; i < 250; i++) many[`m${i}`] = `label ${i}`;
  const i3 = [];
  assert.equal(Object.keys(cleanMemberAliases(many, "w", i3)).length, 200);
  assert.equal(i3.length, 1);
  assert.equal(cleanMemberAliases({ a: "" }, "w", []), undefined, "nothing left -> undefined");
});
test("clearAliases is just undefined", () => assert.equal(clearAliases(), undefined));

const metaOf = (f) => ({ "t.region": { memberAliases: { EU: "Europe" } }, "t.chan": { memberAliases: { a: "Alpha", EU: "Other-EU" } } }[`${f.table}.${f.column}`] ?? {});
test("keyAliasMaps lines the maps up with the query's key order; a calculated or missing key has none", () => {
  const order = [{ db: "d", table: "t", column: "region" }, { calc: "calc1", db: "", table: "", column: "G" }, null, { db: "d", table: "t", column: "chan" }];
  const maps = keyAliasMaps(order, metaOf);
  assert.deepEqual(plain(maps[0]), { EU: "Europe" });
  assert.equal(maps[1], undefined);
  assert.equal(maps[2], undefined);
  assert.deepEqual(plain(maps[3]), { a: "Alpha", EU: "Other-EU" });
});
test("withMemberLabels is position-aware and falls back to the plain formatter", () => {
  const maps = keyAliasMaps([{ db: "d", table: "t", column: "region" }, { db: "d", table: "t", column: "chan" }], metaOf);
  const fmt = withMemberLabels((k) => `<${k}>`, maps);
  assert.equal(fmt("EU", 0), "Europe");
  assert.equal(fmt("EU", 1), "Other-EU", "the same raw value labels per field");
  assert.equal(fmt("US", 0), "<US>", "an unlabelled member keeps the plain format");
  assert.equal(fmt("EU"), "<EU>", "no position: plain");
  assert.equal(fmt("EU", 7), "<EU>", "a position beyond the keys: plain");
  assert.equal(fmt(null, 0), "<null>", "null is never labelled");
  assert.equal(fmt("constructor", 0), "<constructor>");
});
test("withMemberLabels with no label maps at all returns the formatter itself", () => {
  const f = (k) => k;
  assert.equal(withMemberLabels(f, [undefined, undefined]), f);
});
test("labelOf: the display of one member of one field (selection chips, drill path)", () => {
  assert.equal(labelOf({ memberAliases: { EU: "Europe" } }, "EU", (k) => `<${k}>`), "Europe");
  assert.equal(labelOf({}, "EU", (k) => `<${k}>`), "<EU>");
  assert.equal(labelOf(undefined, "EU", (k) => `<${k}>`), "<EU>");
});
test("memberRows: the dialog's rows - the field's members plus stored members no longer in the top list; raw kept", () => {
  const rows = memberRows(["EU", null, "US"], { EU: "Europe", GONE: "Gone" });
  assert.deepEqual(rows, [{ raw: "EU", label: "Europe" }, { raw: "US", label: "" }, { raw: "GONE", label: "Gone" }]);
  assert.deepEqual(memberRows([], undefined), []);
  assert.deepEqual(memberRows(["a", "a"], undefined), [{ raw: "a", label: "" }], "a repeated member is listed once");
});
test("aliasesFromInputs: the dialog's typed labels -> a map; unchanged-from-raw and blank are dropped; limits checked", () => {
  const r = aliasesFromInputs([{ raw: "EU", label: "Europe" }, { raw: "US", label: "" }, { raw: "UK", label: "UK" }]);
  assert.ok(r.ok);
  assert.deepEqual(plain(r.value), { EU: "Europe" });
  assert.equal(aliasesFromInputs([]).value, undefined);
  const bad = aliasesFromInputs([{ raw: "EU", label: "x".repeat(81) }]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /at most 80/);
  const longKey = aliasesFromInputs([{ raw: "k".repeat(101), label: "x" }]);
  assert.equal(longKey.ok, false, "a typed label for a member too long to key is refused, naming the member");
  assert.match(longKey.error, /kkkkkkkkkkkkkkkkkkkkkkkk….*longer than 100/);
  assert.equal(aliasesFromInputs([{ raw: "k".repeat(101), label: "" }]).ok, true, "no label typed: nothing to refuse");
  const proto = aliasesFromInputs([{ raw: "__proto__", label: "P" }]);
  assert.equal(aliasOf(proto.value, "__proto__"), "P");
});

// --- the workbook round trip: field settings carry memberAliases ---
import { parseWorkbook, serializeWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
const roundTrip = (fieldMeta, mutate) => {
  const json = JSON.parse(JSON.stringify(serializeWorkbook({ entities: new Map(), relationships: new Map(), tabs: [], active: null, fieldMeta })));
  mutate?.(json);
  return parseWorkbook(JSON.stringify(json));
};
test("memberAliases save in the field settings and open again, __proto__ and constructor included", () => {
  const map = setAlias(setAlias(setAlias(undefined, "EU", "Europe").value, "constructor", "C").value, "__proto__", "P").value;
  const wb = roundTrip(new Map([["d.t.region", { alias: "Area", memberAliases: map }]]));
  const back = wb.fields["d.t.region"];
  assert.equal(back.alias, "Area");
  assert.equal(aliasOf(back.memberAliases, "EU"), "Europe");
  assert.equal(aliasOf(back.memberAliases, "constructor"), "C");
  assert.equal(aliasOf(back.memberAliases, "__proto__"), "P");
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(wb.issues, []);
});
test("a workbook without memberAliases opens unchanged, with no issue", () => {
  const wb = roundTrip(new Map([["d.t.region", { alias: "Area", agg: "avg" }]]));
  assert.deepEqual(wb.fields, { "d.t.region": { alias: "Area", agg: "avg" } });
  assert.deepEqual(wb.issues, []);
});
test("bad saved member labels are dropped and reported; the rest of the field's settings stay", () => {
  const wb = roundTrip(new Map([["d.t.region", { alias: "Area" }]]), (j) => { j.fields["d.t.region"].memberAliases = { ok: "Fine", bad: 5, empty: "" }; });
  assert.deepEqual(plain(wb.fields["d.t.region"].memberAliases), { ok: "Fine" });
  assert.equal(wb.fields["d.t.region"].alias, "Area");
  assert.ok(wb.issues.some((i) => /2 invalid member labels dropped/.test(i)), wb.issues.join("|"));
  const gone = roundTrip(new Map([["d.t.region", { alias: "Area" }]]), (j) => { j.fields["d.t.region"].memberAliases = "x"; });
  assert.equal(gone.fields["d.t.region"].memberAliases, undefined);
  assert.equal(gone.fields["d.t.region"].alias, "Area");
});

// --- labels are unique within a field: nothing can draw as one mark twice ---
test("setAlias refuses a label another member already shows, or another member's raw value, naming that member", () => {
  const m = setAlias(undefined, "EU", "Europe").value;
  const same = setAlias(m, "UK", "Europe");
  assert.equal(same.ok, false);
  assert.match(same.error, /'Europe' is already used by the member 'EU'/);
  const rawClash = setAlias(m, "UK", "US", ["EU", "US", "UK"]);
  assert.equal(rawClash.ok, false);
  assert.match(rawClash.error, /member 'US'/);
  assert.equal(setAlias(m, "EU", "Europe").ok, true, "re-saving a member's own label is fine");
  assert.equal(setAlias(m, "UK", "United Kingdom", ["EU", "US", "UK"]).ok, true);
  assert.equal(setAlias(undefined, "k".repeat(101), "x").ok, false);
  assert.match(setAlias(undefined, "k".repeat(101), "x").error, /kkkkkkkkkkkkkkkkkkkkkkkk….*100 characters/);
});
test("the dialog's rows: two members typed with one label, or a label equal to another member's value, block Save", () => {
  const dup = aliasesFromInputs([{ raw: "EU", label: "West" }, { raw: "US", label: "West" }]);
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already used by the member 'EU'/);
  const rawClash = aliasesFromInputs([{ raw: "EU", label: "US" }, { raw: "US", label: "" }]);
  assert.equal(rawClash.ok, false);
  assert.match(rawClash.error, /'US'/);
  assert.equal(aliasesFromInputs([{ raw: "EU", label: "Europe" }, { raw: "US", label: "Americas" }]).ok, true);
});
test("a workbook with two members sharing a label opens with the first kept, the second dropped and reported (deterministic)", () => {
  const wb = roundTrip(new Map([["d.t.region", { alias: "Area" }]]), (j) => { j.fields["d.t.region"].memberAliases = { EU: "West", US: "West", UK: "Brit", Brit: "x" }; });
  const a = wb.fields["d.t.region"].memberAliases;
  assert.equal(aliasOf(a, "EU"), "West");
  assert.equal(aliasOf(a, "US"), undefined);
  assert.equal(aliasOf(a, "Brit"), "x");
  assert.equal(aliasOf(a, "UK"), undefined, "a label equal to another stored member's value is dropped too");
  assert.ok(wb.issues.some((i) => /2 member labels dropped because another member already shows as that text/.test(i)), wb.issues.join("|"));
  assert.equal(new Set(Object.keys(a).map((k) => aliasOf(a, k))).size, Object.keys(a).length, "every kept label is unique");
});
