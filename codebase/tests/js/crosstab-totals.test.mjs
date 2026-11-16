// "Include totals": what crosstabTable draws. Without the flag the table is byte-identical to what main drew before the feature (golden); with it,
// the total cells (grand-total column, subtotal rows, grand-total row, their intersections) wear the measure's scale / bars / rules, and the totals
// feed the scale's extent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { draw, html, everyCombo, AMOUNT, QTY, keyOf, CASES } from "./crosstab-cases.mjs";
import { scaleColors, extentOf, barGeometry } from "../../src/DashboardBuilder/Features/Dashboard/conditional-model.js";
import { contrastRatio } from "../../src/DashboardBuilder/Features/Dashboard/contrast.js";

const golden = JSON.parse(readFileSync(new URL("../fixtures/crosstab-totals-golden.json", import.meta.url), "utf8"));
const palette = { surface: "#ffffff", high: "#2a78d6", low: "#eb6834", inks: ["#1c1719", "#ffffff", "#000000", "#ffffff"] };
const seq = { mode: "scale", scale: "sequential", mid: null, rules: [] };
const A = keyOf(AMOUNT), Q = keyOf(QTY);

// --- the default is untouched ---------------------------------------------------------------------------------
test("no flag: every layout x setting x totals combination draws exactly what it drew before the feature", () => {
  const combos = Object.entries(everyCombo());
  assert.equal(combos.length, Object.keys(golden).length);
  for (const [k, o] of combos) assert.equal(html(o.name, o), golden[k], k);
});
test("an explicit totals:false, or a flag on a measure with nothing to colour, draws the same as no flag", () => {
  for (const [k, o] of Object.entries(everyCombo())) {
    const withFalse = o.conditional && Object.fromEntries(Object.entries(o.conditional).map(([m, e]) => [m, { ...e, totals: false }]));
    assert.equal(html(o.name, { ...o, conditional: withFalse }), golden[k], `${k} (false)`);
  }
  const idle = { [A]: { mode: "none", scale: "sequential", mid: null, rules: [], totals: true } };
  assert.equal(html("full", { conditional: idle }), golden["full/none/both"]);
});
test("the flag is ignored while no total is drawn, and the key does not claim it", () => {
  const on = { [A]: { ...seq, totals: true } };
  const noTotals = { grand: false, sub: false };
  assert.equal(html("full", { conditional: on, totals: noTotals }), golden["full/scale/off"]);
  assert.ok(!html("full", { conditional: on, totals: noTotals }).includes("Totals included"));
  // Rows only has no Columns dimension: no total column; and sub needs two Rows dimensions, so subtotals alone draw nothing here
  assert.equal(html("rowsOnly", { conditional: { [A]: { ...seq, totals: true } }, totals: { grand: false, sub: true } }), golden["rowsOnly/scale/subOnly"]);
});

// --- the total cells --------------------------------------------------------------------------------------------
const rowsOf = (t) => t.find((e) => e.tag === "tr");
const cellsOf = (t) => t.find((e) => e.tag === "td");
const text = (c) => c.textContent;
const tdByText = (t, s) => cellsOf(t).filter((c) => text(c) === s);
const bgOf = (c) => c.style.background;

// `full`: amount cells 10 13 | 15 18 | 20 23 | 25 28; grand-total column 23 33 43 53; subtotals EU 25 31 (56) US 45 51 (96); grand row 70 82 (152).
const ALL = [23, 33, 43, 53, 25, 31, 56, 45, 51, 96, 70, 82, 152];
const CELLS = [10, 13, 15, 18, 20, 23, 25, 28];

test("with totals included the scale's extent takes in every total: the grand total is the top", () => {
  const t = draw("full", { conditional: { [A]: { ...seq, totals: true } } });
  const ext = extentOf([...CELLS, ...ALL]);
  assert.deepEqual(ext, { min: 10, max: 152 });
  const top = tdByText(t, "152");
  assert.equal(top.length, 1);
  assert.equal(bgOf(top[0]), scaleColors(152, ext, seq, palette).bg, "the largest value is the strongest tint");
  assert.notEqual(bgOf(top[0]), "#ffffff");
  assert.equal(bgOf(tdByText(t, "10")[0]), "#ffffff", "the smallest is the surface");
  // an ordinary cell is now measured against the wider extent: paler than without totals
  const without = draw("full", { conditional: { [A]: seq } });
  assert.equal(bgOf(tdByText(without, "28")[0]), scaleColors(28, { min: 10, max: 28 }, seq, palette).bg);
  assert.equal(bgOf(tdByText(t, "28")[0]), scaleColors(28, ext, seq, palette).bg);
  assert.notEqual(bgOf(tdByText(t, "28")[0]), bgOf(tdByText(without, "28")[0]));
});
test("every total cell (column, subtotals, grand row, intersections) is coloured and keeps its xt-total look", () => {
  const t = draw("full", { conditional: { [A]: { ...seq, totals: true } } });
  const ext = extentOf([...CELLS, ...ALL]);
  for (const v of ALL) {
    const c = tdByText(t, String(v)).filter((x) => x.classList.contains("xt-total")); // 23 is also an ordinary cell
    assert.equal(c.length, 1, `value ${v}`);
    assert.ok(c[0].classList.contains("xt-total") && c[0].classList.contains("xt-cf") && c[0].classList.contains("num"), `${v} keeps xt-total, num and wears xt-cf`);
    const want = scaleColors(v, ext, seq, palette);
    assert.equal(bgOf(c[0]), want.bg, `${v} bg`);
    assert.equal(c[0].style.color, want.ink, `${v} ink`);
  }
  // the rows and headers around them are unchanged
  const trs = t.find((e) => e.tag === "tr");
  assert.equal(trs.filter((r) => r.classList.contains("xt-subtotal")).length, 2);
  assert.equal(trs.filter((r) => r.classList.contains("xt-grand")).length, 1);
  assert.ok(t.find((e) => e.tag === "th" && e.classList.contains("xt-total")).length >= 4, "total headers keep xt-total");
});
test("contrast: every coloured total cell's ink is at least 4.5:1 against its tint", () => {
  const t = draw("full", { conditional: { [A]: { ...seq, mode: "scale", scale: "diverging", totals: true } } });
  let n = 0;
  for (const c of cellsOf(t).filter((x) => x.classList.contains("xt-total") && x.style.background)) {
    assert.ok(contrastRatio(c.style.color, c.style.background) >= 4.5, `${text(c)}: ${c.style.color} on ${c.style.background}`);
    n++;
  }
  assert.equal(n, ALL.length);
});
test("only the grand total column and row: subtotal rows stay plain", () => {
  const t = draw("full", { conditional: { [A]: { ...seq, totals: true } }, totals: { grand: true, sub: false } });
  const grandRow = t.find((e) => e.tag === "tr" && e.classList.contains("xt-grand"))[0];
  assert.ok(cellsOf(grandRow).every((c) => c.classList.contains("xt-cf")));
  assert.equal(t.find((e) => e.tag === "tr" && e.classList.contains("xt-subtotal")).length, 0);
  const ext = extentOf([...CELLS, 23, 33, 43, 53, 70, 82, 152]);
  assert.equal(bgOf(tdByText(t, "152")[0]), scaleColors(152, ext, seq, palette).bg, "the subtotals are not in the extent");
});
test("only subtotals: the subtotal rows are coloured, and there is no grand total column or row", () => {
  const t = draw("full", { conditional: { [A]: { ...seq, totals: true } }, totals: { grand: false, sub: true } });
  const subs = t.find((e) => e.tag === "tr" && e.classList.contains("xt-subtotal"));
  assert.equal(subs.length, 2);
  for (const r of subs) assert.ok(cellsOf(r).every((c) => c.classList.contains("xt-cf") && c.classList.contains("xt-total")));
  assert.equal(t.find((e) => e.tag === "tr" && e.classList.contains("xt-grand")).length, 0);
  assert.ok(!t.html().includes(">Total<"));
  assert.equal(bgOf(tdByText(t, "51")[0]), scaleColors(51, extentOf([...CELLS, 25, 31, 45, 51]), seq, palette).bg);
});
test("a total of a measure that is not flagged stays plain; two measures keep their own extents", () => {
  const t = draw("twoMeasures", { conditional: { [A]: { ...seq, totals: true }, [Q]: seq } });
  const totalCells = cellsOf(t).filter((c) => c.classList.contains("xt-total"));
  const amount = totalCells.filter((_, i) => i % 2 === 0), qty = totalCells.filter((_, i) => i % 2 === 1); // each row ends with the amount total, then the qty total
  assert.ok(amount.length > 0 && qty.length > 0);
  assert.ok(amount.every((c) => c.classList.contains("xt-cf")), "amount totals are coloured");
  assert.ok(qty.every((c) => !c.classList.contains("xt-cf") && c.style.background === undefined), "qty totals are plain");
});
test("measures down the left: the totals of the flagged measure are coloured, the other's are not", () => {
  const t = draw("measuresLeft", { conditional: { [A]: { ...seq, totals: true } } });
  // amount: cells 10 11 20 21; totals: EU 21, US 41 (column); grand row 30 32 (62)
  const ext = extentOf([10, 11, 20, 21, 21, 41, 30, 32, 62]);
  assert.deepEqual(ext, { min: 10, max: 62 });
  const top = tdByText(t, "62");
  assert.equal(top.length, 1);
  assert.equal(bgOf(top[0]), scaleColors(62, ext, seq, palette).bg);
  // qty (not flagged): its grand-total row cells are plain
  const grandRows = t.find((e) => e.tag === "tr" && e.classList.contains("xt-grand"));
  assert.equal(grandRows.length, 2);
  assert.ok(cellsOf(grandRows[1]).every((c) => !c.classList.contains("xt-cf")));
  assert.ok(cellsOf(grandRows[0]).every((c) => c.classList.contains("xt-cf")));
});
test("a total shown as — is never coloured and does not count; the scale still covers the rest", () => {
  // An average has no combined total in a table (it reads —), so including totals changes nothing but the key.
  const avg = keyOf({ ...AMOUNT, agg: "avg" });
  const entry = { [avg]: { ...seq, totals: true } };
  const t = draw("average", { conditional: entry });
  const dashes = cellsOf(t).filter((c) => c.classList.contains("xt-total"));
  assert.ok(dashes.length > 0 && dashes.every((c) => text(c).includes("—")), "every total of an average reads —");
  assert.ok(dashes.every((c) => c.style.background === undefined && c.style.color === undefined), "and none is coloured");
  const plain = draw("average", { conditional: { [avg]: seq } });
  assert.equal(bgOf(tdByText(t, "11")[0]), bgOf(tdByText(plain, "11")[0]), "the cells keep the extent they had");
});
test("a group with no values has no total: it reads — and stays uncoloured, the others are coloured", () => {
  const result = { rowDimensions: ["region"], columnDimensions: ["year"], measures: ["sum(amount)"], truncated: false,
    rows: [{ keys: ["EU", "2023"], values: [null] }, { keys: ["EU", "2024"], values: [null] }, { keys: ["US", "2023"], values: [5] }, { keys: ["US", "2024"], values: [9] }] };
  const t = draw("negative", { conditional: { [A]: { ...seq, totals: true } }, result });
  const eu = t.find((e) => e.tag === "tr").find((r) => text(r).startsWith("EU"));
  assert.ok(eu, "the EU row");
  assert.ok(text(eu).endsWith("—"), "the EU grand total is —");
  const last = cellsOf(eu).at(-1);
  assert.equal(last.style.background, undefined);
  assert.equal(last.classList.contains("xt-total"), true);
  const ext = extentOf([5, 9, 14, 5, 9, 14]);
  assert.deepEqual(ext, { min: 5, max: 14 });
  assert.equal(bgOf(tdByText(t, "14").at(-1)), scaleColors(14, ext, seq, palette).bg);
});
test("negatives: a negative total is the bottom of the scale", () => {
  const result = { ...CASES.negative.result, rows: [{ keys: ["EU", "2023"], values: [-5] }, { keys: ["EU", "2024"], values: [-3] }, { keys: ["US", "2023"], values: [2] }, { keys: ["US", "2024"], values: [4] }] };
  const t = draw("negative", { conditional: { [A]: { ...seq, totals: true } }, result });
  // totals: EU -8, US 6; grand row -3 1 (-2)
  const ext = extentOf([-5, -3, 2, 4, -8, 6, -3, 1, -2]);
  assert.deepEqual(ext, { min: -8, max: 6 });
  assert.equal(bgOf(tdByText(t, "-8")[0]), "#ffffff", "-8 is the bottom of the scale: the surface");
  assert.equal(bgOf(tdByText(t, "6")[0]), scaleColors(6, ext, seq, palette).bg);
});
test("all equal: every value, total included, gets the same flat tint", () => {
  const result = { rowDimensions: ["region"], columnDimensions: [], measures: ["sum(amount)"], truncated: false, rows: [{ keys: ["EU"], values: [4] }, { keys: ["US"], values: [4] }] };
  const t = draw("rowsOnly", { conditional: { [A]: { ...seq, totals: true } }, result });
  const ext = { min: 4, max: 8 };
  assert.equal(bgOf(tdByText(t, "8")[0]), scaleColors(8, ext, seq, palette).bg, "the grand total 8 tops a 4..8 scale");
  const flat = draw("rowsOnly", { conditional: { [A]: { ...seq, totals: true } }, result: { ...result, rows: [{ keys: ["EU"], values: [4] }] } });
  assert.equal(bgOf(tdByText(flat, "4")[0]), scaleColors(4, { min: 4, max: 4 }, seq, palette).bg, "one value, which is also its own total: the flat tint");
});

test("data bars: a total gets a bar measured against the same extent", () => {
  const bars = { [A]: { mode: "bars", scale: "sequential", mid: null, rules: [], totals: true } };
  const t = draw("rowsOnly", { conditional: bars });
  // cells 4 10; grand row 14
  const ext = { min: 4, max: 14 };
  const grand = tdByText(t, "14")[0];
  const bar = grand.find((e) => e.classList.contains("xt-bar"));
  assert.equal(bar.length, 1);
  const g = barGeometry(14, ext);
  assert.equal(bar[0].style.width, `${g.width.toFixed(2)}%`);
  assert.equal(bar[0].style.left, `${g.left.toFixed(2)}%`);
  assert.ok(grand.classList.contains("xt-total"));
});
test("rules: a total over the threshold carries the tone class, the icon and the title, not just a colour", () => {
  const rules = { [A]: { mode: "none", scale: "sequential", mid: null, rules: [{ op: ">", value: 12, tone: "bad" }], totals: true } };
  const t = draw("rowsOnly", { conditional: rules });
  const grand = tdByText(t, "14")[0];
  assert.ok(grand.classList.contains("xt-rule--bad") && grand.classList.contains("xt-total"));
  assert.equal(grand.find((e) => e.classList.contains("xt-cf__icon")).length, 1, "the icon is there");
  assert.equal(grand.title, "Bad: > 12");
  const low = tdByText(t, "4")[0];
  assert.ok(!low.classList.contains("xt-rule--bad"));
  // without the flag the same total is plain
  const off = draw("rowsOnly", { conditional: { [A]: { ...rules[A], totals: false } } });
  assert.ok(!tdByText(off, "14")[0].classList.contains("xt-rule--bad"));
});

// --- the key ----------------------------------------------------------------------------------------------------
const keyText = (t) => t.find((e) => e.classList.contains("xt-legend")).map(text).join(" | ");
test("the key says Totals included, once, and only for a table that draws totals", () => {
  const t = draw("full", { conditional: { [A]: { ...seq, totals: true } } });
  assert.match(keyText(t), /Totals included/);
  assert.equal((keyText(t).match(/Totals included/g) ?? []).length, 1);
  assert.ok(!keyText(draw("full", { conditional: { [A]: seq } })).includes("Totals included"));
});
test("with two measures the key names the ones whose totals are included, unless all are", () => {
  const some = keyText(draw("twoMeasures", { conditional: { [A]: { ...seq, totals: true }, [Q]: seq } }));
  assert.match(some, /Totals included: sum\(amount\)/);
  const all = keyText(draw("twoMeasures", { conditional: { [A]: { ...seq, totals: true }, [Q]: { ...seq, totals: true } } }));
  assert.match(all, /Totals included(?!:)/);
});
test("a partly loaded table says its scales, bars and totals use the rows loaded so far; totals are those of the loaded rows", () => {
  const t = draw("partial", { conditional: { [A]: { ...seq, totals: true } } });
  assert.match(keyText(t), /Scales, bars and totals use the 4 rows loaded so far\./);
  // grand total column: EU 10 + 11 = 21, US 20 + 21 = 41; grand row 30 32 (62)
  const ext = extentOf([10, 11, 20, 21, 21, 41, 30, 32, 62]);
  assert.equal(bgOf(tdByText(t, "62")[0]), scaleColors(62, ext, seq, palette).bg);
  // the old wording is kept when totals are not included
  assert.match(keyText(draw("partial", { conditional: { [A]: seq } })), /Scales and bars use the 4 rows loaded so far\./);
});
