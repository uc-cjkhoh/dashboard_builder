// Browser check: every button's hover and pressed states are BRIGHTER than rest (relative luminance), in light and dark, on the Signal accent
// and a tight non-Signal one (Blue). Reads computed styles with a real pointer over each button — nothing reaches a ClickHouse.
// Run:  node tests/live/button-states-ui.mjs   (start the app first:
//   cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5236 ; stop it with fuser -k 5236/tcp)
// Env: APP_URL, CDP_PORT, CHROME_BIN.
import { launch } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5236';
let failed = 0, passed = 0;
const check = (name, ok, detail = '') => { if (ok) { console.log(`ok ${name}`); passed++; } else { console.log(`FAIL ${name} ${detail}`); failed++; } };

const CASES = [ // [label, markup, text-bearing?]  — each sits on the surface (or on glass) the real app puts it on
  ['.btn', '<button class="btn">Cancel</button>', 'surface'],
  ['.btn--ghost', '<button class="btn btn--ghost">Ghost</button>', 'surface'],
  ['.btn--primary', '<button class="btn btn--primary">Apply</button>', 'surface'],
  ['.btn--danger', '<button class="btn btn--danger">Delete</button>', 'surface'],
  ['.iconbtn', '<button class="iconbtn" aria-label="x">x</button>', 'surface'],
  ['.iconbtn--danger', '<button class="iconbtn iconbtn--danger" aria-label="x">x</button>', 'surface'],
  ['.tab', '<button class="tab"><span class="tab__label">Sheet</span></button>', 'glass'],
  ['.tab-add', '<button class="tab-add" aria-label="add">+</button>', 'glass'],
  ['.ws-tool', '<button class="ws-tool">Color</button>', 'glass'],
  ['.story-chip', '<button class="story-chip">Step</button>', 'glass'],
  ['.ws-select__btn', '<button class="ws-select__btn">Opt</button>', 'surface'],
  ['.ws-pages__btn', '<button class="ws-pages__btn">1</button>', 'surface'],
];

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(({ path, method }) => (path === '/api/connection' && method === 'GET' ? { json: { connected: false } } : null));
  await b.goto(APP + '/');
  await b.waitFor(`!!document.querySelector('.btn')`, { label: 'page rendered' });

  await b.evaluate(`(() => {
    window.__lum = (css) => { // relative luminance of a computed colour (rgb() or color(srgb …)), composited over __over when translucent
      const m = css.match(/[\\d.]+/g).map(Number); let [r, g, bl] = m.slice(0, 3); let a = m.length > 3 ? m[3] : 1;
      if (css.startsWith('color(')) { r *= 255; g *= 255; bl *= 255; }
      return { r, g, b: bl, a };
    };
    window.__rel = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    window.__over = (c, under) => ({ r: c.r * c.a + under.r * (1 - c.a), g: c.g * c.a + under.g * (1 - c.a), b: c.b * c.a + under.b * (1 - c.a), a: 1 });
    const stage = document.createElement('div'); stage.id = 'stage';
    stage.style.cssText = 'position:fixed;inset:0;z-index:99999;padding:24px;background:var(--surface);display:grid;gap:16px;align-content:start';
    document.body.append(stage);
    return true; })()`);

  const colour = async (css) => b.evaluate(`(() => { const p = document.createElement('i'); p.style.color = ${JSON.stringify(css)}; document.body.append(p); const v = getComputedStyle(p).color; p.remove(); return v; })()`);
  for (const scheme of ['light', 'dark']) for (const accent of ['signal', 'blue']) {
    await b.evaluate(`(async () => {
      const { themeVars, ACCENTS } = await import('/features/Core/theme-model.js');
      document.documentElement.dataset.scheme = ${JSON.stringify(scheme)};
      for (const [k, v] of Object.entries(themeVars({ accent: ${JSON.stringify(accent)} }, ${scheme === 'dark'}))) document.documentElement.style.setProperty(k, v);
      return true; })()`);
    for (const [label, markup, where] of CASES) {
      const id = 'c' + Math.random().toString(36).slice(2);
      await b.evaluate(`(() => { const s = document.getElementById('stage'); s.innerHTML = '';
        const box = document.createElement('div'); box.className = ${JSON.stringify(where === 'glass' ? 'glass' : '')};
        box.style.cssText = 'display:inline-flex;padding:24px;background:' + ${JSON.stringify(where === 'glass' ? 'var(--bg)' : 'var(--surface)')}; box.innerHTML = ${JSON.stringify(markup)};
        s.append(box); box.firstElementChild.id = ${JSON.stringify(id)}; return true; })()`);
      const rect = await b.evaluate(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      const read = () => b.evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); const cs = getComputedStyle(el);
        const under = __lum(getComputedStyle(el.parentElement).backgroundColor);
        const bg = __over(__lum(cs.backgroundColor), under);
        return { bg: __rel(bg), under: __rel(under), color: cs.color, outline: cs.outlineStyle !== 'none' && cs.outlineColor !== 'rgba(0, 0, 0, 0)', edge: cs.outlineStyle + cs.outlineColor }; })()`);
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
      await b.sleep(260);
      const rest = await read();
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
      await b.sleep(260);
      const hover = await read();
      await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
      await b.sleep(260);
      const active = await read();
      await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });
      const name = `${scheme}/${accent} ${label}`;
      // transparent at rest: rest = the surface under it, so "brighter" is judged against that; on white nothing is lighter, so a new or stronger edge is the cue
      const eps = 0.0005;
      check(`${name}: hover brighter than rest`, hover.bg > rest.bg + eps || (hover.bg >= rest.bg - eps && hover.outline && hover.edge !== rest.edge), JSON.stringify({ rest, hover }));
      check(`${name}: pressed at least as bright as hover`, active.bg >= hover.bg - eps, JSON.stringify({ hover, active }));
      check(`${name}: hover is visible (fill or edge differs from the surface)`, Math.abs(hover.bg - hover.under) > eps || hover.outline, JSON.stringify(hover));
    }
  }
} catch (e) { console.log('FAIL', e.stack ?? e.message); failed++; }
finally { await b?.close(); }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
