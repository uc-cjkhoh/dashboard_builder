// Browser check for date axis labels (axis-labels): the real dev app (APP_URL, default http://localhost:5233) in headless
// Chromium (tests/live/cdp.mjs). Draws charts with many datetime categories straight through chart.js at small widths and
// zoomed-out scales and asserts no two axis labels overlap, first and last stay. Run: node tests/live/axis-labels-ui.mjs
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5233';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'axis-labels-shots');
mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const check = async (name, fn) => { try { await fn(); console.log(`ok ${name}`); } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; } };
const must = (c, m) => { if (!c) throw new Error(m); };

const b = await launch({});
try {
  await b.mock(({ path }) => (path === '/api/connection' ? { json: { connected: false } } : null));
  await b.goto(APP + '/');
  await b.waitFor(`!!window.echarts`, { label: 'echarts' });
  await b.evaluate(`(async () => { window.__chart = await import('/features/Dashboard/chart.js'); return true; })()`);

  // Draw a chart in a w x h box; returns the visible date-looking labels' boxes and any overlaps.
  const draw = (o) => b.evaluate(`(async () => {
    document.querySelectorAll('#ax-host').forEach((e) => e.remove());
    const host = document.createElement('div'); host.id = 'ax-host';
    host.style.cssText = 'position:fixed;left:280px;top:70px;z-index:99999;width:${o.w}px;height:${o.h}px;background:#fff';
    document.body.append(host);
    const n = ${o.n}, step = ${o.stepMin} * 60000, t0 = Date.UTC(2026, 9, 1);
    const cats = Array.from({ length: n }, (_, i) => new Date(t0 + i * step).toISOString().slice(0, ${o.len ?? 19}).replace('T', ' '));
    window.__chart.renderChart(host, { type: '${o.type ?? 'line'}', orientation: '${o.orient ?? 'vertical'}', categories: cats,
      series: [{ name: 'v', data: cats.map((_, i) => i % 7 + 1) }], format: {}, dateLabels: '${o.mode ?? 'thin'}', dateStepMs: ${o.stepMin} * 60000 });
    await new Promise((r) => setTimeout(r, 700));
    const texts = [...host.querySelectorAll('svg text')].filter((t) => /\\d{4}|\\d{2}-\\d{2}|\\d{2}:\\d{2}/.test(t.textContent));
    const H = host.getBoundingClientRect();
    const boxes = texts.map((t) => { const r = t.getBoundingClientRect(); return { s: t.textContent, l: r.left - H.left, r: r.right - H.left, t: r.top - H.top, b: r.bottom - H.top }; });
    const hit = (p, q) => p.l < q.r - 0.5 && q.l < p.r - 0.5 && p.t < q.b - 0.5 && q.t < p.b - 0.5;
    const overlaps = []; for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (hit(boxes[i], boxes[j])) overlaps.push([boxes[i].s, boxes[j].s]);
    const inst = window.echarts.getInstanceByDom(host.querySelector('.ws-chart-canvas'));
    const ax = [].concat('${o.orient ?? 'vertical'}' === 'horizontal' ? inst.getOption().yAxis : inst.getOption().xAxis)[0];
    const ends = [ax.axisLabel.interval(0), ax.axisLabel.interval(n - 1)];
    let want = 0; for (let i = 0; i < n; i++) if (ax.axisLabel.interval(i)) want++;
    return { ends, want, n: boxes.length, overlaps, labels: boxes.map((x) => x.s), cats: [cats[0], cats[cats.length - 1]], out: boxes.filter((x) => x.l < -0.5 || x.r > ${o.w} + 0.5 || x.b > ${o.h} + 0.5).map((x) => x.s) };
  })()`);

  const scale = (f, w, h) => b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: f, mobile: false });
  const cases = [
    ['line, 60 datetimes hourly, 420px wide', { w: 420, h: 300, n: 60, stepMin: 60 }],
    ['line, 200 datetimes 5-min, 600px wide', { w: 600, h: 300, n: 200, stepMin: 5 }],
    ['bar, 90 days, 360px wide (date + time part)', { w: 360, h: 300, n: 90, stepMin: 1440 }],
    ['horizontal bar, 60 datetimes, 300px tall', { w: 500, h: 300, n: 60, stepMin: 60, type: 'bar', orient: 'horizontal' }],
    ['line, 60 datetimes, 170px wide (upright)', { w: 170, h: 320, n: 60, stepMin: 60 }],
    ['line, 400 datetimes, 1200px wide', { w: 1200, h: 300, n: 400, stepMin: 30 }],
  ];
  for (const [scaleF, label] of [[1, '100%'], [0.5, 'zoomed out 50%']]) {
    await scale(scaleF, Math.round(1400 / scaleF), Math.round(900 / scaleF));
    for (const [name, o] of cases) await check(`${name} @ ${label}: no overlap, first and last kept`, async () => {
      const r = await draw(o);
      await b.screenshot(join(SHOTS, `${name.replace(/\W+/g, '-')}-${scaleF}.png`));
      must(r.n > 1, `only ${r.n} labels`);
      must(r.overlaps.length === 0, `overlaps: ${JSON.stringify(r.overlaps.slice(0, 3))} (of ${r.n} labels)`);
      must(r.out.length === 0, `labels outside the chart: ${r.out.slice(0, 3)}`);
      must(r.n === r.want, `drawn ${r.n} labels, planned ${r.want} (first/last hidden by the renderer?)`);
      must(r.ends[0] === true && r.ends[1] === true, `first/last not kept: ${r.ends}`);
    });
  }
  await scale(1, 1400, 900);
  await check('redraws on resize', async () => {
    await draw({ w: 800, h: 300, n: 60, stepMin: 60 });
    const first = await b.evaluate(`document.querySelectorAll('#ax-host svg text').length`);
    await b.evaluate(`document.getElementById('ax-host').style.width = '320px'`);
    await b.sleep(600);
    const r = await b.evaluate(`(() => { const t = [...document.querySelectorAll('#ax-host svg text')].filter((x) => /\\d{2}-\\d{2}|\\d{2}:\\d{2}/.test(x.textContent)).map((x) => x.getBoundingClientRect()).filter((x) => x.width > 0); for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) if (t[i].left < t[j].right - .5 && t[j].left < t[i].right - .5 && t[i].top < t[j].bottom - .5 && t[j].top < t[i].bottom - .5) return [i, j]; return null; })()`);
    must(r === null, `overlap after resize: ${first} labels before; pair ${r}`);
    const after = await b.evaluate(`document.querySelectorAll('#ax-host svg text').length`);
    must(after !== first, `labels did not change with the width (${first} -> ${after})`);
    for (const w of [150, 800]) { // upright and back again
      await b.evaluate(`document.getElementById('ax-host').style.width = '${w}px'`);
      await b.sleep(600);
      const r2 = await b.evaluate(`(() => { const t = [...document.querySelectorAll('#ax-host svg text')].filter((x) => /\\d{2}-\\d{2}|\\d{2}:\\d{2}/.test(x.textContent)).map((x) => x.getBoundingClientRect()); for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) if (t[i].left < t[j].right - .5 && t[j].left < t[i].right - .5 && t[i].top < t[j].bottom - .5 && t[j].top < t[i].bottom - .5) return [i, j]; return t.length; })()`);
      must(typeof r2 === 'number' && r2 >= 2, `width ${w}: ${JSON.stringify(r2)}`);
    }
  });
  await check('no canvas 2d context: falls back to an estimated width instead of throwing', async () => {
    await b.goto(APP + '/');
    await b.waitFor(`!!window.echarts`, { label: 'echarts' });
    await b.evaluate(`(async () => { HTMLCanvasElement.prototype.getContext = () => null; window.__chart = await import('/features/Dashboard/chart.js'); return true; })()`);
    const r = await draw({ w: 420, h: 300, n: 60, stepMin: 60 });
    must(r.n >= 2 && r.overlaps.length === 0, `labels ${r.n}, overlaps ${r.overlaps.length}`);
  });
} finally { await b.close?.(); }
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
