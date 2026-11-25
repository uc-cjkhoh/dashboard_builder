// Browser checks for the Marks flyouts (D155): every one of the 12 tiles opens the same layout (a full-width Drop Field Here row, no field list), the settings that
// were in Format live on their tile (Size, Shape, Label, Tooltip, Path, Dates), a tile is quiet only while its flyout has nothing for the chart type, and focus returns to the control that changed.
// Real Chromium over CDP (tests/live/cdp.mjs), /api/* mocked. Run:  node tests/live/marks-flyouts-ui.mjs   (start the app first: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5180 ; stop it with fuser -k 5180/tcp)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
import { launch } from './cdp.mjs';
import { NEW_CALC, PAGE_CHIP, relateTables } from './model.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5180';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'marks-flyouts-ui-shots');
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
  const fly = `document.getElementById('ws-toolfly')`;
  const fmtTool = `document.querySelector('.ws-viewbar__btn[aria-label="Format"]')`;
  const tile = (key) => `document.querySelector('.ws-tool[data-tool="${key}"]')`;
  const chartType = async (name) => {
    await ev(`document.querySelector('.ws-pick--chart .ws-pick__btn').click()`);
    await ev(`[...document.querySelectorAll('.ws-charttypes .menu__item')].find((x) => x.textContent.trim() === ${J(name)}).click()`);
    await settle(500);
  };
  const closePanels = async () => {
    await ev(`(() => { document.querySelector('#ws-toolfly .iconbtn[aria-label="Close editor"]')?.click(); if (document.querySelector('.ws-format')) ${fmtTool}.click(); return true; })()`);
    await b.sleep(150);
  };
  const openTile = async (key) => {
    await closePanels();
    await ev(`${tile(key)}.click()`);
    await waitFor(`!!${fly} && !${fly}.hidden && !!${fly}.querySelector('.ws-toolpanel')`, `${key} flyout open`);
    await b.sleep(450); // the flyout's entry motion
  };
  const openFormat = async () => {
    await closePanels();
    await ev(`${fmtTool}.click()`);
    await waitFor(`!!document.querySelector('.ws-format')`, 'format open');
  };
  const labels = (root) => ev(`[...document.querySelectorAll('${root} .ws-fmt-field, ${root} .ws-fmt-check')].map((l) => l.textContent.trim())`);
  const has = async (root, label) => (await labels(root)).some((t) => t.includes(label));
  const inFly = (label) => has('#ws-toolfly', label);
  const inFormat = (label) => has('.ws-format', label);
  const quiet = (key) => ev(`${tile(key)}.classList.contains('is-quiet')`);
  const slotOnly = () => ev(`!!${fly}.querySelector('.ws-toolpanel > .ws-toolpanel__slot') && !${fly}.querySelector('.ws-flyedit')`);

  await ev(`${fmtTool}`); // the worksheet toolbar is there
  await dragChip('region', `__t.zone('columns')`);
  await dragChip('amount', `__t.zone('rows')`);
  await settle(700);
  await chartType('Bar');

  const KEYS = ['color', 'size', 'label', 'detail', 'tooltip', 'shape', 'path', 'angle', 'filters', 'period', 'drill', 'pages'];
  await check('all 12 tiles open the same slot: a full-width dashed Drop Field Here row (a drop target, no field list)', async () => {
    for (const key of KEYS) {
      await openTile(key);
      const r = await ev(`(() => { const slot = ${fly}.querySelector('.ws-toolpanel__slot'); const btn = slot?.querySelector(':scope > .ws-addfield'); const menu = document.querySelector('.ws-picker__box, .ws-picker__item'); if (!slot || !btn) return null; const s = slot.getBoundingClientRect(), x = btn.getBoundingClientRect(), cs = getComputedStyle(slot), inner = s.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); return { full: Math.abs(x.width - inner) <= 1, dotted: getComputedStyle(btn, '::before').borderTopStyle, menu: !menu && btn.tagName === 'DIV' }; })()`);
      must(r && r.full && r.dotted === 'dashed' && r.menu, `${key}: ${J(r)}`);
    }
    await closePanels();
  });
  await check('Bar: Label holds Data labels (not Format); Marker size, Line style, Shape bins are absent; Size is not quiet', async () => {
    await openTile('label');
    must(await inFly('Data labels'), 'Data labels missing from the Label flyout');
    await openFormat();
    must(!(await inFormat('Data labels')) && !(await inFormat('Label marks')) && !(await inFormat('Show tooltips')) && !(await inFormat('Line style')), 'a moved control is still in Format');
    must(await inFormat('Legend') && await inFormat('Number'), 'Format lost its own controls');
    must(!(await quiet('size')), 'Size is quiet on a bar');
  });
  await check('Tooltip: a Text section and a Behaviour section hold Show tooltips, Command buttons, Tooltip mode', async () => {
    await openTile('tooltip');
    must(J(await ev(`[...${fly}.querySelectorAll('.ws-flyedit__group')].map((g) => g.dataset.section)`)) === J(['Text', 'Behaviour']), 'sections ' + J(await ev(`[...${fly}.querySelectorAll('.ws-flyedit__group')].map((g) => g.dataset.section)`)));
    for (const l of ['Show tooltips', 'Command buttons', 'Tooltip mode']) must(await inFly(l), l + ' missing');
    must(await ev(`!!${fly}.querySelector('.ws-flyedit__group:first-child .ws-toolpanel__slot')`), 'the slot does not open the first section');
  });
  await check('Pie: Shape and Path stay quiet and open the slot alone; Size lights with the Size meter; Angle lights', async () => {
    await chartType('Pie');
    for (const k of ['shape', 'path']) must(await quiet(k), `${k} not quiet on a pie`);
    must(!(await quiet('size')) && !(await quiet('angle')), 'Size or Angle quiet on a pie');
    for (const k of ['shape', 'path']) { await openTile(k); must(await slotOnly(), `${k} flyout on a pie is not the slot alone`); }
    await openTile('size'); must(await inFly('Size') && !(await inFly('Marker size')), 'a pie has the Size meter, not Marker size');
  });
  await check('Size meter: dragging it resizes the drawn bar and pie; the leftmost stop is Auto and restores the default', async () => {
    const chartOpt = `window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')).getOption()`;
    const drag = async (v) => { await ev(`(() => { const i = document.querySelector('#ws-toolfly .ws-meter__input'); i.value = ${v}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`); await settle(500); };
    const label = () => ev(`document.querySelector('#ws-toolfly .ws-meter__value').textContent`);
    await chartType('Pie');
    await openTile('size');
    const before = await ev(`${chartOpt}.series[0].radius`);
    await drag(40); must((await label()) === '100%', 'readout at the top stop: ' + (await label()));
    const big = await ev(`${chartOpt}.series[0].radius`);
    must(J(big) !== J(before) && J(big).includes('85%'), 'pie radius at the top stop: ' + J(big));
    await drag(3); must((await label()) === 'Auto', 'leftmost stop reads Auto');
    must(J(await ev(`${chartOpt}.series[0].radius`)) === J(before), 'Auto restores the default radius');
    await chartType('Bar');
    await openTile('size');
    const cap = await ev(`${chartOpt}.series[0].barMaxWidth`);
    await drag(40);
    const gap = await ev(`${chartOpt}.series[0].barCategoryGap`);
    must(parseInt(gap) < 20 && (await ev(`${chartOpt}.series[0].barMaxWidth`)) > cap, 'bar gap / cap at the top stop: ' + gap);
    await drag(3);
  });
  await check('Line: Shape lights (Marker shape), Path holds Line style and Line pattern, Size holds Marker size; Format holds none of them', async () => {
    await chartType('Line');
    must(!(await quiet('shape')), 'Shape quiet on a line');
    await openTile('shape'); must(await inFly('Marker shape'), 'Marker shape missing');
    await openTile('path'); must(await inFly('Line style') && await inFly('Line pattern'), 'Path controls missing');
    await openTile('size'); must(await inFly('Marker size'), 'Marker size missing');
    await openFormat();
    for (const l of ['Marker shape', 'Line style', 'Line pattern', 'Marker size']) must(!(await inFormat(l)), l + ' still in Format');
  });
  await check('Combo: Path lights; a circle heatmap lights Size, a square heatmap does not', async () => {
    await chartType('Combo (dual-axis)');
    must(!(await quiet('path')), 'Path quiet on a combo');
    await chartType('Heatmap');
    must(await quiet('size'), 'Size not quiet on a square heatmap');
    await openFormat();
    await ev(`(() => { const s = [...document.querySelectorAll('.ws-fmt-field')].find((l) => l.textContent.includes('Shape')).querySelector('select'); s.value = 'circle'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await settle(500);
    must(!(await quiet('size')), 'Size quiet on a circle heatmap');
    await openTile('size'); must(await inFly('Marker size'), 'Marker size missing on a circle heatmap');
    await openFormat();
    await ev(`(() => { const s = [...document.querySelectorAll('.ws-fmt-field')].find((l) => l.textContent.includes('Shape')).querySelector('select'); s.value = 'square'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await settle(400);
  });
  await check('a table: Label and Tooltip flyouts hold no chart-only controls', async () => {
    await chartType('Table');
    await openTile('label'); must(!(await inFly('Data labels')), 'Data labels on a table');
    await openTile('tooltip'); must(!(await inFly('Show tooltips')), 'Show tooltips on a table');
  });
  await check('focus returns to the control that changed: Data labels and Marker size', async () => {
    await chartType('Bar');
    await openTile('label');
    await ev(`(() => { const i = ${fly}.querySelector('[data-fly-ctl="dataLabels"] input'); i.click(); return true; })()`);
    await settle(500);
    must(await ev(`!!document.activeElement?.closest?.('[data-fly-ctl="dataLabels"]')`), 'focus after Data labels: ' + await ev(`document.activeElement?.tagName + '.' + document.activeElement?.className`));
    await chartType('Line');
    await openTile('size');
    await ev(`(() => { const i = ${fly}.querySelector('[data-fly-ctl="markerSize"] input'); i.focus(); i.value = '9'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await settle(500);
    must(await ev(`!!document.activeElement?.closest?.('[data-fly-ctl="markerSize"]')`), 'focus after Marker size: ' + await ev(`document.activeElement?.tagName + '.' + document.activeElement?.className`));
    must(await ev(`document.querySelector('.ws-tool[data-tool="size"]').getAttribute('aria-expanded') === 'true'`), 'the flyout closed on a change');
  });
  await check('Label: Allow labels to overlap other marks shows only while labels are drawn; on by default; off hides overlapping labels on the drawn series', async () => {
    await chartType('Bar');
    await openTile('label');
    await ev(`(() => { const i = ${fly}.querySelector('[data-fly-ctl="dataLabels"] input'); if (i.checked) i.click(); return true; })()`); await settle(500);
    await openTile('label');
    must(!(await inFly('Allow labels to overlap')), 'Allow labels to overlap offered while no label is drawn');
    await ev(`(() => { const i = ${fly}.querySelector('[data-fly-ctl="dataLabels"] input'); if (!i.checked) i.click(); return true; })()`); await settle(500);
    await openTile('label');
    must(await inFly('Allow labels to overlap other marks'), 'Allow labels to overlap missing from the Label flyout once labels are drawn');
    const hide = () => ev(`(() => { const o = window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')).getOption(); return o.series.filter((s) => s.label?.show).every((s) => s.labelLayout?.hideOverlap === true) && o.series.some((s) => s.label?.show); })()`);
    must(!(await hide()), 'overlap hidden by default');
    await openTile('label');
    await ev(`(() => { const i = ${fly}.querySelector('[data-fly-ctl="labelOverlap"] input'); i.click(); return true; })()`); await settle(500);
    must(await hide(), 'labels not hidden once overlap is off');
    must(await ev(`!!document.activeElement?.closest?.('[data-fly-ctl="labelOverlap"]')`), 'focus did not return to the control');
    await ev(`(() => { const i = ${fly}.querySelector('[data-fly-ctl="labelOverlap"] input'); i.click(); return true; })()`); await settle(500);
    must(!(await hide()), 'back on: labels draw as before');
  });
  await check('Size: Marker size is a meter whose leftmost stop is Auto; a Format-free control with the same stored key', async () => {
    await chartType('Line');
    await openTile('size');
    await ev(`(() => { const i = ${fly}.querySelector('[data-fly-ctl="markerSize"] input'); i.value = '3'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(500); // an earlier check may have left a size
    await openTile('size');
    const r = await ev(`(() => { const i = ${fly}.querySelector('[data-fly-ctl="markerSize"] input[type=range]'); return i ? [i.min, i.max, i.value, i.closest('label').querySelector('output').textContent] : null; })()`);
    must(J(r) === J(['3', '40', '3', 'Auto']), 'marker size meter ' + J(r));
    await ev(`(() => { const i = ${fly}.querySelector('[data-fly-ctl="markerSize"] input'); i.value = '12'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(500);
    must(await ev(`window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')).getOption().series[0].symbolSize === 12`), 'meter did not set the marker size');
    await ev(`(() => { const i = ${fly}.querySelector('[data-fly-ctl="markerSize"] input'); i.value = '3'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(500);
    must(await ev(`window.echarts.getInstanceByDom(document.querySelector('.ws-chart-canvas')).getOption().series[0].symbolSize === 8`), 'Auto did not return the default size');
  });
  await check('Pages: the tile has a Speed control once a field is set; Slow/Medium/Fast; Play stays on the worksheet', async () => {
    await chartType('Bar');
    await dragChip('channel', tile('pages')); await settle(600);
    await openTile('pages');
    must(await inFly('Speed'), 'Speed missing from the Pages flyout');
    must(await ev(`!!${fly}.querySelector('.ws-flyedit__group:first-child .ws-toolpanel__slot')`), 'the slot does not open the first section');
    const opts = await ev(`[...${fly}.querySelectorAll('[data-fly-ctl="pageSpeed"] option')].map((o) => o.textContent)`);
    must(J(opts) === J(['Slow', 'Medium', 'Fast']), 'speed options ' + J(opts));
    must(!(await inFly('Play')), 'Play moved into the flyout');
    await ev(`(() => { const s = ${fly}.querySelector('[data-fly-ctl="pageSpeed"] select'); s.value = 'fast'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(500);
    must(await ev(`!!document.querySelector('.ws-pages')`), 'the page control left the worksheet');
    await openTile('pages');
    must(await ev(`${fly}.querySelector('[data-fly-ctl="pageSpeed"] select').value === 'fast'`), 'the speed was not kept');
    // reduced motion hides Play, so Speed does nothing: it is disabled and says why
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    try {
      await ev(`${tile('pages')}.click()`); await settle(300); await openTile('pages');
      const r = await ev(`(() => { const f = ${fly}.querySelector('[data-fly-ctl="pageSpeed"]'); return f ? [f.querySelector('select').disabled, f.title] : null; })()`);
      must(r && r[0] === true && /reduced motion/.test(r[1]), 'Speed not disabled with a reason under reduced motion: ' + J(r));
      must(await ev(`!document.querySelector('.ws-pages .ws-pages__btn.is-active') && ![...document.querySelectorAll('.ws-pages button')].some((x) => /Play/.test(x.textContent))`), 'Play still shown under reduced motion');
    } finally { await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }); }
    await ev(`(() => { const x = ${fly}.querySelector('.ws-pill .iconbtn, .ws-pill button'); x?.click(); return true; })()`); await settle(500);
  });
  await check('design probe: each tile\'s own controls hold the design rules', async () => {
    const { designProbe, formatProbe } = await import('./design-probe.mjs');
    await chartType('Bar');
    for (const key of ['label', 'tooltip']) {
      await openTile(key);
      const r = await designProbe(ev, '#ws-toolfly .ws-flyedit__group > :not(.ws-toolpanel__slot)', { sleep: b.sleep });
      if (r.findings.length) console.log(key + '\n' + formatProbe(r));
      must(r.findings.length === 0, `${key}: ${r.findings.length} finding(s): ` + J(r.findings.map((x) => x.rule + ': ' + x.msg).slice(0, 4)));
    }
    await chartType('Line');
    for (const key of ['size', 'shape', 'path']) {
      await openTile(key);
      const r = await designProbe(ev, '#ws-toolfly .ws-flyedit__group > :not(.ws-toolpanel__slot)', { sleep: b.sleep });
      if (r.findings.length) console.log(key + '\n' + formatProbe(r));
      must(r.findings.length === 0, `${key}: ${r.findings.length} finding(s): ` + J(r.findings.map((x) => x.rule + ': ' + x.msg).slice(0, 4)));
    }
  });

  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
