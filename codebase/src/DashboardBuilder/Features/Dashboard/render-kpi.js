import { changeOf, toneOf, pctText, targetProgress } from "./period-model.js";
import { el } from "./render-dom.js";

// KPI tiles and the inline sparkline (P11 / P35), drawn from a result; no editor state.

// KPI tiles. With no dimension each measure is a single big number; with a dimension (P11) the
// headline is the latest category's value under an inline sparkline of the trend.
export function kpiView(measures, categories, series, dimCount, fmtVal, card = {}) {
  const wrap = el("div", "ws-kpi-row");
  const f = card.format ?? {};
  measures.forEach((name, i) => {
    const data = series[i].data;
    const tile = el("div", "ws-kpi");
    if (dimCount === 0) {
      tile.append(el("div", "widget__kpi-num", fmtVal(data[0])));
      tile.append(el("div", "widget__kpi-sub", name));
      // P35 scorecard: change vs the comparison range — arrow + signed % + tone (never colour alone).
      if (card.prev) {
        const ch = changeOf(data[0], card.prev[i]);
        const tone = toneOf(ch.dir, f.downIsGood);
        const line = el("div", `ws-kpi__change ws-kpi__change--${tone}`);
        line.append(el("span", "ws-kpi__arrow", ch.dir === "up" ? "▲" : ch.dir === "down" ? "▼" : "■"),
          el("span", null, ` ${pctText(ch.pct)} vs ${card.name}`));
        line.title = `${card.name}: ${fmtVal(card.prev[i])}`;
        line.setAttribute("aria-label", `${ch.dir === "flat" ? "No change" : ch.dir === "up" ? "Up" : "Down"} ${pctText(ch.pct)} versus ${card.name} (${fmtVal(card.prev[i])})${tone === "neutral" ? "" : `, ${tone}`}`);
        tile.append(line);
      }
      // Target (first measure): progress bar + "82% of 10,000".
      const goal = i === 0 ? targetProgress(data[0], f.target) : null;
      if (goal) {
        const bar = el("div", `ws-kpi__target${goal.met ? " is-met" : ""}`);
        const fill = el("span", "ws-kpi__target-fill");
        fill.style.width = `${Math.min(100, Math.max(0, goal.pct)).toFixed(1)}%`;
        bar.append(fill);
        bar.setAttribute("role", "img");
        bar.setAttribute("aria-label", `${goal.pct.toFixed(0)}% of target ${fmtVal(f.target)}`);
        tile.append(bar, el("div", "widget__kpi-sub", `${goal.met ? "✓ " : ""}${goal.pct.toFixed(0)}% of ${fmtVal(f.target)}`));
      }
    } else {
      tile.append(el("div", "widget__kpi-num", fmtVal(data[data.length - 1])));
      tile.append(sparkline(data));
      const sub = el("div", "widget__kpi-sub", name);
      const lastCat = categories[categories.length - 1];
      if (lastCat != null) sub.title = `latest: ${lastCat}`;
      tile.append(sub);
    }
    wrap.append(tile);
  });
  return wrap;
}

// A tiny inline SVG sparkline (no ECharts instance).
function sparkline(data) {
  const NS = "http://www.w3.org/2000/svg";
  const w = 132, h = 30, pad = 3;
  const nums = data.map((v) => Number(v) || 0);
  const min = Math.min(...nums), max = Math.max(...nums), span = max - min || 1, n = nums.length;
  const x = (i) => (n <= 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1));
  const y = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "ws-spark");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const poly = document.createElementNS(NS, "polyline");
  poly.setAttribute("class", "ws-spark__line");
  poly.setAttribute("fill", "none");
  poly.setAttribute("points", nums.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" "));
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("class", "ws-spark__dot");
  dot.setAttribute("cx", x(n - 1).toFixed(1));
  dot.setAttribute("cy", y(nums[n - 1]).toFixed(1));
  dot.setAttribute("r", "2.5");
  svg.append(poly, dot);
  return svg;
}
