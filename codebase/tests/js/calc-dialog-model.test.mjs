// Calculated fields — dialog model (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateDraft, chipFor, suggest } from "../../src/DashboardBuilder/Features/Calc/calc-dialog-model.js";
import { catalogFromEntities } from "../../src/DashboardBuilder/Features/Calc/calc-resolve.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
import { ICON_NAMES } from "../../src/DashboardBuilder/Features/Core/icons.js";

const col = (name, category) => ({ name, category });
const catalog = catalogFromEntities([
  { id: "e1", db: "shop", table: "orders", columns: [col("amount", "numeric"), col("qty", "numeric"), col("status", "text"), col("a.b", "text")] },
  { id: "e2", db: "shop", table: "items", columns: [col("price", "numeric")] },
  { id: "e3", db: "archive", table: "items", columns: [col("price", "numeric")] },
]);
const calcs = [{ id: "calc1", name: "Net", formula: "SUM([orders.amount])" }, { id: "calc2", name: "Ratio", formula: "[Net] / 2" }];
const ctx = { calcs, catalog };

test("valid aggregate ratio", () => {
  const r = evaluateDraft({ name: "Avg", formula: "SUM([orders.amount]) / SUM([orders.qty])" }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.role, "measure");
  assert.ok(r.ast);
  assert.equal(chipFor(r.info, r.role).text, "Aggregate · number");
  assert.ok(ICON_NAMES.includes(chipFor(r.info, r.role).icon));
});

test("row-level chip", () => {
  const r = evaluateDraft({ name: "S", formula: "[orders.status]" }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.role, "dimension");
  const c = chipFor(r.info, r.role);
  assert.equal(c.text, "Row-level · text");
  assert.ok(ICON_NAMES.includes(c.icon));
});

test("syntax error keeps position", () => {
  const r = evaluateDraft({ name: "X", formula: "SUM([orders.amount]" }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.field, "formula");
  assert.match(r.message, /Expected \)/);
  assert.equal(typeof r.pos, "number");
});

test("plain resolver messages, no E15 prefix", () => {
  const a = evaluateDraft({ name: "X", formula: "[nothing]" }, ctx);
  assert.equal(a.message, "Write the field as [table.column].");
  const b = evaluateDraft({ name: "X", formula: "[orders.zip]" }, ctx);
  assert.equal(b.message, "orders.zip isn't in the model.");
  assert.equal(b.field, "formula");
  const c = evaluateDraft({ name: "X", formula: "[orders.status] + 1" }, ctx);
  assert.equal(c.ok, false);
  assert.ok(!c.message.startsWith("Calculation"));
});

test("odd text never throws", () => {
  const w = "Write a formula.";
  assert.equal(evaluateDraft({ name: "X", formula: undefined }, ctx).message, w);
  assert.equal(evaluateDraft({ name: "X", formula: "" }, ctx).message, w);
  assert.equal(evaluateDraft({ name: "X", formula: 42 }, ctx).message, w);
  assert.equal(evaluateDraft({ name: "X", formula: "   " }, ctx).message, w);
  const big = evaluateDraft({ name: "X", formula: "1".repeat(LIMITS.calcFormula + 1) }, ctx);
  assert.equal(big.message, `A formula can be at most ${LIMITS.calcFormula} characters.`);
  assert.equal(evaluateDraft({ name: "X", formula: "1" + " ".repeat(LIMITS.calcFormula - 1) }, ctx).ok, true);
  const ctrl = evaluateDraft({ name: "X", formula: "1 +\u0007 2" }, ctx);
  assert.equal(ctrl.message, "That formula has a character that isn't allowed.");
  assert.equal(evaluateDraft({ name: "X", formula: "1 +\n\t2" }, ctx).ok, true);
  const smart = evaluateDraft({ name: "X", formula: "“x”" }, ctx);
  assert.equal(smart.ok, false);
  assert.equal(smart.field, "formula");
  assert.equal(typeof smart.message, "string");
  assert.doesNotThrow(() => evaluateDraft(undefined, ctx));
  assert.doesNotThrow(() => evaluateDraft({}, ctx));
  assert.doesNotThrow(() => evaluateDraft({ name: null, formula: null }, { calcs: [], catalog }));
});

test("name rules", () => {
  const r = evaluateDraft({ name: "a.b", formula: "1" }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.field, "name");
  assert.equal(evaluateDraft({ name: "net", formula: "1" }, ctx).field, "name");
  assert.equal(evaluateDraft({ name: "Net", formula: "1", selfId: "calc1" }, ctx).ok, true);
  assert.equal(evaluateDraft({ name: "", formula: "1" }, ctx).field, "name");
});

test("a new cycle through the unsaved draft is caught", () => {
  const r = evaluateDraft({ name: "Net", formula: "[Ratio] + 1", selfId: "calc1" }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.field, "formula");
  assert.match(r.message, /refers to itself/);
  const self = evaluateDraft({ name: "Solo", formula: "[Solo]" }, ctx);
  assert.equal(self.ok, false);
});

test("suggest inside an unclosed bracket", () => {
  const r = suggest("SUM([ord", 8, ctx);
  assert.equal(r.from, 5);
  assert.equal(r.to, 8);
  const labels = r.items.map((i) => i.label);
  assert.deepEqual(labels, ["orders.amount", "orders.qty", "orders.status"]);
  assert.ok(r.items.every((i) => i.kind === "field" && i.insert === i.label));
  assert.ok(!labels.includes("orders.a.b"));
});

test("suggest: nothing outside a bracket", () => {
  assert.deepEqual(suggest("SUM(", 4, ctx).items, []);
  assert.deepEqual(suggest("[orders.qty] + ", 15, ctx).items, []);
  assert.deepEqual(suggest(undefined, 0, ctx).items, []);
  assert.deepEqual(suggest("[x", 99, ctx).items, suggest("[x", 2, ctx).items);
});

test("suggest: ambiguous tables use 3 parts, calcs by name, self excluded, prefix case-insensitive", () => {
  const all = suggest("[", 1, ctx).items;
  const labels = all.map((i) => i.label);
  assert.ok(labels.includes("shop.items.price") && labels.includes("archive.items.price"));
  assert.ok(!labels.includes("items.price"));
  assert.ok(labels.includes("Net") && labels.includes("Ratio"));
  assert.deepEqual(all.filter((i) => i.kind === "calc").map((i) => i.insert), ["Net", "Ratio"]);
  const noSelf = suggest("[n", 2, ctx).items;
  assert.deepEqual(noSelf.map((i) => i.label), ["Net"]);
  const self = suggest("[n", 2, { ...ctx, selfId: "calc1" }).items;
  assert.deepEqual(self, []);
  assert.deepEqual(suggest("[RAT", 4, ctx).items.map((i) => i.label), ["Ratio"]);
});

test("suggest: capped, never offers names with . [ ]", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, name: `Calc${i}`, formula: "1" }));
  many.push({ id: "bad", name: "x.y", formula: "1" }, { id: "bad2", name: "[z]", formula: "1" });
  const r = suggest("[", 1, { calcs: many, catalog });
  assert.equal(r.items.length, 12);
  const r2 = suggest("[x", 2, { calcs: many, catalog });
  assert.deepEqual(r2.items, []);
});

test("isDirty: an untouched dialog is clean; any edit to name or formula is dirty", async () => {
  const { isDirty } = await import("../../src/DashboardBuilder/Features/Calc/calc-dialog-model.js");
  assert.equal(isDirty({ name: "", formula: "" }, { name: "", formula: "" }), false);
  assert.equal(isDirty({ name: "A", formula: "[orders.qty]" }, { name: "A", formula: "[orders.qty]" }), false);
  assert.equal(isDirty({ name: "A", formula: "x\ny" }, { name: "A", formula: "x\r\ny" }), false); // CRLF from a textarea
  assert.equal(isDirty({ name: "", formula: "" }, { name: "N", formula: "" }), true);
  assert.equal(isDirty({ name: "A", formula: "1" }, { name: "A", formula: "12" }), true);
  assert.equal(isDirty({ name: "A", formula: "1" }, { name: "A ", formula: "1" }), false); // trailing space in the name is not a change
});
