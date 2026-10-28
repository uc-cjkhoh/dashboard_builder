// The calculation limits live in three places (server CalcLimits, client CALC_LIMITS, form LIMITS): keep them equal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CALC_LIMITS } from "../../src/DashboardBuilder/Features/Calc/calc-types.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

const csharp = readFileSync(new URL("../../src/DashboardBuilder/ClickHouse/Calc/CalcCatalog.cs", import.meta.url), "utf8");
const server = (name) => {
  const m = csharp.match(new RegExp(`public const int ${name}\\s*=\\s*(\\d+);`));
  assert.ok(m, `CalcLimits.${name} not found in CalcCatalog.cs`);
  return Number(m[1]);
};

test("CalcLimits (C#), CALC_LIMITS (calc-types.js) and LIMITS (validate.js) agree", () => {
  assert.equal(CALC_LIMITS.formula, server("MaxFormula"));
  assert.equal(CALC_LIMITS.depth, server("MaxDepth"));
  assert.equal(CALC_LIMITS.nodes, server("MaxNodes"));
  assert.equal(CALC_LIMITS.calcs, server("MaxCalcs"));
  assert.equal(CALC_LIMITS.name, server("MaxName"));
  assert.equal(CALC_LIMITS.string, server("MaxString"));
  assert.equal(LIMITS.calcFormula, CALC_LIMITS.formula);
  assert.equal(LIMITS.calculations, CALC_LIMITS.calcs);
  assert.equal(LIMITS.calcName, CALC_LIMITS.name);
});
