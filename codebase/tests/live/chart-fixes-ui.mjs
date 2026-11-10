// Browser check for the chart fixes of the beginner test (fix-charts): the real dev app (APP_URL, default http://localhost:5242)
// in headless Chromium (tests/live/cdp.mjs); charts are drawn straight through chart.js / render-kpi.js, so no ClickHouse is needed.
// Checks: Label on a colour-split bar, KPI member note, scatter axes not forced to 0, analytics labels off the line, calm palette
// (no red category, calm dark accent), rotated labels in a narrow widget stay inside it. Screenshots light + dark in SHOTS_DIR.
// Run: node tests/live/chart-fixes-ui.mjs   (cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5242)
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5242';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'chart-fixes-shots');
mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const check = async (name, fn) => { try { await fn(); console.log(`ok ${name}`); } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; } };
const must = (c, m) => { if (!c) throw new Error(m); };

const b = await launch({});
try {
  await b.mock(({ path }) => (path === '/api/connection' ? { json: { connected: false } } : null));
  await b.goto(APP + '/');
  await b.waitFor(`!!window.echarts`, { label: 'echarts' });
  await b.evaluate(`(async () => { window.__chart = await import('/features/Dashboard/chart.js'); window.__kpi = await import('/features/Dashboard/render-kpi.js'); return true; })()`);
  const COUNTRIES = ['Indonesia', 'Malaysia', 'Philippines', 'Singapore', 'Thailand', 'Vietnam'];
  const host = (w, h, id = 'cf-host') => `(() => { document.querySelectorAll('#${id}').forEach((e) => e.remove());
    const h = document.createElement('div'); h.id = '${id}'; h.style.cssText = 'position:fixed;left:280px;top:70px;z-index:99999;width:${w}px;height:${h}px;background:var(--surface)'; document.body.append(h); return h; })()`;
  const wait = () => b.evaluate(`new Promise((r) => setTimeout(() => r(true), 700))`);
  const texts = (id = 'cf-host') => b.evaluate(`[...document.querySelectorAll('#${id} svg text')].map((t) => t.textContent)`);

  for (const scheme of ['light', 'dark']) {
    await b.evaluate(`document.documentElement.dataset.scheme = ${JSON.stringify(scheme)}; true`);

    await check(`${scheme}: a Label on a colour-split bar draws the label of every cell`, async () => {
      await b.evaluate(`(() => { const h = ${host(640, 360)};
        const cats = ${JSON.stringify(COUNTRIES)};
        window.__chart.renderChart(h, { type: 'bar', categories: cats, format: {},
          series: ['Cancelled', 'Delivered', 'Shipped'].map((n, si) => ({ name: n, data: cats.map((_, i) => (i + 1) * (si + 2) * 100) })),
          seriesLabels: ['Cancelled', 'Delivered', 'Shipped'].map((n, si) => cats.map((_, i) => String((i + 1) * (si + 2) * 100) + '#')) });
        return true; })()`);
      await wait();
      await b.screenshot(join(SHOTS, `label-split-${scheme}.png`));
      const t = await texts();
      must(t.filter((x) => x.endsWith('#')).length === 18, `labels drawn: ${t.filter((x) => x.endsWith('#')).length}`);
    });

    await check(`${scheme}: KPI with a dimension names the member and says it is the last of N`, async () => {
      const note = await b.evaluate(`(() => { const h = ${host(360, 200)}; h.append(window.__kpi.kpiView(['sum quantity'], ${JSON.stringify(COUNTRIES)}, [{ data: [10, 20, 30, 40, 50, 16500] }], 1, (v) => String(v), {}));
        return h.querySelector('.widget__kpi-sub').textContent; })()`);
      await b.screenshot(join(SHOTS, `kpi-${scheme}.png`));
      must(/Vietnam · last of 6/.test(note), `note: ${note}`);
    });

    await check(`${scheme}: scatter axes are not forced to start at 0`, async () => {
      const r = await b.evaluate(`(async () => { const h = ${host(560, 360)};
        window.__chart.renderChart(h, { type: 'scatter', categories: ${JSON.stringify(COUNTRIES)}, format: {},
          series: [{ name: 'x', data: [20000, 20500, 21000, 21500, 22000, 22500] }, { name: 'y', data: [800, 820, 780, 850, 830, 900] }] });
        await new Promise((r) => setTimeout(r, 500));
        const o = window.echarts.getInstanceByDom(h.querySelector('.ws-chart-canvas')).getOption();
        const ax = (a) => [].concat(a)[0].scale; return [ax(o.xAxis), ax(o.yAxis)]; })()`);
      await b.screenshot(join(SHOTS, `scatter-${scheme}.png`));
      must(r[0] === true && r[1] === true, 'axes use scale: ' + JSON.stringify(r));
    });

    await check(`${scheme}: reference line and band labels sit on a surface backing, the trend names its fit in words`, async () => {
      await b.evaluate(`(() => { const h = ${host(640, 360)};
        const cats = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'];
        window.__chart.renderChart(h, { type: 'line', categories: cats, format: {}, series: [{ name: 'sum quantity', data: [1700, 1500, 1800, 1200, 1900, 1100, 1600, 1750] }],
          analytics: { measure: 0, ref: { name: 'Average', value: 1566.55 }, band: { name: 'P90–P95 (shown rows)', from: 1750, to: 1850 },
            trend: { measure: 0, name: 'Trend', short: 'Trend · poor fit (R² -0.12) · n = 8', data: [1600, 1590, 1580, 1570, 1560, 1550, 1540, 1530] } } });
        return true; })()`);
      await wait();
      await b.screenshot(join(SHOTS, `analytics-${scheme}.png`));
      const o = await b.evaluate(`(() => { const s = window.echarts.getInstanceByDom(document.querySelector('#cf-host .ws-chart-canvas')).getOption().series[0]; return { line: s.markLine.label[0] ?? s.markLine.label, area: s.markArea.label[0] ?? s.markArea.label }; })()`);
      must(o.line.backgroundColor && o.area.backgroundColor, 'labels carry a backing');
      must((await texts()).some((x) => x.includes('poor fit (R² -0.12)')), 'trend says poor fit');
    });

    await check(`${scheme}: rotated category labels in a narrow widget stay inside it (no clipped "ines")`, async () => {
      const r = await b.evaluate(`(async () => { const h = ${host(300, 150)}; h.className = 'board-widget__body ws-chart'; h.style.position = 'fixed'; // a dashboard widget's body: the chart fills it (board.css)
        window.__chart.renderChart(h, { type: 'bar', categories: ${JSON.stringify(COUNTRIES)}, format: {}, series: [{ name: 'q', data: [5, 4, 6, 3, 7, 2] }] });
        await new Promise((r) => setTimeout(r, 700));
        const H = h.getBoundingClientRect();
        const out = [...h.querySelectorAll('svg text')].map((t) => { const r = t.getBoundingClientRect(); return { s: t.textContent, l: r.left - H.left, r: r.right - H.left, b: r.bottom - H.top }; })
          .filter((x) => x.s && (x.l < -0.5 || x.r > H.width + 0.5 || x.b > H.height + 0.5));
        return out; })()`);
      await b.screenshot(join(SHOTS, `narrow-${scheme}.png`));
      must(r.length === 0, 'outside the widget: ' + JSON.stringify(r));
    });

    await check(`${scheme}: a pie with few slices shows each slice's percent; many slices stay unlabelled`, async () => {
      const draw = (n) => b.evaluate(`(async () => { const h = ${host(420, 300)}; const cats = Array.from({ length: ${n} }, (_, i) => 'm' + i);
        window.__chart.renderChart(h, { type: 'pie', categories: cats, format: {}, series: [{ name: 'q', data: cats.map((_, i) => 10 + i * 5) }] });
        await new Promise((r) => setTimeout(r, 600)); return [...h.querySelectorAll('svg text')].map((t) => t.textContent).filter((x) => /%$/.test(x)).length; })()`);
      must(await draw(4) === 4, 'four slices, four percents');
      await b.screenshot(join(SHOTS, `pie-${scheme}.png`));
      must(await draw(12) === 0, 'twelve slices, none');
    });

    await check(`${scheme}: histogram of whole numbers labels bins 1, 2, 3 or 3–4`, async () => {
      const t = await b.evaluate(`(async () => { const h = ${host(420, 300)};
        window.__chart.renderChart(h, { type: 'histogram', whole: true, bins: [{ x0: 1, x1: 2, count: 4 }, { x0: 2, x1: 3, count: 7 }, { x0: 3, x1: 5, count: 2 }], format: {} });
        await new Promise((r) => setTimeout(r, 500)); return [...h.querySelectorAll('svg text')].map((x) => x.textContent); })()`);
      must(t.includes('1') && t.includes('3–4') && !t.some((x) => x.includes('1–2')), JSON.stringify(t));
    });

    await check(`${scheme}: no category token is red; the dark accent is calm`, async () => {
      const r = await b.evaluate(`(() => { const cs = getComputedStyle(document.documentElement);
        const hue = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.trim().slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
          if (!d) return 0; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
        return { cats: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cs.getPropertyValue('--chart-cat-' + i)).map((x) => [x.trim(), Math.round(hue(x))]), accent: cs.getPropertyValue('--accent').trim() }; })()`);
      must(r.cats.every(([, h]) => !(h >= 345 || h <= 12)), 'red hue: ' + JSON.stringify(r.cats));
      if (scheme === 'dark') must(r.accent !== '#c3df5a', 'dark accent still neon: ' + r.accent);
    });
  }
} finally { await b.close?.(); }
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
