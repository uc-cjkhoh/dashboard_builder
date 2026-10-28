// Browser check for the widget runtime (P24a): two charts live in two containers at once, and disposing or re-drawing
// one never touches the other. Drives the real chart.js (and ECharts) in headless Chromium — no ClickHouse needed.
// Env: APP_URL (default http://localhost:5193), SHOTS_DIR, CDP_PORT, CHROME_BIN.
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5193';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'runtime-ui-shots');
mkdirSync(SHOTS, { recursive: true });
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (c, m) => { if (!c) throw new Error(m); };
let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(({ path }) => (path === '/api/connection' ? { json: { connected: false } } : null));
  await b.goto(APP + '/');
  await b.waitFor(`!!document.getElementById('conn-connect')`, { label: 'app loaded' });
  await b.evaluate(`(async () => {
    const chart = await import('/features/Dashboard/chart.js');
    window.__chart = chart;
    document.querySelector('.worksheet')?.remove();
    const host = document.createElement('div');
    host.id = 'rt-host'; host.style.cssText = 'position:fixed;inset:0;display:grid;grid-template-columns:1fr 1fr;gap:8px;background:var(--surface);z-index:9999';
    for (const id of ['rt-a', 'rt-b']) { const d = document.createElement('div'); d.id = id; d.style.cssText = 'position:relative;height:300px'; host.append(d); }
    document.body.append(host);
    return true; })()`);
  const spec = (name, data) => `({ type: 'bar', categories: ['a', 'b', 'c'], series: [{ name: ${JSON.stringify(name)}, data: ${JSON.stringify(data)} }], format: {} })`;
  await check('two containers each hold their own live chart', async () => {
    await b.evaluate(`(() => { __chart.renderChart(document.getElementById('rt-a'), ${spec('A', [1, 2, 3])}); __chart.renderChart(document.getElementById('rt-b'), ${spec('B', [3, 2, 1])}); return true; })()`);
    const n = await b.evaluate(`['rt-a', 'rt-b'].map((id) => document.querySelectorAll('#' + id + ' svg').length)`);
    must(n[0] === 1 && n[1] === 1, `svg counts ${n}`);
    must(await b.evaluate(`__chart.hasChartInstance(document.getElementById('rt-a')) && __chart.hasChartInstance(document.getElementById('rt-b'))`), 'instances');
    await b.screenshot(join(SHOTS, 'two-views.png'));
  });
  await check('re-drawing and disposing one container leaves the other alone', async () => {
    await b.evaluate(`(() => { const a = document.getElementById('rt-a'); __chart.disposeChart(a); a.replaceChildren(); __chart.renderChart(a, ${spec('A2', [9, 9, 9])}); return true; })()`);
    must(await b.evaluate(`document.querySelectorAll('#rt-b svg').length === 1 && __chart.hasChartInstance(document.getElementById('rt-b'))`), 'b was disturbed');
    await b.evaluate(`(() => { const a = document.getElementById('rt-a'); __chart.disposeChart(a); a.replaceChildren(); return true; })()`);
    must(await b.evaluate(`!__chart.hasChartInstance(document.getElementById('rt-a')) && __chart.hasChartInstance(document.getElementById('rt-b'))`), 'dispose crossed containers');
  });
  await check('sizing one chart does not resize the other', async () => {
    await b.evaluate(`(() => { __chart.renderChart(document.getElementById('rt-a'), ${spec('A', [1, 2, 3])}); __chart.sizeChart(document.getElementById('rt-a'), { width: 200, height: 120 }); return true; })()`);
    const w = await b.evaluate(`['rt-a', 'rt-b'].map((id) => Math.round(document.querySelector('#' + id + ' svg').getBoundingClientRect().width))`);
    must(w[0] === 200 && w[1] > 300, `widths ${w}`);
  });
} catch (e) {
  console.log(`FAIL (setup): ${e.stack ?? e.message}`); failed++;
} finally { await b?.close(); }
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
