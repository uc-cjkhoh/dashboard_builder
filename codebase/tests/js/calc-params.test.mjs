// Parameters in calculated fields: [@Name] parse, resolve, substitute (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFormula } from "../../src/DashboardBuilder/Features/Calc/calc-parser.js";
import { catalogFromEntities, makeResolve, compileCalculation } from "../../src/DashboardBuilder/Features/Calc/calc-resolve.js";
import { substituteParams, paramRefs, renameParamInFormulas, calcsUsingParam, PARAM_TEXT_MAX } from "../../src/DashboardBuilder/Features/Calc/calc-params.js";
import { suggest } from "../../src/DashboardBuilder/Features/Calc/calc-dialog-model.js";
import { wireDim, wireMeasure, calcProblem } from "../../src/DashboardBuilder/Features/Calc/calc-plan.js";
import { paneState } from "../../src/DashboardBuilder/Features/Calc/calc-pane-model.js";

const entities = [{ id: "e1", db: "shop", table: "orders", columns: [
  { name: "amount", category: "numeric" }, { name: "status", category: "text" }, { name: "placed", category: "temporal" }] }];
const catalog = catalogFromEntities(entities);
const P = (id, name, type, value) => ({ id, name, type, value, allowed: { kind: "any" } });
const params = [P("prm1", "Rate", "number", 0.2), P("prm2", "Region", "text", "it's é 東京"), P("prm3", "Since", "date", "2026-02-28"), P("prm4", "Off", "number", -3)];
const calc = (id, name, formula) => ({ id, name, formula });
const compile = (formula, ps = params, others = []) => compileCalculation(calc("c9", "X", formula), others, catalog, ps);

test("parser: [@Name] is its own reference kind, never split on dots", () => {
  const seen = [];
  const r = parseFormula("[@Tax.rate] * 2", (parts, kind) => { seen.push([parts, kind]); return { param: { name: parts[0] } }; });
  assert.deepEqual(r.ast, { k: "bin", op: "*", l: { k: "param", name: "Tax.rate" }, r: { k: "num", v: 2 } });
  assert.deepEqual(seen, [[["Tax.rate"], "param"]]);
  assert.equal(parseFormula("[@]", () => null).error.message, "Write the parameter as [@Name].");
  assert.equal(parseFormula("[@ ]", () => null).error.message, "Write the parameter as [@Name].");
});

test("resolver: unknown / deleted parameter is a resolver error; [Name] never means a parameter", () => {
  const resolve = makeResolve(catalog, new Set(["Net"]), params);
  assert.deepEqual(resolve(["Rate"], "param"), { param: { name: "Rate" } });
  assert.match(resolve(["Gone"], "param").error, /Parameter \[@Gone\] was deleted or doesn't exist/);
  assert.equal(resolve(["Rate"]), null); // [Rate] stays "a field missing its table"
  assert.equal(makeResolve(catalog, new Set()) (["Rate"], "param").error.includes("Gone") , false);
});

test("compile: number, negative number, text, date parameters become literals", () => {
  assert.deepEqual(compile("[@Rate]").ast, { k: "num", v: 0.2 });
  assert.deepEqual(compile("[@Off]").ast, { k: "un", op: "-", arg: { k: "num", v: 3 } });
  const t = compile("[@Region]");
  assert.deepEqual(t.ast, { k: "str", v: "it's é 東京" });
  assert.equal(t.info.type, "text");
  const d2 = compile("DATEDIFF('day', [@Since], [orders.placed])");
  assert.equal(d2.error, undefined);
  assert.deepEqual(d2.ast.args[1], { k: "fn", fn: "date", args: [{ k: "str", v: "2026-02-28" }] });
  const e = compile("SUM([orders.amount]) * [@Rate]");
  assert.equal(e.info.isAggregate, true);
  assert.deepEqual(e.ast.r, { k: "num", v: 0.2 });
});

test("compile: a changed value changes the tree (so the request JSON and cache key change)", () => {
  const a = JSON.stringify(compile("[orders.amount] * [@Rate]").ast);
  const b = JSON.stringify(compile("[orders.amount] * [@Rate]", [P("prm1", "Rate", "number", 0.3)]).ast);
  assert.notEqual(a, b);
  assert.ok(b.includes("0.3"));
});

test("compile: errors", () => {
  assert.match(compile("[@Gone] + 1").error.message, /^Calculation 'X' can't be computed: Parameter \[@Gone\] was deleted/);
  assert.match(compile("[@Region] + 1").error.message, /needs numbers/); // text in arithmetic
  assert.match(compile("LEN([@Rate])").error.message, /needs a text/);    // number as text
  assert.match(compile("YEAR([@Region])").error.message, /needs a date/);
  const long = [P("prm1", "Big", "text", "x".repeat(PARAM_TEXT_MAX + 1))];
  assert.match(compile("[@Big]", long).error.message, /at most 100 characters/);
  assert.equal(compile("[@Big]", [P("prm1", "Big", "text", "x".repeat(PARAM_TEXT_MAX))]).error, undefined);
  assert.match(compile("[@Rate]", [P("prm1", "Rate", "number", NaN)]).error.message, /isn't a usable number/);
  assert.match(compile("[@Since]", [P("prm3", "Since", "date", "nope")]).error.message, /isn't a date/);
  assert.match(compile("[@Rate]", null).error.message, /was deleted/);
});

test("compile: a calculation that reads a calculation that reads a parameter", () => {
  const net = calc("c1", "Net", "[orders.amount] * [@Rate]");
  const r = compileCalculation(calc("c2", "Gross", "SUM([Net])"), [net], catalog, params);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.ast.arg.r, { k: "num", v: 0.2 });
  const gone = compileCalculation(calc("c2", "Gross", "SUM([Net])"), [net], catalog, []);
  assert.match(gone.error.message, /Parameter \[@Rate\] was deleted/);
});

test("substituteParams: never mutates the input; no param node survives", () => {
  const ast = { k: "bin", op: "+", l: { k: "param", name: "Rate" }, r: { k: "num", v: 1 } };
  const copy = structuredClone(ast);
  const out = substituteParams(ast, params);
  assert.deepEqual(ast, copy);
  assert.ok(!JSON.stringify(out.ast).includes("param"));
});

test("formula helpers: refs, rename, usage", () => {
  assert.deepEqual(paramRefs("[@Rate] + [orders.amount] + [@Rate] + [@Off]"), ["Rate", "Off"]);
  assert.deepEqual(paramRefs("'[@Rate]'"), ["Rate"]); // text scanning is deliberately conservative: a delete asks first
  const cs = [calc("c1", "A", "[@Rate]*2"), calc("c2", "B", "[Rate]")];
  assert.deepEqual(calcsUsingParam(cs, "Rate"), ["A"]);
  assert.deepEqual(renameParamInFormulas(cs, "Rate", "Tax").map((c) => c.formula), ["[@Tax]*2", "[Rate]"]);
});

test("autocomplete: parameters are offered after [@ only", () => {
  const ctx = { calcs: [], catalog, params };
  const at = suggest("[@", 2, ctx);
  assert.deepEqual(at.items.map((i) => i.label), ["Rate", "Region", "Since", "Off"]);
  assert.equal(at.items[0].kind, "param");
  assert.equal(at.from, 2);
  assert.deepEqual(suggest("[@R", 3, ctx).items.map((i) => i.label), ["Rate", "Region"]);
  assert.ok(!suggest("[", 1, ctx).items.some((i) => i.kind === "param"));
  assert.ok(!suggest("[or", 3, ctx).items.some((i) => i.kind === "param"));
});

test("plan: the compiled tree carries the literal; a deleted parameter is the E15 state with no query", () => {
  const c = calc("c1", "Taxed", "[orders.amount] * [@Rate]");
  const f = { calc: "c1", column: "Taxed", category: "numeric", role: "measure", agg: "sum" };
  const ctx = { calcs: [c], catalog, params };
  assert.deepEqual(wireMeasure({ field: f, agg: "sum" }, ctx).calc.r, { k: "num", v: 0.2 });
  assert.equal(calcProblem({ rows: [f], columns: [], filters: [] }, ctx), null);
  const gone = calcProblem({ rows: [f], columns: [], filters: [] }, { ...ctx, params: [] });
  assert.match(gone, /^Calculation 'Taxed' can't be computed: Parameter \[@Rate\] was deleted/);
});

test("pane: a calculation on a deleted parameter shows its error", () => {
  const c = calc("c1", "Taxed", "[orders.amount] * [@Rate]");
  assert.equal(paneState([c], catalog, params).items[0].error, null);
  assert.match(paneState([c], catalog, []).items[0].error, /was deleted/);
});

import { calcParamNames } from "../../src/DashboardBuilder/Features/Calc/calc-params.js";
import { refConstant } from "../../src/DashboardBuilder/Features/Dashboard/analytics-model.js";

test("calcParamNames follows calculation references, cuts cycles", () => {
  const cs = [calc("c1", "A", "[B] + [@Rate]"), calc("c2", "B", "[@Off] * [A]"), calc("c3", "C", "1")];
  assert.deepEqual(calcParamNames(cs, "c1").sort(), ["Off", "Rate"]);
  assert.deepEqual(calcParamNames(cs, "c3"), []);
  assert.deepEqual(calcParamNames(cs, "nope"), []);
});

test("reference line: a bound number parameter wins; a gone or non-number one falls back", () => {
  assert.equal(refConstant({ kind: "constant", value: 5, param: "prm1" }, params), 0.2);
  assert.equal(refConstant({ kind: "constant", value: 5, param: "prm9" }, params), 5);
  assert.equal(refConstant({ kind: "constant", value: 5, param: "prm2" }, params), 5); // text parameter
  assert.equal(refConstant({ kind: "constant", value: 5 }, params), 5);
});

import { parameters as storeParams, calculations as storeCalcs, setParameters, setCalculations, updateParameter } from "../../src/DashboardBuilder/Features/Core/store.js";
test("store: renaming a parameter rewrites [@Old] in formulas (and only those); the value change keeps formulas", () => {
  setParameters([P("prm1", "Rate", "number", 1)]);
  setCalculations([calc("calc1", "A", "[x.y] * [@Rate]"), calc("calc2", "B", "[Rate] + [@Rates]")]);
  updateParameter("prm1", { value: 2 });
  assert.equal(storeCalcs[0].formula, "[x.y] * [@Rate]");
  updateParameter("prm1", { name: "Tax" });
  assert.deepEqual(storeCalcs.map((c) => c.formula), ["[x.y] * [@Tax]", "[Rate] + [@Rates]"]);
  assert.equal(storeParams[0].name, "Tax");
  setParameters([]); setCalculations([]);
});
