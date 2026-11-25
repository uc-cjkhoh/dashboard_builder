// Browser check: the tab strip stays on one row (tabs shrink, then the list scrolls inside the bar) and every dashboard that holds worksheets
// is drawn as a coloured, collapsible group (Tabs/tab-groups-model.js). Real dev app (APP_URL, default http://localhost:5188) in headless Chromium over
// the DevTools protocol (tests/live/cdp.mjs); every /api/* call is mocked. Tabs are made through the app's own store module, so the strip renders as in use.
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT (default: a free port), CHROME_BIN.
// Run: node tests/live/tab-strip-ui.mjs  (start the app: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5188; stop it by port)
import { mkdirSync } from 'node:fs';
import { launch } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5188';
const SHOTS = process.env.SHOTS_DIR ?? '/tmp/tab-strip-shots';
mkdirSync(SHOTS, { recursive: true });
let failed = 0, passed = 0;
async function check(name, fn) { try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; } }
const must = (c, m) => { if (!c) throw new Error(m); };
const same = (a, b, m) => must(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

// The app's own modules, by the (hashed) URLs the page loaded them from, so they are the very instances the strip listens to.
const MOD = (re) => `(async () => import(performance.getEntriesByType('resource').map((e) => e.name).find((n) => ${re})))()`;
const STORE = MOD('/Core\\/store\\.js/.test(n)');
const WBMODEL = MOD('/Workbook\\/workbook-model\\.js/.test(n)');

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined, width: 1400, height: 900 });
  await b.mock(({ method, path }) => (path === '/api/connection' && method === 'GET' ? { json: { connected: false } } : null));
  const ev = (s) => b.evaluate(s);
  await b.goto(APP);
  await b.waitFor(`!!document.getElementById('tabs')`, { label: 'strip rendered' });

  // Worksheets L1, w1..w6, three dashboards (Sales: w1 w2 · Operations: w3 w4 · Finance: w5 w6), loose L2, a story.
  await ev(`(async () => { const st = await ${STORE};
    const ws = (name) => st.createWorksheet(name);
    ws('Loose one'); const w = [1, 2, 3, 4, 5, 6].map((i) => ws('Sheet ' + i));
    const dash = (name, sheets) => { const d = st.createDashboard(name); st.setWidgets(d.id, sheets.map((s, i) => ({ id: st.nextWidgetId(), kind: 'sheet', sheetId: s.id, x: 0, y: i * 4, w: 6, h: 4 }))); return d; };
    dash('Sales', [w[0], w[1]]); dash('Operations', [w[2], w[3]]); dash('Finance', [w[4], w[5]]);
    ws('Loose two'); st.createStory('Tour'); st.showModel(); return true; })()`);

  const geom = () => ev(`(() => { const tabs = [...document.querySelectorAll('#tabs .tab')]; const bar = document.getElementById('tabs').getBoundingClientRect();
    return { tops: [...new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top)))], barH: Math.round(bar.height), docScrolls: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth }; })()`);
  const names = (sel) => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent.trim())`);

  // Nothing overlaps (tabs in DOM order never run into each other), each group's box holds its tabs, and a group's header tab keeps its name readable.
  const overlaps = () => ev(`(() => { const sc = document.querySelector('.tabs__scroll'), r = (e) => e.getBoundingClientRect();
    const items = [...sc.querySelectorAll('.tab')]; const bad = [];
    items.forEach((e, i) => { if (i && r(e).left < r(items[i - 1]).right - 0.5) bad.push([items[i - 1].textContent.trim(), e.textContent.trim()]); });
    const outside = [...sc.querySelectorAll('.tab-group')].filter((g) => [...g.children].some((c) => r(c).left < r(g).left - 1 || r(c).right > r(g).right + 1)).map((g) => g.getAttribute('aria-label'));
    const chips = [...sc.querySelectorAll('.tab--head .tab__label')].map((n) => n.scrollWidth <= n.clientWidth + 1);
    return { bad, outside, chipsReadable: chips.every(Boolean) }; })()`);
  const noOverlap = async (when) => { const o = await overlaps(); same(o.bad, [], `${when}: overlapping items`); same(o.outside, [], `${when}: tabs outside their group's box`); must(o.chipsReadable, `${when}: a group header's name is cut off`); };

  await check('one row, and the page does not scroll', async () => {
    const g = await geom();
    same(g.tops.length, 1, 'distinct tab tops');
    must(!g.docScrolls, 'the page scrolls');
    await noOverlap('12 tabs');
  });
  await check('three groups headed by their dashboard tab (the name appears once); loose tabs and the story stay outside', async () => {
    same(await names('#tabs .tab-group > .tab--dashboard:first-child .tab__label'), ['Sales', 'Operations', 'Finance'], 'group headers');
    same(await ev(`document.querySelectorAll('#tabs .tab-group__chip').length`), 0, 'no separate chip');
    same(await ev(`document.querySelectorAll('#tabs [role=group]').length`), 0, 'no role=group inside the tablist (the tablist owns every tab)');
    same(await ev(`[...document.querySelectorAll('#tabs .tab-group')].map((g) => [...g.querySelectorAll('.tab__label')].filter((l) => l.textContent === g.firstElementChild.querySelector('.tab__label').textContent).length)`), [1, 1, 1], 'the dashboard name is drawn once per group');
    same(await ev(`[...document.querySelectorAll('#tabs .tab-group')].map((g) => [...g.querySelectorAll('.tab__label')].map((l) => l.textContent))`),
      [['Sales', 'Sheet 1', 'Sheet 2'], ['Operations', 'Sheet 3', 'Sheet 4'], ['Finance', 'Sheet 5', 'Sheet 6']], 'members, dashboard first');
    same(await ev(`[...document.querySelectorAll('#tabs .tabs__scroll > .tab .tab__label')].map((l) => l.textContent)`), ['Loose one', 'Loose two', 'Tour'], 'ungrouped');
    same(await ev(`[...document.querySelectorAll('#tabs .tabs__scroll > *')].map((e) => e.classList.contains('tab-group') ? 'G' : 'T').join('')`), 'TGGGTT', 'group sits at its dashboard\'s slot');
  });
  await check('each group has its own underline colour', async () => {
    const colours = await ev(`[...document.querySelectorAll('#tabs .tab-group')].map((g) => getComputedStyle(g, '::after').backgroundColor)`);
    same(new Set(colours).size, 3, `distinct underline colours ${colours}`);
    must(colours.every((c) => c !== 'rgba(0, 0, 0, 0)'), 'an underline is transparent');
  });
  await b.screenshot(`${SHOTS}/groups-light.png`, { x: 0, y: 0, width: 1400, height: 90 });

  await check('collapse: the fold button on the dashboard tab toggles; the header stays, the count shows; the active worksheet stays visible; expand restores', async () => {
    const fold = `document.querySelectorAll('.tab__fold')[1]`;
    await ev(`${fold}.click()`);
    const g = () => ev(`(() => { const e = document.querySelectorAll('#tabs .tab-group')[1], f = e.querySelector('.tab__fold'); return { state: e.dataset.state, tabs: e.querySelectorAll('.tab').length, header: e.firstElementChild.querySelector('.tab__label').textContent, count: e.querySelector('.tab__count')?.textContent ?? null, expanded: f.getAttribute('aria-expanded'), focused: document.activeElement === f }; })()`);
    same(await g(), { state: 'collapsed', tabs: 1, header: 'Operations', count: '2', expanded: 'false', focused: true }, 'collapsed');
    await ev(`(async () => { const st = await ${STORE}; st.switchTab(st.tabs.find((t) => t.name === 'Sheet 3').id); return true; })()`);
    same((await g()).tabs, 2, 'active worksheet shown');
    await ev(`(async () => { const st = await ${STORE}; st.switchTab(st.tabs.find((t) => t.name === 'Loose one').id); return true; })()`);
    same((await g()).tabs, 1, 'hidden again after switching away');
    await ev(`${fold}.click()`);
    same((await g()).tabs, 3, 'expanded');
  });
  await check('renaming a dashboard renames the header of its group; dropping a worksheet from a dashboard regroups without a reload', async () => {
    await ev(`(async () => { const st = await ${STORE}; st.renameTab(st.tabs.find((t) => t.name === 'Finance').id, 'Money'); return true; })()`);
    same(await names('#tabs .tab-group > .tab--dashboard:first-child .tab__label'), ['Sales', 'Operations', 'Money'], 'renamed');
    await ev(`(async () => { const st = await ${STORE}; const d = st.tabs.find((t) => t.name === 'Money'); st.setWidgets(d.id, d.widgets.slice(0, 1)); return true; })()`); // Sheet 6 leaves the dashboard
    same(await ev(`[...document.querySelectorAll('#tabs .tab-group')[2].querySelectorAll('.tab__label')].map((l) => l.textContent)`), ['Money', 'Sheet 5'], 'Money now owns one worksheet');
    same(await ev(`[...document.querySelectorAll('#tabs .tabs__scroll > .tab .tab__label')].map((l) => l.textContent)`), ['Loose one', 'Sheet 6', 'Loose two', 'Tour'], 'Sheet 6 is loose again');
  });
  await check('rename in a group: F2, Escape, and focus returns to that tab (not the stored-order one)', async () => {
    await ev(`(() => { const l = [...document.querySelectorAll('.tab__label')].find((e) => e.dataset.tabId && e.textContent === 'Sheet 2'); l.focus(); return true; })()`);
    await b.key('F2', { vk: 113 });
    must(await ev(`!!document.querySelector('.tab__rename')`), 'rename input did not open');
    await b.key('Escape', { vk: 27 });
    same(await ev(`document.activeElement.textContent`), 'Sheet 2', 'focus after Escape');
  });

  // Worksheets up to the 50-tab limit (12 exist, so 38 more): the strip must shrink, then scroll inside the bar.
  await ev(`(async () => { const st = await ${STORE}; for (let i = 0; i < 38; i++) st.createWorksheet('Extra worksheet ' + (i + 1)); return true; })()`);
  const dense = () => ev(`(() => { const s = document.getElementById('tabs'), sc = s.querySelector('.tabs__scroll'), box = s.getBoundingClientRect(), r = (e) => e.getBoundingClientRect();
    const inside = (e) => r(e).left >= box.left - 1 && r(e).right <= box.right + 1;
    const inactive = [...sc.querySelectorAll('.tab:not(.is-active)')]; const active = sc.querySelector('.tab.is-active');
    return { dense: s.classList.contains('tabs--dense'), scrolls: sc.scrollWidth > sc.clientWidth, modelIn: inside(s.querySelector('.tab--model')), addIn: inside(s.querySelector('.tab-add')),
      minInactive: Math.round(Math.min(...inactive.map((e) => r(e).width))), inactiveClose: inactive.some((e) => e.querySelector('.tab__close')?.offsetParent !== null),
      activeClose: active ? active.querySelector('.tab__close')?.offsetParent !== null : null, activeIn: active ? r(active).left >= r(sc).left - 1 && r(active).right <= r(sc).right + 1 : null,
      inactiveLabelW: Math.max(...inactive.filter((e) => !e.classList.contains('tab--head')).map((e) => r(e.querySelector('.tab__label')).width)), // a group's header tab keeps its label
      tops: [...new Set([...sc.querySelectorAll('.tab')].map((e) => Math.round(r(e).top)))].length, docScrolls: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth }; })()`);
  await check('50 tabs: one row, shrunk to icons, scrolls inside the bar, Data Source and [+] stay in view, page still does not scroll', async () => {
    const d = await dense();
    must(d.dense, 'strip is not dense'); must(d.scrolls, 'tab list does not scroll'); must(d.modelIn && d.addIn, 'Data Source or [+] left the bar');
    same(d.tops, 1, 'distinct tab tops'); must(!d.docScrolls, 'the page scrolls'); must(d.minInactive >= 30 && d.minInactive <= 60, `min inactive width ${d.minInactive}`);
    must(!d.inactiveClose, 'an inactive tab still shows a close button in a dense strip');
    must(d.inactiveLabelW <= 1, `an icon-only tab still shows ${d.inactiveLabelW}px of its label`);
    must(await ev(`[...document.querySelectorAll('.tabs__scroll .tab:not(.is-active):not(.tab--head)')].every((t) => /\\((worksheet|dashboard|story)\\)$/.test(t.title) && t.title.length > 8)`), 'an icon-only tab has no tooltip naming it');
    await noOverlap('50 tabs');
  });
  await check('the active tab scrolls into view and keeps its close button, at either end of the list', async () => {
    for (const name of ['Extra worksheet 38', 'Loose one']) {
      await ev(`(async () => { const st = await ${STORE}; st.switchTab(st.tabs.find((t) => t.name === ${JSON.stringify(name)}).id); return true; })()`);
      const d = await dense();
      must(d.activeIn, `${name} is not in view`); must(d.activeClose, `${name} lost its close button`);
    }
  });
  await check('a vertical wheel turn over the tab list scrolls it sideways', async () => {
    await ev(`document.querySelector('.tabs__scroll').scrollLeft = 0`);
    const at = await ev(`(() => { const r = document.querySelector('.tabs__scroll').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: 300 });
    await b.sleep(150);
    must(await ev(`document.querySelector('.tabs__scroll').scrollLeft > 0`), 'did not scroll');
  });
  await check('a double-click anywhere on an icon-only tab starts the rename (its label is 0px wide; the event is dispatched on the tab body)', async () => {
    await ev(`document.querySelector('.tabs__scroll').scrollLeft = 0`);
    const found = await ev(`(() => { const t = [...document.querySelectorAll('.tabs__scroll .tab:not(.is-active):not(.tab--head)')].find((e) => e.getBoundingClientRect().width < 50); if (!t) return false; t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
    must(found, 'no icon-only tab to try');
    await b.waitFor(`!!document.querySelector('.tab__rename')`, { label: 'rename input' });
    await b.key('Escape', { vk: 27 });
  });
  await check('clicking a tab at icon-only width switches to it', async () => {
    await ev(`document.querySelector('.tabs__scroll').scrollLeft = 0`);
    await ev(`(async () => { const st = await ${STORE}; st.showModel(); return true; })()`);
    const p = await ev(`(() => { const t = [...document.querySelectorAll('.tabs__scroll .tab')].find((e) => e.getBoundingClientRect().width < 60 && e.getBoundingClientRect().left > 0); const r = t.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), id: t.querySelector('.tab__label').dataset.tabId }; })()`);
    await b.click(p.x, p.y);
    await b.sleep(100);
    same(await ev(`(async () => (await ${STORE}).currentView().id)()`), p.id, 'active tab after the click');
  });
  await b.screenshot(`${SHOTS}/dense-light.png`, { x: 0, y: 0, width: 1400, height: 90 });

  await check('export → close everything → import: colours and the collapsed state come back', async () => {
    await ev(`(async () => { const st = await ${STORE}; st.showModel(); st.setGroupCollapsed(st.tabs.find((t) => t.name === 'Operations').id, true); return true; })()`);
    const before = await ev(`(async () => { const st = await ${STORE}; return st.tabs.filter((t) => t.kind === 'dashboard').map((d) => [d.name, d.groupSlot, d.collapsed]); })()`);
    const text = await ev(`(async () => { const st = await ${STORE}, wm = await ${WBMODEL};
      return JSON.stringify(wm.serializeWorkbook({ entities: new Map(), relationships: new Map(), tabs: st.tabs, active: st.currentView() })); })()`);
    await ev(`(async () => { const st = await ${STORE}; for (const t of [...st.tabs]) st.closeTab(t.id); return true; })()`);
    await ev(`(() => { const f = document.getElementById('wb-file'), dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(text)}], 'tabs.json', { type: 'application/json' })); f.files = dt.files; f.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await b.waitFor(`document.querySelectorAll('#tabs .tab-group').length === 3`, { label: 'groups after import' });
    same(await ev(`(async () => { const st = await ${STORE}; return st.tabs.filter((t) => t.kind === 'dashboard').map((d) => [d.name, d.groupSlot, d.collapsed]); })()`), before, 'dashboard slots and collapsed after import');
    same(await ev(`document.querySelectorAll('#tabs .tab-group')[1].dataset.state`), 'collapsed', 'Operations still collapsed');
  });
  await check('a workbook saved before groups existed opens, each dashboard gets a distinct colour', async () => {
    const text = JSON.stringify({ format: 'dashboard-builder-workbook', version: 2, entities: [], relationships: [],
      worksheets: [{ name: 'A', sheet: {} }, { name: 'B', sheet: {} }],
      dashboards: [{ name: 'D1', widgets: [{ kind: 'sheet', sheet: 0, x: 0, y: 0, w: 6, h: 4 }] }, { name: 'D2', widgets: [{ kind: 'sheet', sheet: 1, x: 0, y: 0, w: 6, h: 4 }], groupSlot: 1 }] });
    await ev(`(async () => { const st = await ${STORE}; for (const t of [...st.tabs]) st.closeTab(t.id); return true; })()`);
    await ev(`(() => { const f = document.getElementById('wb-file'), dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(text)}], 'old.json', { type: 'application/json' })); f.files = dt.files; f.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await b.waitFor(`document.querySelectorAll('#tabs .tab-group').length === 2`, { label: 'groups after old import' });
    same(await ev(`(async () => (await ${STORE}).tabs.filter((t) => t.kind === 'dashboard').map((d) => d.groupSlot))()`), [2, 1], 'D2 keeps its saved slot, D1 takes the lowest unused');
  });

  // Dark theme and the colour-blind-safe palette keep the underlines apart.
  await b.setScheme('dark');
  await check('dark scheme: underlines stay distinct', async () => {
    const colours = await ev(`[...document.querySelectorAll('#tabs .tab-group')].map((g) => getComputedStyle(g, '::after').backgroundColor)`);
    same(new Set(colours).size, 2, `distinct underline colours ${colours}`);
  });
  await b.screenshot(`${SHOTS}/groups-dark.png`, { x: 0, y: 0, width: 1400, height: 90 });
} catch (e) {
  console.log(`FAIL setup: ${e.stack ?? e.message}`);
  failed++;
} finally {
  await b?.close?.();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
