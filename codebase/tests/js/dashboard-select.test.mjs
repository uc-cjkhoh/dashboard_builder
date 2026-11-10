import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSelection, selectionRefusal, crossFilterOf, appliesTo, selectedIndicesOf, UNSELECTABLE_NOTE, chipText, notAppliedNote, crossFor, crossSignature, stillValid }
  from "../../src/DashboardBuilder/Features/Dashboard/dashboard-select.js";
import { keyOf } from "../../src/DashboardBuilder/Features/Dashboard/sheet-plan.js";

// The dashboard's one transient selection: derived from a mark click, never saved. Pure — no DOM, no store.
const field = { db: "shop", table: "customers", column: "country", category: "text" };
const DE = nextSelection(null, field, "DE", String, "w#1");

test("a click selects the primary dimension's value, labelled like the worksheet's own selection chip", () => {
  assert.deepEqual(DE, { db: "shop", table: "customers", column: "country", value: "DE", label: "customers.country = DE", sourceWidgetId: "w#1" });
});
test("the same mark in the same widget clears; another value or another widget replaces", () => {
  assert.equal(nextSelection(DE, field, "DE", String, "w#1"), null);
  assert.equal(nextSelection(DE, field, "FR", String, "w#1").value, "FR");
  assert.equal(nextSelection(DE, field, "DE", String, "w#2").sourceWidgetId, "w#2");
});
test("a null or undefined mark is a no-op (the same object back)", () => {
  assert.equal(nextSelection(DE, field, null, String, "w#1"), DE);
  assert.equal(nextSelection(null, field, undefined, String, "w#1"), null);
});
test("values of every field category keep their raw value; the label uses the category formatter", () => {
  const num = nextSelection(null, { db: "shop", table: "orders", column: "qty", category: "numeric" }, 3, String, "w#1");
  assert.equal(num.value, 3);
  const date = nextSelection(null, { db: "shop", table: "orders", column: "placed", category: "temporal" }, "2024-03-05", (v) => `D:${v}`, "w#1");
  assert.equal(date.label, "orders.placed = D:2024-03-05");
  assert.equal(crossFilterOf(date).value, "2024-03-05");
  assert.equal(nextSelection(null, field, "", String, "w#1").value, "", "an empty string is a member, not a null");
  assert.equal(crossFilterOf(nextSelection(null, field, "", String, "w#1")).value, "");
});
test("a calculated primary dimension is refused with the calculated-field message; a plain field is not", () => {
  assert.match(selectionRefusal({ calc: "c1", db: "", table: "", column: "x" }), /calculat/i);
  assert.equal(selectionRefusal(field), null);
});
test("the cross filter is a bound `=` filter of the same shape the worksheet's own selection filter has", () => {
  assert.deepEqual(crossFilterOf(DE), { db: "shop", table: "customers", column: "country", op: "=", value: "DE", values: null });
  assert.equal(crossFilterOf(nextSelection(null, field, 12, String, "w#1")).value, "12", "numbers are sent as strings, as the editor does");
});
test("appliesTo: only when the selected column's table is already in the widget's query", () => {
  assert.equal(appliesTo([keyOf("shop", "customers"), keyOf("shop", "orders")], DE), true);
  assert.equal(appliesTo([keyOf("shop", "orders")], DE), false);
  assert.equal(appliesTo([keyOf("other", "customers")], DE), false, "same table name in another database");
  assert.equal(appliesTo([keyOf("shop", "customers")], null), false);
});
test("selectedIndicesOf finds every mark of the selected value (strings compared as strings)", () => {
  assert.deepEqual(selectedIndicesOf(["DE", "FR", null], DE, field), [0]);
  assert.deepEqual(selectedIndicesOf([1, 2], { ...DE, value: 2 }, field), [1]);
  assert.deepEqual(selectedIndicesOf(["DE", "FR", "DE", null, "DE"], DE, field), [0, 2, 4], "two row dimensions: several marks share the primary value");
  assert.deepEqual(selectedIndicesOf([null, "US"], DE, field), []);
  assert.deepEqual(selectedIndicesOf(["DE"], null, field), []);
  assert.deepEqual(selectedIndicesOf(["DE"], DE, { ...field, column: "city" }), [], "another column's value is not this mark");
  assert.deepEqual(selectedIndicesOf([null, undefined], { ...DE, value: "null" }, field), []);
  assert.match(UNSELECTABLE_NOTE, /NULL.*Other/);
});
test("chip and not-applied texts", () => {
  assert.equal(chipText(DE), "Filtering by customers.country = DE");
  assert.equal(notAppliedNote(DE), "Not filtered: this sheet doesn't use customers.");
});
test("crossFor: the source gets a highlight, every other widget the filter, nothing when no selection", () => {
  assert.equal(crossFor(null, "w#1"), null);
  assert.deepEqual(crossFor(DE, "w#1"), { selected: DE });
  assert.deepEqual(crossFor(DE, "w#2"), { filter: DE });
});
test("crossSignature tells a widget whether anything it shows would change", () => {
  const inV = [keyOf("shop", "customers")], outV = [keyOf("shop", "orders")];
  const FR = nextSelection(null, field, "FR", String, "w#1");
  assert.notEqual(crossSignature({ filter: DE }, inV), crossSignature({ filter: FR }, inV));
  assert.notEqual(crossSignature({ filter: DE }, inV), crossSignature(null, inV));
  assert.equal(crossSignature({ filter: DE }, outV), crossSignature({ filter: FR }, outV), "an unreachable widget shows the same note for either value");
  assert.notEqual(crossSignature({ filter: DE }, outV), crossSignature(null, outV));
  assert.notEqual(crossSignature({ selected: DE }, inV), crossSignature({ selected: FR }, inV));
});
test("stillValid: the selection survives only while its source's primary dimension is still the selected column", () => {
  const s = (rows) => ({ rows, columns: [], drill: null });
  assert.equal(stillValid(DE, s([{ ...field, role: "dimension" }])), true);
  assert.equal(stillValid(DE, s([{ ...field, column: "city", role: "dimension" }])), false);
  assert.equal(stillValid(DE, s([])), false);
  assert.equal(stillValid(null, s([])), true);
});
