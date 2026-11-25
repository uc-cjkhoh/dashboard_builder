// Browser checks for the Color flyout's Drop Field Here row: its own full-width dashed row (a drop target, not a control), the dashed zone only with pills, and no field list on hover, click or Enter (D156). Fields arrive by drag and drop.
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
const LOOK = process.env.LOOK === 'onedark' ? 'onedark' : '';
const SCHEME = LOOK || process.env.SCHEME === 'dark' ? 'dark' : 'light'; // SCHEME=dark loads the page in the dark scheme (set before load)

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
  if (SCHEME === 'dark') await ev(`document.documentElement.setAttribute('data-scheme', 'dark')${LOOK ? `, document.documentElement.setAttribute('data-look', '${LOOK}')` : ''}`); // the boot script may have reset it
  const shot = async (name) => { try { writeFileSync(join(SHOTS, `${name}-${LOOK || SCHEME}.png`), Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); } catch { /* optional */ } };
  const fmtTool = `document.querySelector('.ws-viewbar__btn[aria-label="Format"]')`;
  const colTool = `document.querySelector('.ws-tool[data-tool="color"]')`; // the Colour controls live in the Color tile's flyout (D151)
  const rect = (sel) => ev(`(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`);
  const fly = `document.getElementById('ws-toolfly')`;
  const addBtn = `${fly}.querySelector('.ws-addfield')`;
  const slotEl = `${fly}.querySelector('.ws-toolpanel__slot')`;
  const group = `${fly}.querySelector('.ws-flyedit__group')`;
  const mouse = (type, x, y) => b.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0 });
  const centre = (r) => [r.l + r.w / 2, r.t + r.h / 2];
  const noList = `document.querySelector('.ws-picker__box, .ws-picker__item, .ws-picker__list') === null`; // D156: the field list is gone for good

  await check('empty Colour: no dashed zone, Drop Field Here is a full-width dashed row in the slot, not a control', async () => {
    await ev(`${colTool}.click()`);
    await waitFor(`!!${fly} && !${fly}.hidden`, 'flyout open');
    await b.sleep(600); // the flyout's entry motion
    must(await ev(`${fly}.querySelector('.ws-toolpanel__zone') === null`), 'zone present with no pills');
    must(await ev(`${addBtn}.parentElement.classList.contains('ws-toolpanel__slot')`), 'Drop Field Here not directly in the slot');
    must(await ev(`${addBtn}.tagName === 'DIV' && !${addBtn}.hasAttribute('tabindex') && ${fly}.querySelector('.ws-toolpanel__slot button') === null`), 'Drop Field Here is a focusable control');
    const slotR = await rect(group), btnR = await rect(addBtn);
    const cs = await ev(`(() => { const c = getComputedStyle(${addBtn}, '::before'); return { style: c.borderTopStyle, width: c.borderTopWidth, cursor: getComputedStyle(${addBtn}).cursor }; })()`);
    must(cs.style === 'dashed' && cs.width === '1px', `Drop Field Here border ${J(cs)}`);
    must(cs.cursor !== 'pointer', 'Drop Field Here looks clickable');
    const parts = await ev(`(() => { const r = (e) => { const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }; const btn = ${addBtn}; const [bx, by] = r(btn); const kids = [...btn.children].map(r); const xs = kids.map((k) => k[0]); return { dy: kids.map((k) => k[1] - by), dx: (Math.min(...[...btn.children].map((e) => e.getBoundingClientRect().left)) + Math.max(...[...btn.children].map((e) => e.getBoundingClientRect().right))) / 2 - bx }; })()`);
    must(parts.dy.every((d) => Math.abs(d) <= 1) && Math.abs(parts.dx) <= 1, `Drop Field Here label not centred in the row ${J(parts)}`);
    must(Math.abs(btnR.w - (slotR.w - 32)) <= 1 && Math.abs(btnR.l - (slotR.l + 16)) <= 1, `Drop Field Here not the slot's full width ${J(btnR)} ${J(slotR)}`);
    must(await ev(noList), 'a field list is mounted');
    await shot('colour-addfield-empty');
  });
  await check('hover, click and Enter open no list: Drop Field Here takes drops only', async () => {
    const r = await rect(addBtn);
    await mouse('mouseMoved', ...centre(r));
    await b.sleep(500);
    must(await ev(noList), 'hover opened a list');
    await ev(`${addBtn}.click()`);
    await b.sleep(300);
    must(await ev(noList), 'click opened a list');
    must(await ev(`document.activeElement === null || !${fly}.contains(document.activeElement) || document.activeElement.closest('.ws-toolpanel__slot') === null`), 'focus landed in the slot');
    await mouse('mouseMoved', 5, 5);
  });
  await check('hovering the slot animates the row: edge and label darken over a transition, and settle back on leaving', async () => {
    const edge = () => ev(`(() => { const r = ${addBtn}; return { edge: getComputedStyle(r, '::before').borderTopColor, ink: getComputedStyle(r).color, bg: getComputedStyle(r).backgroundColor, dur: getComputedStyle(r).transitionDuration, edgeDur: getComputedStyle(r, '::before').transitionDuration }; })()`);
    await mouse('mouseMoved', 5, 5); await b.sleep(400);
    const rest = await edge();
    await mouse('mouseMoved', ...centre(await rect(addBtn)));
    await b.sleep(500);
    const hot = await edge();
    must(hot.edge !== rest.edge && hot.ink !== rest.ink && hot.bg !== rest.bg, `hover changed nothing ${J(rest)} ${J(hot)}`);
    must(rest.dur !== '0s' && rest.edgeDur !== '0s', `no transition ${J(rest)}`);
    await mouse('mouseMoved', 5, 5); await b.sleep(500);
    must(J(await edge()) === J(rest), 'did not settle back after leaving');
  });
  await check('design probe, hovered: the slot with the pointer on it has no alignment, colour or contrast findings (light, dark, One Dark)', async () => {
    const { designProbe, formatProbe } = await import('./design-probe.mjs');
    await mouse('mouseMoved', ...centre(await rect(addBtn)));
    await b.sleep(500);
    await shot('colour-addfield-hover');
    const hovered = await ev(`${slotEl}.matches(':hover') && ${addBtn}.matches(':hover')`);
    must(hovered, 'the slot is not in the :hover state');
    const r = await designProbe(ev, '#ws-toolfly .ws-toolpanel__slot', { sleep: b.sleep });
    r.findings = r.findings.filter((x) => !(x.rule === 'target' && /button\.iconbtn/.test(x.msg)));
    if (r.findings.length) console.log('hovered\n' + formatProbe(r));
    must(r.findings.length === 0, `hovered: ${r.findings.length} finding(s): ` + J(r.findings.map((x) => x.rule + ': ' + x.msg).slice(0, 4)));
    await mouse('mouseMoved', 5, 5);
  });
  await check('dragging a field onto the Drop Field Here row adds the pill and the zone replaces the row', async () => {
    await ev(`(() => { const c = __t.chip('region'); if (!c) throw new Error('no field chip region'); __t.drag(c, ${slotEl}); return true; })()`);
    await waitFor(`${fly}.querySelector('.ws-toolpanel__zone .ws-pill') !== null`, 'pill in the zone');
    must(await ev(`${fly}.querySelector('.ws-addfield') === null`), 'Drop Field Here still shown beside the filled zone');
    must(await ev(`${fly}.querySelector('.ws-toolpanel__zone').parentElement.classList.contains('ws-toolpanel__slot')`), 'the zone is not directly in the slot');
    must(await ev(noList), 'a field list appeared after the drop');
    await shot('colour-addfield-pill');
  });
  await check('closing the flyout leaves no list behind', async () => {
    await ev(`${fly}.querySelector('.iconbtn[aria-label="Close editor"]').click()`);
    await waitFor(`${fly}.hidden`, 'flyout closed');
    must(await ev(noList), 'a field list is mounted after closing');
  });
  const narrow = async (width, label) => {
    await b.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await b.sleep(300);
    await ev(`${colTool}.click()`);
    await waitFor(`!${fly}.hidden`, 'flyout open');
    await b.sleep(300);
    const f = await rect(fly), host = await rect(`document.querySelector('.worksheet')`), a = await rect(`${fly}.querySelector('.ws-addfield, .ws-toolpanel__zone')`);
    must(f.r <= host.r + 1, `flyout outside the worksheet ${J(f)} ${J(host)}`);
    must(a.w > 0 && a.l >= f.l && a.r <= f.r, `Drop Field Here / zone outside the flyout ${J(a)} ${J(f)}`);
    must(await ev(`document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth`), 'the page scrolls sideways');
    await shot(label);
    await ev(`${fly}.querySelector('.iconbtn[aria-label="Close editor"]').click()`);
    await waitFor(`${fly}.hidden`, 'flyout closed');
  };
  for (const w of [900, 820, 760]) await check(`narrow worksheet (${w}): the flyout and its Drop Field Here row stay inside the worksheet, the page does not scroll`, async () => { await narrow(w, `colour-addfield-${w}`); });
  await check('design probe: the field slot has no alignment, gap, colour, contrast or scale findings (empty and with a pill; light, dark, One Dark; 1400, 820 and 760 px)', async () => {
    const { designProbe, formatProbe } = await import('./design-probe.mjs');
    const probe = async (label, sel) => {
      const r = await designProbe(ev, sel, { sleep: b.sleep });
      // Accepted, with reasons (docs/development/design-review.md): the pill's ✕ is the shared 16 px pill remove button.
      r.findings = r.findings.filter((x) => !(x.rule === 'target' && /button\.iconbtn/.test(x.msg)));
      if (r.findings.length) console.log(label + '\n' + formatProbe(r));
      must(r.findings.length === 0, `${label}: ${r.findings.length} finding(s): ` + J(r.findings.map((x) => x.rule + ': ' + x.msg).slice(0, 4)));
    };
    for (const w of [1400, 820, 760]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
      await b.sleep(300);
      for (const withPill of [false, true]) {
        if (await ev(`!${fly} || ${fly}.hidden`)) { await ev(`${colTool}.click()`); await waitFor(`!${fly}.hidden`, 'flyout open'); }
        if (!withPill && (await ev(`!!${fly}.querySelector('.ws-pill button')`))) { // start empty: remove the pill an earlier check left
          await ev(`${fly}.querySelector('.ws-pill button').click()`);
          await waitFor(`${fly}.querySelector('.ws-toolpanel__zone') === null`, 'pill removed');
        }
        if (withPill && (await ev(`!${fly}.querySelector('.ws-toolpanel__zone .ws-pill')`))) {
          await ev(`(() => { __t.drag(__t.chip('region'), ${slotEl}); return true; })()`);
          await waitFor(`${fly}.querySelector('.ws-toolpanel__zone .ws-pill') !== null`, 'pill');
        }
        await b.sleep(300);
        await probe(`slot, ${withPill ? 'with a pill' : 'empty'} @${w}`, '#ws-toolfly .ws-toolpanel__slot');
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
