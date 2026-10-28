import { roleOf } from "./show-me-rules.js";
import { planMeasures } from "./sheet-plan.js";
import { isCalc } from "./table-calc.js";
import { combine } from "./analytics-model.js";
import { CF_OP_CHOICES, CF_TONE_CHOICES, TONE_ICON, measureKey, extentOf, scaleColors, barGeometry, matchRule, isActive, midpointOf } from "./conditional-model.js";
import { tupleKey, uniqueTuples, expandLeaves, runs, levelSpans } from "./grid-model.js";
import { el, warn, iconSpan } from "./render-dom.js";

// The crosstab / text table and its conditional formatting (P37), drawn from a result. Pure DOM output: nothing here
// reads the editor, so any worksheet view can draw a table. `calcPercent` = result measure indexes whose values are
// percentages (P27 table calculations), written with a "%".

// Tableau-style crosstab. Row-shelf dimensions form the left stub; Column-shelf dimensions the top
// header; measures are the cell values. The *measure name band* sits on whichever shelf the numeric
// pills are on (measures on both shelves → shown across the top, with a note). Built by pivoting the
// flat grouped rows: keys are [rowDim…, colDim…]; we take the distinct row/col tuples and index the
// cells, then render nested headers (colSpan on top, rowSpan on the left stub).
export function crosstabTable(sheet, result, fmtVal, fmtCat, partial = false, calcPercent = new Set()) {
  const { rowDimensions, columnDimensions, measures, rows } = result;
  const cf = conditionalFor(sheet, measures, rows); // P37: per measure index, or null
  const rd = rowDimensions.length, cd = columnDimensions.length;
  const dimLabel = (v) => (v == null ? "—" : fmtCat(v)); // date-aware header label (P10)

  const colMeasures = sheet.columns.filter((f) => roleOf(f) === "measure");
  const rowMeasures = sheet.rows.filter((f) => roleOf(f) === "measure");
  const bothMeasures = colMeasures.length > 0 && rowMeasures.length > 0;
  const measureOnLeft = !bothMeasures && rowMeasures.length > 0;   // else on top (incl. implicit count)

  const rowTuples = uniqueTuples(rows.map((r) => r.keys.slice(0, rd)));
  const colTuples = uniqueTuples(rows.map((r) => r.keys.slice(rd, rd + cd)));
  const cells = new Map();
  for (const r of rows) cells.set(tupleKey(r.keys.slice(0, rd)) + "|" + tupleKey(r.keys.slice(rd, rd + cd)), r.values);
  const cellValue = (rt, ct, mi) => cells.get(tupleKey(rt) + "|" + tupleKey(ct))?.[mi];

  const leftLeaves = expandLeaves(rowTuples, measureOnLeft ? measures.length : 0);
  const topLeaves = expandLeaves(colTuples, measureOnLeft ? 0 : measures.length);
  const leftLevels = rd + (measureOnLeft ? 1 : 0);
  const topLevels = cd + (measureOnLeft ? 0 : 1);

  const table = el("table", "data xtab");
  // P21 totals: a grand-total column (when Columns has dimensions), a grand-total row (when Rows has),
  // and a subtotal after each first-level Rows group — each combined by the measure's own aggregation.
  const tot = sheet.analytics?.totals ?? {};
  const mplanT = planMeasures(sheet);
  const aggOfMi = (mi) => (isCalc(mplanT[mi]?.field?.tableCalc) ? null : mplanT[mi]?.agg ?? (mplanT.length ? "sum" : "count"));
  const total = (mi, rts, cts) => {
    const agg = aggOfMi(mi);
    if (!agg) return null;
    const vals = [];
    for (const rt of rts) for (const ct of cts) vals.push(cellValue(rt, ct, mi));
    return combine(agg, vals);
  };
  const totalCol = Boolean(tot.grand) && cd > 0;
  const totalMis = measureOnLeft ? [null] : measures.map((_, mi) => mi); // total columns: one per measure (on top) or one
  const showVal = (mi, v) => (calcPercent.has(mi) ? (v == null ? "—" : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`) : fmtVal(v));

  // --- header: one row per top level; a merged corner spans the left-stub width and all header rows.
  const thead = document.createElement("thead");
  const leftLabel = [...rowDimensions, ...(measureOnLeft ? ["Measure"] : [])].join(" · ");
  for (let tl = 0; tl < Math.max(1, topLevels); tl++) {
    const tr = document.createElement("tr");
    if (tl === 0 && leftLevels > 0) {
      const corner = el("th", "xt-corner", leftLabel);
      corner.colSpan = leftLevels;
      corner.rowSpan = Math.max(1, topLevels);
      tr.append(corner);
    }
    if (topLevels === 0) {
      tr.append(el("th", "num", ""));                         // single unlabeled value column
    } else if (tl < cd) {
      for (const g of runs(topLeaves, (lf) => tupleKey(lf.tuple.slice(0, tl + 1)))) {
        const th = el("th", "xt-colhdr", dimLabel(g.leaf.tuple[tl]));
        th.colSpan = g.span;
        tr.append(th);
      }
    } else {
      for (const lf of topLeaves) tr.append(el("th", "num xt-meas", measures[lf.mi]));
    }
    if (totalCol) {
      if (measureOnLeft) { if (tl === 0) { const th = el("th", "num xt-total", "Total"); th.rowSpan = Math.max(1, topLevels); tr.append(th); } }
      else if (tl === 0 && topLevels > 1) { const th = el("th", "xt-colhdr xt-total", "Total"); th.colSpan = measures.length; th.rowSpan = topLevels - 1; tr.append(th); }
      else if (tl === topLevels - 1) for (const mi of totalMis) tr.append(el("th", "num xt-meas xt-total", topLevels > 1 ? measures[mi] : `Total ${measures[mi]}`));
    }
    thead.append(tr);
  }
  table.append(thead);

  // --- body: one row per left leaf; left-stub cells use rowSpan grouping per dimension level.
  const tbody = document.createElement("tbody");
  const dimStarts = [];
  for (let ll = 0; ll < rd; ll++) dimStarts.push(levelSpans(leftLeaves, ll));
  leftLeaves.forEach((leftLeaf, ri) => {
    const tr = document.createElement("tr");
    for (let ll = 0; ll < rd; ll++) {
      const span = dimStarts[ll][ri];
      if (!span) continue;                                    // covered by a rowSpan above
      const th = el("th", "xt-rowhdr", dimLabel(leftLeaf.tuple[ll]));
      if (span > 1) th.rowSpan = span;
      tr.append(th);
    }
    if (measureOnLeft) tr.append(el("th", "xt-rowhdr xt-meas", measures[leftLeaf.mi]));
    for (const topLeaf of topLeaves) {
      const mi = measureOnLeft ? leftLeaf.mi : topLeaf.mi ?? 0;
      const v = cellValue(leftLeaf.tuple, topLeaf.tuple, mi);
      const text = calcPercent.has(mi) ? (v == null ? "—" : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`) : fmtVal(v);
      tr.append(cf[mi] ? formattedCell(v, text, cf[mi]) : el("td", "num", text));
    }
    if (totalCol) for (const tmi of totalMis) {
      const mi = tmi ?? leftLeaf.mi;
      tr.append(el("td", "num xt-total", showVal(mi, total(mi, [leftLeaf.tuple], colTuples))));
    }
    tbody.append(tr);
    // Subtotal after the last row of each first-level group (measures on top, ≥ 2 Rows dimensions).
    const next = leftLeaves[ri + 1];
    if (tot.sub && rd >= 2 && !measureOnLeft && (!next || tupleKey([next.tuple[0]]) !== tupleKey([leftLeaf.tuple[0]]))) {
      const group = rowTuples.filter((t) => tupleKey([t[0]]) === tupleKey([leftLeaf.tuple[0]]));
      tbody.append(totalRow(`Subtotal · ${dimLabel(leftLeaf.tuple[0])}`, group, null, "xt-subtotal"));
    }
  });
  // Grand-total row(s): one, or one per measure when measures run down the left.
  if (tot.grand && rd > 0) {
    if (measureOnLeft) measures.forEach((name, mi) => tbody.append(totalRow("Grand total", rowTuples, mi, "xt-grand", name)));
    else tbody.append(totalRow("Grand total", rowTuples, null, "xt-grand"));
  }
  table.append(tbody);
  function totalRow(label, rts, onlyMi, cls, measureName) {
    const tr = el("tr", `xt-total ${cls}`);
    const th = el("th", "xt-rowhdr xt-total", label);
    th.colSpan = rd;
    tr.append(th);
    if (measureOnLeft) tr.append(el("th", "xt-rowhdr xt-meas xt-total", measureName ?? ""));
    for (const topLeaf of topLeaves) {
      const mi = onlyMi ?? topLeaf.mi ?? 0;
      tr.append(el("td", "num xt-total", showVal(mi, total(mi, rts, [topLeaf.tuple]))));
    }
    if (totalCol) for (const tmi of totalMis) { const mi = tmi ?? onlyMi ?? 0; tr.append(el("td", "num xt-total", showVal(mi, total(mi, rts, colTuples)))); }
    return tr;
  }

  const legend = conditionalLegend(cf, measures, fmtVal, partial ? rows.length : 0);
  if (bothMeasures || legend) {
    const wrap = el("div", "xt-wrap");
    if (bothMeasures) wrap.append(warn("Measures are on both shelves — showing them across the top. Put all measures on one shelf for a clean crosstab."));
    if (legend) wrap.append(legend);
    wrap.append(table);
    return wrap;
  }
  return table;
}

// --- conditional formatting (P37) ----------------------------------------
// Per result measure: its setting, value extent over the loaded rows, and token palette — or null.
function conditionalFor(sheet, measures, rows) {
  const all = sheet.format?.conditional ?? {};
  const mplan = planMeasures(sheet);
  let palette = null;
  return measures.map((name, mi) => {
    const cfg = all[measureKey(mplan[mi])];
    if (!isActive(cfg)) return null;
    palette ??= cfPalette();
    return { cfg, name, ext: extentOf(rows.map((r) => r.values[mi])), palette };
  });
}
// Scale colours from the chart tokens: sequential surface → blue; diverging orange ← surface → blue.
function cfPalette() {
  const cs = getComputedStyle(document.documentElement);
  const t = (n, fb) => cs.getPropertyValue(n).trim() || fb;
  return { surface: t("--surface", "#ffffff"), high: t("--chart-cat-1", "#2a78d6"), low: t("--chart-cat-6", "#eb6834"),
    inks: [t("--ink", "#1c1719"), t("--surface", "#ffffff"), "#000000", "#ffffff"] };
}
// One formatted cell: a rule's tone + icon wins; otherwise a scale tint (with a contrast-picked ink)
// or a data bar behind the number.
function formattedCell(v, text, { cfg, ext, palette }) {
  const td = el("td", "num xt-cf");
  const rule = matchRule(v, cfg.rules);
  const num = el("span", "xt-cf__num", text);
  if (rule) {
    td.classList.add(`xt-rule--${rule.tone}`);
    const ic = iconSpan("xt-cf__icon", TONE_ICON[rule.tone]);
    ic.setAttribute("aria-hidden", "true");
    td.title = `${CF_TONE_CHOICES.find(([k]) => k === rule.tone)[1]}: ${rule.op} ${rule.value}`;
    td.append(ic);
  } else if (cfg.mode === "scale") {
    const c = scaleColors(v, ext, cfg, palette);
    if (c) { td.style.background = c.bg; td.style.color = c.ink; }
  }
  if (!rule && cfg.mode === "bars") {
    const g = barGeometry(v, ext);
    if (g && g.width > 0) {
      const bar = el("span", `xt-bar${g.neg ? " xt-bar--neg" : ""}`);
      bar.style.left = `${g.left.toFixed(2)}%`;
      bar.style.width = `${g.width.toFixed(2)}%`;
      bar.setAttribute("aria-hidden", "true");
      td.append(bar);
    }
  }
  td.append(num);
  return td;
}
// A small key above the table: each scale's low / (mid) / high, each rule with its icon; and, while the
// table is still loading pages, that the scales cover only the loaded rows.
function conditionalLegend(cf, measures, fmtVal, loadedRows) {
  const items = [];
  cf.forEach((c, mi) => {
    if (!c) return;
    const name = measures[mi];
    if (c.cfg.mode === "scale" && c.ext) {
      const item = el("span", "xt-legend__item");
      const div = c.cfg.scale === "diverging";
      const lowEnd = div ? c.palette.low : c.palette.surface;
      const strip = el("span", "xt-legend__scale");
      strip.style.background = div
        ? `linear-gradient(to right, ${lowEnd}, ${c.palette.surface}, ${c.palette.high})`
        : `linear-gradient(to right, ${c.palette.surface}, ${c.palette.high})`;
      strip.setAttribute("aria-hidden", "true");
      item.append(el("span", "xt-legend__name", `${name}:`), el("span", null, fmtVal(c.ext.min)), strip, el("span", null, fmtVal(c.ext.max)));
      if (div) item.append(el("span", "xt-legend__note", `(centre ${fmtVal(midpointOf(c.ext, c.cfg.mid))})`));
      item.setAttribute("aria-label", `${name} colour scale from ${fmtVal(c.ext.min)} to ${fmtVal(c.ext.max)}${div ? `, centred on ${fmtVal(midpointOf(c.ext, c.cfg.mid))}` : ""}`);
      items.push(item);
    } else if (c.cfg.mode === "bars") {
      items.push(el("span", "xt-legend__item", `${name}: data bars (from zero)`));
    }
    for (const r of c.cfg.rules ?? []) {
      const item = el("span", `xt-legend__item xt-legend__rule xt-rule--${r.tone}`);
      item.append(iconSpan("xt-cf__icon", TONE_ICON[r.tone]), el("span", null, `${name} ${CF_OP_CHOICES.find(([k]) => k === r.op)[1]} ${fmtVal(r.value)}`));
      items.push(item);
    }
  });
  if (!items.length) return null;
  const box = el("div", "xt-legend");
  box.append(...items);
  if (loadedRows) box.append(el("span", "xt-legend__note", `Scales and bars use the ${loadedRows.toLocaleString("en-US")} rows loaded so far.`));
  return box;
}
