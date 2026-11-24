// Browser checks for the Color flyout field menu: Add field is its own row, the dashed zone exists only with pills, and the list opens on hover as a side menu border to border with the flyout (right side only, shrinking on a narrow worksheet).
// Real Chromium over CDP (tests/live/cdp.mjs), /api/* mocked. Run:  node tests/live/colour-menu-ui.mjs   (start the app first: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5262 ; stop it with fuser -k 5262/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5262';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'marks-colour-ui-shots');
mkdirSync(SHOTS, { recursive: true });
const SCHEME = process.env.SCHEME === 'dark' ? 'dark' : 'light'; // SCHEME=dark loads the page in the dark scheme (set before load)

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = {
  orders: [['amount', 'Float64', 'numeric'], ['qty', 'Int32', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text'], ['discount', 'Float64', 'numeric'], ['placed', 'DateTime', 'temporal']],
  customers: [['country', 'String', 'text']],
};
const REGIONS = ['APAC', 'EU', 'US', 'LATAM', 'MEA', 'CA', 'UK', 'JP'];
const DIMVALS = { region: REGIONS, channel: ['web', 'shop', 'app'], country: ['DE', 'FR'] };
const queries = [];     // every /api/query body, in order
let tables = ['orders', 'customers'];
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: tables };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  if (/\/columns\/\w+\/distinct/.test(path)) return { json: REGIONS };
  if (path === '/api/query') {
    queries.push(body);
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    // every dimension has its own members; several dimensions give the full product (a group per pair), the way a group-by does
    const members = dims.map((d) => DIMVALS[d.column] ?? REGIONS);
    let combos = [[]];
    for (const m of members) combos = combos.flatMap((c) => m.map((x) => [...c, x]));
    const value = (m, i, r) => (m.column === 'discount' ? (r - Math.floor(combos.length / 2)) * 10 : 10 * (r + 1) + i); // `discount` crosses zero; the rest are positive
    return { json: {
      rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: combos.map((keys, r) => ({ keys, values: (body.measures ?? []).map((m, i) => value(m, i, r)) })),
      truncated: false } };
  }
  return null;
}

// ---- tiny test runner ---------------------------------------------------------------------------------------
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; }
  catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const J = JSON.stringify;
const deepEq = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= 1); // measured pixel extents: one pixel of anti-aliasing is not a difference


let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const toastText = () => ev(`(document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent)`);

  // page helpers: HTML5 drag-and-drop with a real DataTransfer, text lookup, dialog typing
  const installHelpers = () => ev(`(() => {
    window.__t = {
      chip: ${PAGE_CHIP},
      drag(chip, target) {
        const dt = new DataTransfer();
        chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        chip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      },
      zone: (kind) => document.querySelector('.ws-shelf--' + kind + ' .ws-shelf__zone'),
      pills: (kind) => [...document.querySelectorAll('.ws-shelf--' + kind + ' .ws-pill')].map((p) => p.querySelector('.ws-pill__text')?.textContent),
      btn: (text, root = document) => [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === text || x.getAttribute('aria-label') === text),
    };
    return true; })()`);
  const dragChip = (name, target) => ev(`(() => { const c = __t.chip(${J(name)}); if (!c) throw new Error('no field chip ${name}'); __t.drag(c, ${target}); return true; })()`);
  const pills = (kind) => ev(`__t.pills(${J(kind)})`);
  const dlg = `document.querySelector('dialog.calc-dialog[open]')`;
  const focusAndType = async (sel, text) => {
    await ev(`(() => { const e = document.querySelector(${J(sel)}); e.focus(); e.select?.(); return true; })()`);
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await b.type(text);
  };
  const openNewDialog = async () => {
    await ev(NEW_CALC);
    await waitFor(`${dlg} !== null`, 'calc dialog open');
  };
  const fillDialog = async (name, formula) => {
    await focusAndType('.calc-dialog input.input', name);
    await focusAndType('.calc-dialog textarea.formula', formula);
    await ev(`document.querySelector('.calc-dialog textarea.formula').blur()`);
  };
  const saveDisabled = () => ev(`[...${dlg}.querySelectorAll('.dialog__foot button')].find((x) => x.textContent === 'Save').disabled`);
  const saveDialog = async () => {
    await ev(`[...${dlg}.querySelectorAll('.dialog__foot button')].find((x) => x.textContent === 'Save').click()`);
    await waitFor(`${dlg} === null`, 'dialog closed after save');
  };
  const newCalc = async (name, formula) => { await openNewDialog(); await fillDialog(name, formula); await saveDialog(); };
  const calcMenu = async (name, item) => {
    await ev(`(() => { const c = __t.chip(${J(name)}); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); return true; })()`);
    await ev(`(() => { const c = __t.chip(${J(name)}); [...document.querySelectorAll('.ctx-menu .menu__item')].find((x) => x.textContent.trim() === ${J(item)}).click(); return true; })()`);
  };
  const confirmOpen = `[...document.querySelectorAll('dialog[open]')].find((d) => !d.classList.contains('calc-dialog') && !d.classList.contains('calc-manager'))`;
  const chartText = () => ev(`document.getElementById('ws-chart').textContent`);
  const canvasDrawn = () => ev(`!!document.querySelector('#ws-chart canvas, #ws-chart svg')`);
  const until = async (fn, label, timeout = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for: ${label}`); await b.sleep(50); } };
  // Wait until no new /api/query has arrived for `quiet` ms (polling, not a fixed sleep).
  const settle = async (quiet = 300) => { let n = -1; for (let i = 0; i < 60 && n !== queries.length; i++) { n = queries.length; await b.sleep(quiet); } };
  const lastQuery = () => queries[queries.length - 1];
  const hasKey = (o, k) => J(o).includes(`"${k}"`);

  // ---- setup: connect, add the two tables, open a worksheet -----------------------------------------------------
  if (SCHEME === 'dark') await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "new MutationObserver((_, o) => { if (document.documentElement) { document.documentElement.setAttribute('data-scheme', 'dark'); o.disconnect(); } }).observe(document, { childList: true })" }); // read at load
  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases listed');
  await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
  for (const t of ['orders', 'customers'])
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 2 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'both tables loaded');
  await relateTables(ev, waitFor, ['orders', 'region', 'customers', 'country']); // an unrelated table is held out of the field pane
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await installHelpers();
  await waitFor(`!!__t.chip('region')`, 'field pane filled');

  const filterTool = `document.querySelector('.ws-tool[aria-label^="Filters"]')`;
  const opSelect = `document.querySelector('select[aria-label^="Filter operator for"]')`;
  const shot = async (name) => { try { writeFileSync(join(SHOTS, `${name}-${SCHEME}.png`), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } };
  const fmtTool = `document.querySelector('.ws-viewbar__btn[aria-label="Format"]')`;
  const colTool = `document.querySelector('.ws-tool[data-tool="color"]')`; // the Colour controls live in the Color tile's flyout (D151)
  const rect = (sel) => ev(`(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`);
  const fly = `document.getElementById('ws-toolfly')`;
  const addBtn = `${fly}.querySelector('.ws-picker__btn')`;
  const menu = `document.querySelector('.ws-picker__box--side')`;
  const group = `${fly}.querySelector('.ws-flyedit__group')`;
  const mouse = (type, x, y) => b.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0 });
  const centre = (r) => [r.l + r.w / 2, r.t + r.h / 2];

  await check('empty Colour: no dashed zone, Add field is the slot', async () => {
    await ev(`${colTool}.click()`);
    await waitFor(`!!${fly} && !${fly}.hidden`, 'flyout open');
    await b.sleep(600); // the flyout's entry motion
    must(await ev(`${fly}.querySelector('.ws-toolpanel__zone') === null`), 'zone present with no pills');
    must(await ev(`${addBtn}.parentElement.classList.contains('ws-toolpanel__slot')`), 'Add field not directly in the slot');
    const slotR = await rect(group), btnR = await rect(addBtn);
    const cs = await ev(`(() => { const c = getComputedStyle(${addBtn}, '::before'); return { style: c.borderTopStyle, width: c.borderTopWidth }; })()`);
    must(cs.style === 'dotted' && cs.width === '1px', `Add field border ${J(cs)}`);
    const parts = await ev(`(() => { const r = (e) => { const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }; const btn = ${addBtn}; const [bx, by] = r(btn); const kids = [...btn.children].map(r); const l = Math.min(...[...btn.children].map((k) => k.getBoundingClientRect().left)), rr = Math.max(...[...btn.children].map((k) => k.getBoundingClientRect().right)); return { dy: kids.map(([, y]) => y - by), dx: (l + rr) / 2 - bx }; })()`);
    must(parts.dy.every((d) => Math.abs(d) <= 1) && Math.abs(parts.dx) <= 1, `Add field icon and label not centred in the button ${J(parts)}`);
    must(Math.abs(btnR.w - (slotR.w - 32)) <= 1 && Math.abs(btnR.l - (slotR.l + 16)) <= 1, `Add field not the slot's full width ${J(btnR)} ${J(slotR)}`);
    must(await ev(`${menu} !== null && ${menu}.hidden && ${menu}.parentElement === document.querySelector('.worksheet')`), 'side menu not mounted hidden beside the flyout');
    await shot('colour-menu-closed');
  });
  await check('hover opens the menu, border to border with the flyout, level with the Color section', async () => {
    const r = await rect(addBtn);
    const [x, y] = centre(r);
    await mouse('mouseMoved', x, y);
    await waitFor(`!${menu}.hidden`, 'menu open on hover');
    const f = await rect(fly), m = await rect(menu), g = await rect(group);
    must(Math.abs(m.l - (f.r - 1)) <= 1, `menu.left ${m.l} vs fly.right ${f.r}`);
    must(m.l >= f.r - 1.5, 'menu overlaps the flyout');
    must(Math.abs(m.t - g.t) <= 1, `menu.top ${m.t} vs group.top ${g.t}`);
    must(await ev(`document.activeElement !== ${menu}.querySelector('input')`), 'hover stole focus');
    must((await ev(`${menu}.querySelectorAll('.ws-picker__item').length`)) > 0, 'menu lists no fields');
    await shot('colour-menu-open');
  });
  await check('the pointer can cross from the button to the menu without it closing', async () => {
    const m = await rect(menu), r = await rect(addBtn);
    const [x0, y0] = centre(r);
    const x1 = m.l + 40, y1 = m.t + 60;
    for (let i = 0; i <= 10; i++) await mouse('mouseMoved', x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * i / 10);
    await b.sleep(400);
    must(await ev(`!${menu}.hidden`), 'menu closed while the pointer was over it');
    await mouse('mouseMoved', 5, 5);
    await waitFor(`${menu}.hidden`, 'menu closed after the pointer left');
  });
  await check('picking a field closes the menu, shows the pill and puts the zone back', async () => {
    const r = await rect(addBtn);
    await mouse('mouseMoved', ...centre(r));
    await waitFor(`!${menu}.hidden`, 'menu open');
    await ev(`[...${menu}.querySelectorAll('.ws-picker__item')].find((x) => x.textContent.includes('region')).click()`);
    await waitFor(`${fly}.querySelector('.ws-toolpanel__zone .ws-pill') !== null`, 'pill in the zone');
    must(await ev(`${menu}.hidden`), 'menu still open after the pick');
    must(await ev(`${addBtn}.parentElement.classList.contains('ws-toolpanel__slot') && ${fly}.querySelector('.ws-toolpanel__zone .ws-picker__btn') === null`), 'Add field inside the zone');
    const z = await rect(`${fly}.querySelector('.ws-toolpanel__zone')`), a = await rect(addBtn);
    must(a.t >= z.b, 'Add field is not on the row below the zone');
  });
  await check('click opens and focuses the search; Escape closes and refocuses the button', async () => {
    await mouse('mouseMoved', 5, 5);
    await b.sleep(400);
    await ev(`${addBtn}.click()`);
    await waitFor(`!${menu}.hidden`, 'menu open on click');
    must(await ev(`document.activeElement === ${menu}.querySelector('input')`), 'search not focused');
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(`${menu}.hidden`, 'menu closed on Escape');
    must(await ev(`document.activeElement === ${addBtn}`), 'button not refocused');
  });
  await check('closing the flyout removes the menu', async () => {
    await ev(`${addBtn}.click()`);
    await ev(`${fly}.querySelector('.iconbtn[aria-label="Close editor"]').click()`);
    await waitFor(`document.querySelector('.ws-picker__box--side') === null`, 'menu removed');
  });
  const narrow = async (width, label) => {
    await b.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await b.sleep(300);
    await ev(`${colTool}.click()`);
    await waitFor(`!${fly}.hidden`, 'flyout open');
    await ev(`${addBtn}.click()`);
    await waitFor(`!${menu}.hidden`, 'menu open');
    await b.sleep(200);
    const f = await rect(fly), m = await rect(menu), host = await rect(`document.querySelector('.worksheet')`), pane = await rect(`document.getElementById('ws-fields')`);
    const paneShown = await ev(`!document.getElementById('ws-fields').hidden && document.getElementById('ws-fields').offsetParent !== null`);
    must(m.l >= host.l && m.r <= host.r + 1, `menu outside the worksheet ${J(m)} ${J(host)}`);
    must(m.r <= f.l + 1.5 || m.l >= f.r - 1.5, 'menu overlaps the flyout');
    must(Math.abs(m.r - (f.l + 1)) <= 1 || Math.abs(m.l - (f.r - 1)) <= 1, `menu not touching the flyout ${J(m)} ${J(f)}`);
    if (paneShown) must(m.l >= pane.r - 1 || m.r <= pane.l + 1, `menu covers the field pane ${J(m)} ${J(pane)}`);
    must(await ev(`document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth`), 'the page scrolls sideways');
    await shot(label);
    await ev(`${fly}.querySelector('.iconbtn[aria-label="Close editor"]').click()`);
    await waitFor(`document.querySelector('.ws-picker__box--side') === null`, 'menu removed');
    return { w: m.w, paneShown };
  };
  await check('narrow worksheet (900): the menu stays inside the worksheet, touching the flyout without overlap', async () => { await narrow(900, 'colour-menu-900'); });
  await check('narrower (820): the menu shrinks to fit on the right, never over the field pane', async () => {
    const r = await narrow(820, 'colour-menu-820');
    must(r.w >= 120 && r.w < 240, `width ${r.w}`);
  });
  await check('narrowest the worksheet allows (760): the narrowest menu, still on the right, page does not scroll', async () => {
    const r = await narrow(760, 'colour-menu-760');
    must(r.w >= 120 && r.w < 189, `width ${r.w}`);
  });
  await check('design probe: the field slot and the side menu have no alignment, gap, colour, contrast or scale findings (empty and with a pill; light, dark, One Dark; 1400 and 820 px)', async () => {
    const { designProbe, formatProbe } = await import('./design-probe.mjs');
    const probe = async (label, sel) => {
      const r = await designProbe(ev, sel, { sleep: b.sleep });
      // Accepted, with reasons (docs/development/design-review.md): the pill's ✕ is the shared 16 px pill remove button, and the Add field plus is nudged 2 px on purpose so its ink,
      // not its box, sits on the content edge (design rule 1, optical alignment), as are the type glyphs in the list rows (the same nudge the picker list has always had); the open button's 7 % ink tint is the app's one hover tint (a color-mix, so it reads as off-token).
      r.findings = r.findings.filter((x) => !(x.rule === 'target' && /button\.iconbtn/.test(x.msg)) && !(x.rule === 'align' && /<svg>.*button\.ws-picker__(btn|item)/.test(x.msg)) && !(x.rule === 'colour' && /background.* \/ 0\.07\).*button\.ws-picker__btn/.test(x.msg)));
      if (r.findings.length) console.log(label + '\n' + formatProbe(r));
      must(r.findings.length === 0, `${label}: ${r.findings.length} finding(s): ` + J(r.findings.map((x) => x.rule + ': ' + x.msg).slice(0, 4)));
    };
    for (const w of [1400, 820]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
      await b.sleep(300);
      for (const withPill of [false, true]) {
        if (!withPill && (await ev(`!!${fly} && !${fly}.hidden && !!${fly}.querySelector('.ws-pill button')`))) { // start empty: remove the pill an earlier check left
          await ev(`${fly}.querySelector('.ws-pill button').click()`);
          await waitFor(`${fly}.querySelector('.ws-toolpanel__zone') === null`, 'pill removed');
        }
        if (withPill && (await ev(`!${fly}.querySelector('.ws-toolpanel__zone .ws-pill')`))) { // the sheet already holds one from the pick above
          await ev(`${addBtn}.click()`); await waitFor(`!${menu}.hidden`, 'menu open');
          await ev(`[...${menu}.querySelectorAll('.ws-picker__item')].find((x) => x.textContent.includes('region')).click()`);
          await waitFor(`${fly}.querySelector('.ws-toolpanel__zone .ws-pill') !== null`, 'pill');
        }
        if (await ev(`!${fly} || ${fly}.hidden`)) { await ev(`${colTool}.click()`); await waitFor(`!${fly}.hidden`, 'flyout open'); }
        await ev(`${addBtn}.click()`); await waitFor(`!${menu}.hidden`, 'menu open'); await b.sleep(200);
        await mouse('mouseMoved', 5, 5); await b.sleep(400); // the menu stays (focus is in it); the button is not hovered
        const tag = `${withPill ? 'with a pill' : 'empty'} @${w}`;
        await probe(`slot, ${tag}`, '#ws-toolfly .ws-toolpanel__slot');
        await probe(`side menu, ${tag}`, '.ws-picker__box--side');
        await ev(`${menu}.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      }
    }
  });
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });

  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
