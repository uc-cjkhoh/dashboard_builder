// Several fields on Colour: which fields the Colour slot holds and how a drop changes it, the combined member ("a · b") and its colour key,
// the plan's group-by keys (colour fields come last), the import clean-up, and the query cap. Pure model — drawing is tests/live/marks-colour-ui.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addColourField, colourDimensions, cleanColourList, memberText, memberRaw, combinedField, COLOUR_FIELDS_MAX, MULTI_COLOUR_TYPES } from "../../src/DashboardBuilder/Features/Dashboard/colour-fields-model.js";
import { fieldColorKey, memberKey, colorsByName, setMemberColor, cleanMemberColors } from "../../src/DashboardBuilder/Features/Dashboard/colour-model.js";
import { planDims, colourDimsOf, COLOR_USES } from "../../src/DashboardBuilder/Features/Dashboard/sheet-plan.js";
import { viewCounts, checkAdd } from "../../src/DashboardBuilder/Features/Dashboard/filter-rules.js";
import { sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

const dim = (column, table = "t") => ({ db: "d", table, column, category: "text", role: "dimension" });
const num = (column) => ({ db: "d", table: "t", column, category: "numeric", role: "measure", agg: "sum" });
const sheet = (over = {}) => ({ ...emptySheet("S"), chartType: "bar", ...over });

test("a categorical drop appends (up to the cap); a duplicate and a drop over the cap are refused with a sentence", () => {
  let r = addColourField([], dim("a")); assert.deepEqual(r, { ok: true, list: [dim("a")] });
  r = addColourField(r.list, dim("b")); assert.equal(r.list.length, 2);
  assert.equal(addColourField(r.list, dim("a")).ok, false);
  assert.match(addColourField(r.list, dim("a")).error, /already/);
  r = addColourField(r.list, dim("c")); assert.equal(r.list.length, COLOUR_FIELDS_MAX); assert.equal(COLOUR_FIELDS_MAX, 3); assert.equal(LIMITS.colourFields, 3);
  const full = addColourField(r.list, dim("d")); assert.equal(full.ok, false); assert.match(full.error, /at most 3/);
});
test("a measure replaces every Colour field; a dimension dropped on a measure replaces it; a same-named column of another table is a different field", () => {
  assert.deepEqual(addColourField([dim("a"), dim("b")], num("q")).list, [num("q")]);
  assert.deepEqual(addColourField([num("q")], dim("a")).list, [dim("a")]);
  assert.equal(addColourField([dim("a")], dim("a", "other")).ok, true);
  const calc = { calc: "c1", db: "", table: "", column: "x", category: "text", role: "dimension" };
  assert.equal(addColourField([calc], { ...calc }).ok, false, "the same calculated field twice");
});
test("colourDimensions: a leading measure means no dimensions; measures are never mixed in", () => {
  assert.deepEqual(colourDimensions([dim("a"), dim("b")]), [dim("a"), dim("b")]);
  assert.deepEqual(colourDimensions([num("q"), dim("a")]), []);
  assert.deepEqual(colourDimensions([dim("a"), num("q")]), [dim("a")]);
  assert.deepEqual(colourDimensions(undefined), []);
});
test("the combined member is the names joined with ' · '; its colour key and member key are unambiguous even when a name holds ' · '", () => {
  assert.equal(memberText(["EU", "web"]), "EU · web"); assert.equal(memberText(["EU", null]), "EU · —");
  const a = memberRaw(["a · b", "c"]), b = memberRaw(["a", "b · c"]);
  assert.notEqual(a, b);
  assert.equal(memberRaw([1, null]), '["1",null]');
  const f = combinedField([dim("region"), dim("channel")]);
  assert.equal(fieldColorKey(f), '["t.region","t.channel"]');
  assert.notEqual(fieldColorKey(f), fieldColorKey(combinedField([dim("channel"), dim("region")])));
  assert.equal(fieldColorKey(dim("region")), "t.region", "a single field's key is unchanged");
  const map = { [fieldColorKey(f)]: { [memberKey(a)]: "#112233" } };
  assert.deepEqual([...colorsByName(map[fieldColorKey(f)], [{ name: "a · b · c", raw: a }, { name: "a · b · c", raw: b }])], [["a · b · c", "#112233"]]);
  assert.ok(fieldColorKey(combinedField([dim("x".repeat(40)), dim("y".repeat(40)), dim("z".repeat(40))])).length <= LIMITS.memberField, "three long names still fit the stored key");
});
test("the plan: every categorical Colour field is a group-by, last and in order; Gantt and Table use the first only; a measure first means no keys", () => {
  const cols = [dim("a"), dim("b")];
  for (const type of ["bar", "stacked", "line", "area", "scatter", "square", "circle"]) {
    const s = sheet({ chartType: type, columns: [dim("region")], rows: [num("amount")], color: cols });
    const keys = planDims(s).keyOrder.map((f) => f.column);
    assert.deepEqual(keys.slice(-2), ["a", "b"], type);
    assert.equal(planDims(s).colourDims.length, 2, type);
  }
  for (const type of ["gantt", "table"]) assert.equal(planDims(sheet({ chartType: type, color: cols })).colourDims.length, 1, `${type} uses the first only`);
  assert.equal(planDims(sheet({ chartType: "bar", color: [num("q"), dim("a")] })).colourDims.length, 0);
  assert.equal(planDims(sheet({ chartType: "treemap", color: cols })).colourDims.length, 0, "a chart that ignores Colour sends no key");
  assert.ok(MULTI_COLOUR_TYPES.has("pie") && COLOR_USES.has("pie") && COLOR_USES.has("donut"));
  assert.deepEqual(colourDimsOf(sheet({ chartType: "bar", color: cols })), cols);
});
test("scatter: Colour equal to the one Shape field is grouped once (as before); with several Colour fields the Shape field stays its own key", () => {
  const s1 = sheet({ chartType: "scatter", color: [dim("a")], marks: { ...emptySheet("S").marks, shape: dim("a") } });
  assert.equal(planDims(s1).colourDims.length, 0, "one grouping carries both");
  const s2 = sheet({ chartType: "scatter", color: [dim("a"), dim("b")], marks: { ...emptySheet("S").marks, shape: dim("a") } });
  assert.equal(planDims(s2).colourDims.length, 2);
});
test("the query cap counts every Colour field: a drop that pushes the group-by past 12 is refused, a measure there does not count as a dimension", () => {
  const many = Array.from({ length: 10 }, (_, i) => dim(`c${i}`));
  const s = sheet({ columns: many });
  assert.equal(viewCounts({ ...s, color: [dim("a"), dim("b")] }).dims, 12);
  const r = checkAdd({ ...s, color: [dim("a")] }, "color", dim("b"), "dimension");
  assert.equal(r.ok, true, "11 fields in all");
  const r2 = checkAdd({ ...s, color: [dim("a"), dim("b")] }, "color", dim("c"), "dimension");
  assert.equal(r2.ok, false); assert.match(r2.error, /at most 12/);
  assert.equal(viewCounts({ ...s, color: [num("q")] }).dims, 10);
});
test("import: dimensions are kept up to the cap in order; a measure beside dimensions is dropped; a leading measure keeps only itself; reported, never coerced", () => {
  const dims = ["a", "b", "c", "d"].map((c) => dim(c));
  const issues = [];
  const s = sanitizeSheet({ ...emptySheet("S"), color: dims }, "S", issues);
  assert.deepEqual(s.color.map((f) => f.column), ["a", "b", "c"]); assert.ok(issues.some((i) => /Colour|color/i.test(i)));
  const i2 = []; const m = sanitizeSheet({ ...emptySheet("S"), color: [num("q"), dim("a")] }, "S", i2);
  assert.deepEqual(m.color.map((f) => f.column), ["q"]); assert.ok(i2.length >= 1);
  const i3 = []; const x = sanitizeSheet({ ...emptySheet("S"), color: [dim("a"), num("q"), dim("b")] }, "S", i3);
  assert.deepEqual(x.color.map((f) => f.column), ["a", "b"]);
  const i4 = []; const ok = sanitizeSheet({ ...emptySheet("S"), color: [dim("a"), dim("b")] }, "S", i4);
  assert.equal(ok.color.length, 2); assert.equal(i4.length, 0, "an ordinary pair is clean");
  const dup = []; assert.deepEqual(sanitizeSheet({ ...emptySheet("S"), color: [dim("a"), dim("a")] }, "S", dup).color.length, 1); assert.ok(dup.length >= 1);
  assert.deepEqual(cleanColourList([dim("a")]).issues, []);
});

test("a combination whose field key would not survive a reload is refused when the colour is set, with a message (import drops keys over the limit)", () => {
  const long = (c) => dim(c.repeat(40), c.repeat(40));
  const f = combinedField([long("a"), long("b"), long("c")]);
  assert.ok(fieldColorKey(f).length > LIMITS.memberField, "three 40 + 40 character fields exceed the stored key's limit");
  const r = setMemberColor({}, fieldColorKey(f), memberRaw(["x", "y", "z"]), "#112233");
  assert.equal(r.ok, false); assert.match(r.error, /too long/);
  const ok = setMemberColor({}, fieldColorKey(combinedField([dim("region"), dim("channel")])), memberRaw(["EU", "web"]), "#112233");
  assert.equal(ok.ok, true, "ordinary names are fine");
  const issues = [];
  assert.equal(Object.keys(cleanMemberColors({ [fieldColorKey(f)]: { m: "#112233" } }, "S", issues)).length, 0, "and import would have dropped it");
  assert.equal(issues.length, 1);
});
