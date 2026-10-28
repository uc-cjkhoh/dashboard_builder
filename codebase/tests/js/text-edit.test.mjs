import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTextEdit, textChanged } from "../../src/DashboardBuilder/Features/Board/text-edit.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

test("valid text is trimmed and accepted; an empty heading and an empty body are allowed", () => {
  assert.deepEqual(validateTextEdit({ heading: "  Q3  ", body: " notes\nline two " }), { ok: true, value: { heading: "Q3", body: "notes\nline two" } });
  assert.deepEqual(validateTextEdit({ heading: "", body: "" }), { ok: true, value: { heading: "", body: "" } });
});
test("exactly at the limits is accepted; one over is refused per field", () => {
  assert.equal(validateTextEdit({ heading: "h".repeat(LIMITS.widgetHeading), body: "b".repeat(LIMITS.widgetBody) }).ok, true);
  const r = validateTextEdit({ heading: "h".repeat(LIMITS.widgetHeading + 1), body: "b".repeat(LIMITS.widgetBody + 1) });
  assert.equal(r.ok, false);
  assert.equal(r.errors.heading, "The heading must be at most 80 characters.");
  assert.equal(r.errors.body, "The text must be at most 2000 characters.");
  assert.deepEqual(Object.keys(validateTextEdit({ heading: "ok", body: "b".repeat(2001) }).errors), ["body"]);
});
test("textChanged: an unchanged save is not a step", () => {
  const w = { heading: "A", body: "B" };
  assert.equal(textChanged(w, { heading: "A", body: "B" }), false);
  assert.equal(textChanged(w, { heading: "A2", body: "B" }), true);
  assert.equal(textChanged(w, { heading: "A", body: "" }), true);
  assert.equal(textChanged({ heading: "A" }, { heading: "A", body: "" }), false);
});
