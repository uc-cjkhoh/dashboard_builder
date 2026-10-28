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

test("the plain aggregations and the calculation functions agree with the server whitelists", async () => {
  const { CALC_AGGS } = await import("../../src/DashboardBuilder/Features/Calc/calc-pill.js");
  const { AGGS } = await import("../../src/DashboardBuilder/Features/Dashboard/filter-rules.js");
  const { FUNCTIONS } = await import("../../src/DashboardBuilder/Features/Calc/calc-types.js");
  const gateway = readFileSync(new URL("../../src/DashboardBuilder/ClickHouse/ClickHouseGateway.cs", import.meta.url), "utf8");
  const set = (src, re) => new Set([...src.match(re)[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
  const rowLevel = set(csharp, /RowLevelAggregations =[^{]*\{([^}]*)\}/);
  assert.deepEqual(new Set(CALC_AGGS.map((a) => a.toLowerCase())), rowLevel);
  const plain = set(gateway, /Aggregations =\s*new\([^)]*\) \{([^}]*)\}/);
  assert.deepEqual(new Set(AGGS.numeric.map((a) => a.toLowerCase())), plain);
  const fns = new Set([...csharp.matchAll(/\["([a-z]+)"\] = new\(/g)].map((m) => m[1]));
  assert.deepEqual(new Set(Object.keys(FUNCTIONS)), fns);
  assert.deepEqual(Object.keys(FUNCTIONS).filter((k) => FUNCTIONS[k].fraction), ["percentile"]);
});
