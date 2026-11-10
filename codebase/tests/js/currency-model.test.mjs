import { test } from "node:test";
import assert from "node:assert/strict";
import { CURRENCY_CHOICES, currencyError, currencyChoice, DEFAULT_CURRENCY } from "../../src/DashboardBuilder/Features/Dashboard/currency-model.js";
import { makeValueFormatter } from "../../src/DashboardBuilder/Features/Core/format.js";

test("the short list starts with $ and offers custom", () => {
  assert.equal(DEFAULT_CURRENCY, "$");
  assert.deepEqual(CURRENCY_CHOICES.map(([v]) => v), ["$", "€", "£", "¥", "RM", "S$", "custom"]);
});
test("a custom symbol is 1-3 visible characters", () => {
  assert.equal(currencyError("Fr"), null);
  assert.equal(currencyError("CHF"), null);
  assert.match(currencyError(""), /1.*3/);
  assert.match(currencyError("ABCD"), /1.*3/);
  assert.match(currencyError("a\nb"), /visible/);
});
test("which select value a stored symbol shows", () => {
  assert.equal(currencyChoice("€"), "€");
  assert.equal(currencyChoice("CHF"), "custom");
  assert.equal(currencyChoice(undefined), "$");
});
test("the formatter uses the chosen symbol, $ by default", () => {
  assert.equal(makeValueFormatter({ numberFormat: "currency", decimals: 0 })(5), "$5");
  assert.equal(makeValueFormatter({ numberFormat: "currency", currencySymbol: "RM", decimals: 0 })(5), "RM5");
});
