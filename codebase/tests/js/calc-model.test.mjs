// Calculated fields — calculation references expanded into one tree, and the pill role of a calculation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandCalcs, roleOfCalc } from "../../src/DashboardBuilder/Features/Calc/calc-model.js";
import { check } from "../../src/DashboardBuilder/Features/Calc/calc-types.js";

const field = (table, column) => ({ k: "field", db: "shop", table, column });
const num = (v) => ({ k: "num", v });
const calc = (name) => ({ k: "calc", name });
const bin = (op, l, r) => ({ k: "bin", op, l, r });
const agg = (fn, arg) => ({ k: "agg", fn, arg });
const calcs = (obj) => new Map(Object.entries(obj).map(([name, ast]) => [name, { ast }]));

test("expands a reference into the calculation's tree", () => {
  const a = bin("*", field("orders", "amount"), num(2));
  const r = expandCalcs(agg("sum", calc("A")), calcs({ A: a }));
  assert.deepEqual(r, { ast: agg("sum", bin("*", field("orders", "amount"), num(2))) });
});

test("expands references inside references, and a tree with none comes back equal", () => {
  const map = calcs({ A: bin("*", field("orders", "amount"), num(2)), B: bin("+", calc("A"), num(1)) });
  const r = expandCalcs(agg("sum", calc("B")), map);
  assert.deepEqual(r, { ast: agg("sum", bin("+", bin("*", field("orders", "amount"), num(2)), num(1))) });
  const plain = agg("sum", field("orders", "amount"));
  assert.deepEqual(expandCalcs(plain, new Map()), { ast: plain });
});

test("never mutates its inputs and returns fresh nodes", () => {
  const a = bin("*", field("orders", "amount"), num(2));
  const top = agg("sum", calc("A"));
  const map = calcs({ A: a });
  const topCopy = structuredClone(top);
  const aCopy = structuredClone(a);
  const r = expandCalcs(top, map);
  assert.deepEqual(top, topCopy);
  assert.deepEqual(a, aCopy);
  assert.notEqual(r.ast.arg, a);
  assert.notEqual(r.ast.arg.l, a.l);
  // the same calculation used twice yields two independent subtrees
  const twice = expandCalcs(bin("+", calc("A"), calc("A")), map).ast;
  assert.notEqual(twice.l, twice.r);
  assert.deepEqual(twice.l, twice.r);
});

test("the expanded tree is what check() accepts", () => {
  const r = expandCalcs(agg("sum", calc("A")), calcs({ A: bin("*", field("orders", "amount"), num(2)) }));
  const t = check(r.ast, () => "numeric");
  assert.deepEqual(t, { type: "number", isAggregate: true, tables: ["shop.orders"] });
});

test("an unknown calculation is an error", () => {
  assert.deepEqual(expandCalcs(agg("sum", calc("Ghost")), new Map()), { error: { message: "Unknown calculation [Ghost]." } });
  assert.deepEqual(expandCalcs(calc("A"), calcs({ A: calc("Gone") })), { error: { message: "Unknown calculation [Gone]." } });
});

test("a self-reference is a cycle", () => {
  const r = expandCalcs(calc("A"), calcs({ A: bin("+", calc("A"), num(1)) }));
  assert.deepEqual(r, { error: { message: "Calculation 'A' refers to itself (A → A)." } });
});

test("A -> B -> A is a cycle, named from the first calculation expanded", () => {
  const map = calcs({ A: bin("+", calc("B"), num(1)), B: bin("*", calc("A"), num(2)) });
  assert.deepEqual(expandCalcs(calc("A"), map), { error: { message: "Calculation 'A' refers to itself (A → B → A)." } });
  assert.deepEqual(expandCalcs(agg("sum", calc("B")), map), { error: { message: "Calculation 'B' refers to itself (B → A → B)." } });
});

test("a tail leading into a cycle reports only the cycle", () => {
  const map = calcs({ T: calc("A"), A: calc("B"), B: calc("A") });
  assert.deepEqual(expandCalcs(calc("T"), map), { error: { message: "Calculation 'A' refers to itself (A → B → A)." } });
});

test("a diamond (the same calculation reached twice) is not a cycle", () => {
  const map = calcs({ A: field("orders", "amount"), B: calc("A"), C: calc("A") });
  assert.deepEqual(expandCalcs(bin("+", calc("B"), calc("C")), map), { ast: bin("+", field("orders", "amount"), field("orders", "amount")) });
});

test("an expansion over 200 nodes is too large", () => {
  // each calc doubles the tree: 1 + 1 + 2*... nodes; 8 levels is far over 200
  const map = new Map();
  map.set("C0", { ast: field("orders", "amount") });
  for (let i = 1; i <= 8; i++) map.set(`C${i}`, { ast: bin("+", calc(`C${i - 1}`), calc(`C${i - 1}`)) });
  assert.deepEqual(expandCalcs(calc("C8"), map), { error: { message: "That formula is too large." } });
});

test("a tree of exactly 200 nodes is allowed, 201 is not", () => {
  // a left-leaning chain of n additions has 2n + 1 nodes
  const chain = (n) => { let t = num(1); for (let i = 0; i < n; i++) t = bin("+", t, num(1)); return t; };
  const map = calcs({ Big: chain(99) }); // 199 nodes
  const un = (arg) => ({ k: "un", op: "-", arg });
  assert.ok(expandCalcs(un(calc("Big")), map).ast); // 199 + 1 = 200
  assert.deepEqual(expandCalcs(bin("+", calc("Big"), num(1)), map), { error: { message: "That formula is too large." } }); // 201
});

test("a very long chain of calculations stops instead of blowing the stack", () => {
  const map = new Map();
  const n = 100000;
  for (let i = 0; i < n; i++) map.set(`C${i}`, { ast: calc(`C${i + 1}`) });
  map.set(`C${n}`, { ast: num(1) });
  const r = expandCalcs(calc("C0"), map);
  assert.deepEqual(r, { error: { message: "That formula is too large." } });
});

test("roles: aggregates and row-level numbers are measures, row-level text/date/boolean are dimensions", () => {
  assert.equal(roleOfCalc({ type: "number", isAggregate: true }), "measure");
  assert.equal(roleOfCalc({ type: "text", isAggregate: true }), "measure");
  assert.equal(roleOfCalc({ type: "number", isAggregate: false }), "measure");
  assert.equal(roleOfCalc({ type: "text", isAggregate: false }), "dimension");
  assert.equal(roleOfCalc({ type: "date", isAggregate: false }), "dimension");
  assert.equal(roleOfCalc({ type: "boolean", isAggregate: false }), "dimension");
});

test("the override only applies to a row-level number", () => {
  assert.equal(roleOfCalc({ type: "number", isAggregate: false }, "dimension"), "dimension");
  assert.equal(roleOfCalc({ type: "number", isAggregate: false }, "measure"), "measure");
  assert.equal(roleOfCalc({ type: "number", isAggregate: true }, "dimension"), "measure");
  assert.equal(roleOfCalc({ type: "text", isAggregate: false }, "measure"), "dimension");
  assert.equal(roleOfCalc({ type: "date", isAggregate: false }, "measure"), "dimension");
  assert.equal(roleOfCalc({ type: "number", isAggregate: false }, null), "measure");
  assert.equal(roleOfCalc({ type: "number", isAggregate: false }, "bogus"), "measure");
});

// ---- Logic nodes (cmp / logic / not / case / ifnull / isnull) are expanded like any other ---------------------
import { parseFormula as parseLogic } from "../../src/DashboardBuilder/Features/Calc/calc-parser.js";
test("expandCalcs: a calc reference inside CASE / IF / IFNULL / NOT / comparison is replaced, the input is not mutated", () => {
  const inner = { ast: { k: "num", v: 7 } };
  const ref = { k: "calc", name: "X" };
  const ast = { k: "case", whens: [{ c: { k: "not", arg: { k: "cmp", op: ">", l: ref, r: { k: "num", v: 1 } } }, t: { k: "ifnull", l: ref, r: ref } }], else: ref };
  const before = JSON.stringify(ast);
  const out = expandCalcs(ast, new Map([["X", inner]]));
  assert.equal(JSON.stringify(ast), before);
  assert.ok(!JSON.stringify(out.ast).includes('"calc"'));
  assert.equal(out.ast.else.v, 7);
  assert.equal(out.ast.whens[0].t.r.v, 7);
});
test("expandCalcs: a CASE expansion over the node cap is 'too large'", () => {
  const w = { c: { k: "num", v: 1 }, t: { k: "num", v: 1 } };
  const ast = { k: "case", whens: Array.from({ length: 100 }, () => w) };
  assert.equal(expandCalcs(ast, new Map()).error.message, "That formula is too large.");
});
test("the parser: ZN, IIF and simple CASE desugar to the shared nodes", () => {
  const none = () => null;
  assert.deepEqual(parseLogic("ZN(1)", none).ast, { k: "ifnull", l: { k: "num", v: 1 }, r: { k: "num", v: 0 } });
  assert.deepEqual(parseLogic("iif(1 > 0, 'a', 'b')", none).ast.k, "case");
  assert.equal(parseLogic("CASE 1 WHEN 2 THEN 3 END", none).ast.whens[0].c.op, "=");
});

test("expands a reference inside an IN node (arg and list) and leaves the input untouched", () => {
  const A = field("orders", "qty");
  const tree = { k: "in", arg: calc("A"), list: [num(1), num(2)] };
  const r = expandCalcs(tree, calcs({ A }));
  assert.deepEqual(r, { ast: { k: "in", arg: A, list: [num(1), num(2)] } });
  assert.equal(tree.arg.k, "calc");
});
