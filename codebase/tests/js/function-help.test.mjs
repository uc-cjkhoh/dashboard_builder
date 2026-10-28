// Calculated fields — function glossary (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FUNCTION_HELP, CATALOG_NAMES, TEXT_NAMES, GROUPS, DATEADD_WINDOW, searchHelp, groupHelp, functionItems } from "../../src/DashboardBuilder/Features/Calc/function-help.js";
import { readFileSync } from "node:fs";
import { evaluateDraft, suggest } from "../../src/DashboardBuilder/Features/Calc/calc-dialog-model.js";
import { catalogFromEntities } from "../../src/DashboardBuilder/Features/Calc/calc-resolve.js";
import { FUNCTIONS, ROW_FUNCTIONS } from "../../src/DashboardBuilder/Features/Calc/calc-types.js";

const col = (name, category) => ({ name, category });
const catalog = catalogFromEntities([
  { id: "e1", db: "shop", table: "orders", columns: [col("amount", "numeric"), col("qty", "numeric"), col("status", "text"), col("region", "text"), col("placed", "temporal")] },
]);
const ctx = { calcs: [], catalog };

test("the glossary and the type tables name exactly the same functions", () => {
  const help = FUNCTION_HELP.map((h) => h.name).sort();
  assert.deepEqual(help, [...CATALOG_NAMES].sort());
  assert.equal(new Set(help).size, help.length);
  for (const n of [...Object.keys(FUNCTIONS), ...Object.keys(ROW_FUNCTIONS)]) assert.ok(help.includes(n.toUpperCase()), `${n} has no help`);
  for (const n of TEXT_NAMES) assert.ok(help.includes(n), `help text for unknown function ${n}`);
});

test("every entry is complete and grouped", () => {
  for (const h of FUNCTION_HELP) {
    assert.ok(GROUPS.includes(h.group), h.name);
    for (const k of ["signature", "arguments", "result", "summary", "example", "note", "insert"]) assert.ok(h[k], `${h.name} lacks ${k}`);
  }
});

test("signature arity matches the type tables", () => {
  const sig = (n) => FUNCTION_HELP.find((h) => h.name === n).signature;
  assert.equal(sig("LEFT"), "LEFT(text, length)");
  assert.equal(sig("SPLIT"), "SPLIT(text, separator, position)");
  assert.equal(sig("DATEDIFF"), "DATEDIFF(unit, date, date)");
  assert.equal(sig("PERCENTILE"), "PERCENTILE(number, p)");
  assert.equal(sig("CONCAT"), "CONCAT(text, text, …)");
  assert.equal(sig("SUM"), "SUM(value)");
  for (const [n, r] of Object.entries(ROW_FUNCTIONS)) {
    const inner = sig(n.toUpperCase()).replace(/^[^(]*\(/, "").replace(/\)$/, "").split(", ").filter((x) => x !== "…");
    assert.equal(inner.length, r.args.length, n);
  }
  assert.equal(FUNCTION_HELP.find((h) => h.name === "YEAR").result, "number");
  assert.equal(FUNCTION_HELP.find((h) => h.name === "MIN").result, "same type as its argument");
});

test("every example formula parses and type-checks", () => {
  for (const h of FUNCTION_HELP) {
    const r = evaluateDraft({ name: "Example", formula: h.example }, ctx);
    assert.equal(r.ok, true, `${h.name}: ${h.example} -> ${r.message}`);
    assert.ok(h.example.toUpperCase().includes(h.name), `${h.name} example does not use it`);
  }
});

test("search and grouping", () => {
  assert.ok(searchHelp("date").map((h) => h.name).includes("DATEADD"));
  assert.ok(searchHelp("DATE").length < FUNCTION_HELP.length);
  assert.equal(searchHelp("").length, FUNCTION_HELP.length);
  assert.deepEqual(searchHelp("zzzz"), []);
  const g = groupHelp(FUNCTION_HELP);
  assert.deepEqual(g.map((x) => x.group), [...GROUPS]);
  assert.equal(g.reduce((n, x) => n + x.items.length, 0), FUNCTION_HELP.length);
  assert.deepEqual(groupHelp(searchHelp("zzzz")), []);
});

test("functionItems: prefix, case, cap", () => {
  const lo = functionItems("lo", 12);
  assert.deepEqual(lo.map((i) => i.label), ["LOWER"]);
  assert.equal(lo[0].insert, "LOWER(");
  assert.equal(lo[0].kind, "function");
  assert.equal(lo[0].hint, "LOWER(text)");
  assert.equal(functionItems("", 12).length, 0);
  assert.ok(functionItems("s", 2).length <= 2);
  assert.equal(functionItems("and", 12)[0].insert, "AND ");
});

test("suggest offers functions after a letter prefix outside brackets", () => {
  const s = suggest("LO", 2, ctx);
  assert.deepEqual(s.items.map((i) => i.label), ["LOWER"]);
  assert.equal(s.from, 0); assert.equal(s.to, 2);
  const t = suggest("SUM([orders.amount]) / av", 25, ctx);
  assert.equal(t.from, 23);
  assert.deepEqual(t.items.map((i) => i.label), ["AVG", "ATTR"].filter((n) => n.toLowerCase().startsWith("av")));
  assert.ok(suggest("S", 1, ctx).items.length <= 12);
  assert.ok(suggest("S", 1, ctx).items.every((i) => i.kind === "function"));
});

test("suggest stays quiet where a function name makes no sense", () => {
  assert.deepEqual(suggest("", 0, ctx).items, []);
  assert.deepEqual(suggest("1 + ", 4, ctx).items, []);
  assert.deepEqual(suggest("'LO", 3, ctx).items, [], "inside a text literal");
  assert.deepEqual(suggest("LOWER(", 6, ctx).items, []);
  assert.deepEqual(suggest("12ab", 4, ctx).items, [], "a number's tail is not a word");
});

test("bracket suggestions are unchanged", () => {
  const s = suggest("SUM([ord", 8, ctx);
  assert.equal(s.from, 5);
  assert.deepEqual(s.items.map((i) => i.label), ["orders.amount", "orders.qty", "orders.status", "orders.region", "orders.placed"]);
  assert.deepEqual(Object.keys(s.items[0]), ["label", "insert", "kind"]);
});

test("caret inside a word: no function suggestion; before a bracket: no second bracket", () => {
  assert.deepEqual(suggest("LOWER(", 2, ctx).items, [], "LO|WER(");
  assert.deepEqual(suggest("LOWER", 2, ctx).items, []);
  const s = suggest("IF(1 = 1, 2, 3)", 2, ctx);
  assert.equal(s.items.find((i) => i.label === "IF").insert, "IF", "IF|( must not become IF((");
  assert.equal(suggest("IF", 2, ctx).items.find((i) => i.label === "IF").insert, "IF(");
  assert.equal(suggest("LO + 1", 2, ctx).items[0].insert, "LOWER(", "a space after the caret still adds the bracket");
});

test("DATEADD help states its limits and the date window, tied to the server compiler", () => {
  const h = FUNCTION_HELP.find((x) => x.name === "DATEADD").note;
  assert.ok(h.includes("-100000 to 100000") && h.includes(DATEADD_WINDOW.after) && h.includes(DATEADD_WINDOW.before), h);
  const cs = readFileSync(new URL("../../src/DashboardBuilder/ClickHouse/Calc/CalcCompiler.cs", import.meta.url), "utf8");
  assert.ok(cs.includes(`${DATEADD_WINDOW.after} 00:00:00`) && cs.includes(`${DATEADD_WINDOW.before} 00:00:00`), "window drifted from CalcCompiler.cs");
});

test("notes speak of NULL, not 'empty text'", () => {
  for (const h of FUNCTION_HELP) assert.ok(!/Empty text/.test(h.note), h.name);
  assert.match(FUNCTION_HELP.find((x) => x.name === "CONTAINS").note, /empty needle is always true/);
  assert.match(FUNCTION_HELP.find((x) => x.name === "DATEDIFF").note, /boundaries.*Monday/);
});
