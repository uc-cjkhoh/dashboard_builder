// The crosstab layouts behind crosstab-totals.test.mjs. `fixtures/crosstab-totals-golden.json` holds the HTML `crosstabTable` drew for each case x
// conditional-format setting BEFORE "Include totals" existed (generated from unmodified main), so a setting without the flag is proven byte-identical.
import { installFakeDom } from "./fake-dom.mjs";

const PALETTE_VARS = { "--surface": "#ffffff", "--ink": "#1c1719", "--chart-div-high": "#2a78d6", "--chart-div-low": "#eb6834" };
installFakeDom({ vars: PALETTE_VARS });
const { crosstabTable } = await import("../../src/DashboardBuilder/Features/Dashboard/render-table.js");
const { measureKey } = await import("../../src/DashboardBuilder/Features/Dashboard/conditional-model.js");

const dim = (column) => ({ db: "d", table: "t", column, category: "text" });
const meas = (column, agg = "sum") => ({ db: "d", table: "t", column, category: "numeric", agg });
export const AMOUNT = meas("amount"), QTY = meas("qty");
export const keyOf = (m) => measureKey({ field: m, agg: m.agg });

const sheet = (columns, rows, over = {}) => ({ chartType: "table", columns, rows, color: [], filters: [], marks: {}, format: {}, analytics: { totals: { grand: true, sub: true } }, ...over });
const R = (keys, ...values) => ({ keys, values });
const fmt = (v) => (v == null ? "—" : String(v));
const cat = (v) => String(v);

// Rows: region (EU, US) x product (a, b); columns: year (2023, 2024).
const YEARS = ["2023", "2024"];
const cellRows = (f = (r, p, y) => 10 * (r + 1) + 5 * p + (y ? 3 : 0)) => {
  const out = [];
  ["EU", "US"].forEach((reg, r) => ["a", "b"].forEach((prod, p) => YEARS.forEach((y, yi) => out.push(R([reg, prod, y], f(r, p, yi), 1 + r + p)))));
  return out;
};

/** name -> { sheet, result, partial? } */
export const CASES = {
  // measures on top, two Rows dimensions + a Columns dimension: grand-total column, subtotal rows, grand-total row, intersections
  full: { sheet: sheet([dim("year"), AMOUNT], [dim("region"), dim("product")]),
    result: { rowDimensions: ["region", "product"], columnDimensions: ["year"], measures: ["sum(amount)"], rows: cellRows().map((r) => ({ keys: r.keys, values: [r.values[0]] })), truncated: false } },
  twoMeasures: { sheet: sheet([dim("year"), AMOUNT, QTY], [dim("region"), dim("product")]),
    result: { rowDimensions: ["region", "product"], columnDimensions: ["year"], measures: ["sum(amount)", "sum(qty)"], rows: cellRows(), truncated: false } },
  // no Columns dimension: a grand-total row only (no total column)
  rowsOnly: { sheet: sheet([AMOUNT], [dim("region")]),
    result: { rowDimensions: ["region"], columnDimensions: [], measures: ["sum(amount)"], rows: [R(["EU"], 4), R(["US"], 10)], truncated: false } },
  // measures run down the left
  measuresLeft: { sheet: sheet([dim("year")], [dim("region"), AMOUNT, QTY]),
    result: { rowDimensions: ["region"], columnDimensions: ["year"], measures: ["sum(amount)", "sum(qty)"], rows: ["EU", "US"].flatMap((reg, r) => YEARS.map((y, yi) => R([reg, y], 10 * (r + 1) + yi, 2 + r))), truncated: false } },
  // an average cannot be combined from cells: its totals read "—"
  average: { sheet: sheet([dim("year"), meas("amount", "avg")], [dim("region")]),
    result: { rowDimensions: ["region"], columnDimensions: ["year"], measures: ["avg(amount)"], rows: ["EU", "US"].flatMap((reg, r) => YEARS.map((y, yi) => R([reg, y], 10 * (r + 1) + yi))), truncated: false } },
  // rows still paging: totals come from the loaded rows
  partial: { sheet: sheet([dim("year"), AMOUNT], [dim("region")]), partial: true,
    result: { rowDimensions: ["region"], columnDimensions: ["year"], measures: ["sum(amount)"], rows: ["EU", "US"].flatMap((reg, r) => YEARS.map((y, yi) => R([reg, y], 10 * (r + 1) + yi))), truncated: false } },
  // a negative cell and a blank cell
  negative: { sheet: sheet([dim("year"), AMOUNT], [dim("region")]),
    result: { rowDimensions: ["region"], columnDimensions: ["year"], measures: ["sum(amount)"], rows: [R(["EU", "2023"], -5), R(["EU", "2024"], 3), R(["US", "2023"], null), R(["US", "2024"], 8)], truncated: false } },
};

/** The HTML crosstabTable draws for a case, with `conditional` (a { measureKey: entry } map) and optional totals / sheet overrides. */
export function draw(name, { conditional, totals, over = {} } = {}) {
  const c = CASES[name];
  const s = { ...c.sheet, ...over, format: { ...(over.format ?? {}), ...(conditional ? { conditional } : {}) } };
  if (totals) s.analytics = { totals };
  const t = crosstabTable(s, c.result, fmt, cat, Boolean(c.partial));
  return t;
}
export const html = (name, opts) => draw(name, opts).html();

/** Settings each golden case is drawn with: every kind of conditional entry the app writes today. */
export const SETTINGS = {
  none: undefined,
  scale: { [keyOf(AMOUNT)]: { mode: "scale", scale: "sequential", mid: null, rules: [] } },
  diverging: { [keyOf(AMOUNT)]: { mode: "scale", scale: "diverging", mid: null, rules: [] } },
  bars: { [keyOf(AMOUNT)]: { mode: "bars", scale: "sequential", mid: null, rules: [] } },
  rules: { [keyOf(AMOUNT)]: { mode: "none", scale: "sequential", mid: null, rules: [{ op: ">", value: 12, tone: "good" }] } },
  both: { [keyOf(AMOUNT)]: { mode: "scale", scale: "sequential", mid: null, rules: [{ op: ">", value: 12, tone: "bad" }] }, [keyOf(QTY)]: { mode: "bars", scale: "sequential", mid: null, rules: [] } },
  avg: { [keyOf(meas("amount", "avg"))]: { mode: "scale", scale: "sequential", mid: null, rules: [] } },
};
export const TOTALS = { both: { grand: true, sub: true }, grandOnly: { grand: true, sub: false }, subOnly: { grand: false, sub: true }, off: { grand: false, sub: false } };

/** Every case x setting x totals combination, keyed "case/setting/totals". */
export function everyCombo() {
  const out = {};
  for (const name of Object.keys(CASES)) for (const [sn, cond] of Object.entries(SETTINGS)) for (const [tn, tot] of Object.entries(TOTALS)) out[`${name}/${sn}/${tn}`] = { name, conditional: cond, totals: tot };
  return out;
}
