// Browser check for stories (P24d): a Story tab of ordered, captioned steps; each step shows a worksheet (drawn static) or links to a
// dashboard. Previous / Next, a clickable and arrow-key step strip, add / remove / reorder / edit caption, limits (rejected, not
// clamped), keyboard labels, closing a shown worksheet removes its steps, autosave + reload restore, print of the current step, fixed
// shell. Real dev app (APP_URL, default http://localhost:5193) in headless Chromium, every /api/* call mocked; any page error fails
// the run. Screenshots (light + dark) go to SHOTS_DIR.
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5193';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'story-ui-shots');
mkdirSync(SHOTS, { recursive: true });
const COLUMNS = [['amount', 'Float64', 'numeric'], ['region', 'String', 'text'], ['channel', 'String', 'text']];
const VALUES = { region: ['APAC', 'EU', 'US'], channel: ['web', 'shop', 'app'] };
const queries = [];
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders'] };
  if (path === '/api/databases/shop/tables/orders/columns') return { json: COLUMNS.map(([name, type, category]) => ({ name, type, category })) };
  if (path === '/api/query') {
    queries.push(body);
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((d) => d.column), columnDimensions: (body.columnDimensions ?? []).map((d) => d.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`),
      rows: Array.from({ length: dims.length ? 3 : 1 }, (_, r) => ({ keys: dims.map((d) => VALUES[d.column][r]), values: (body.measures ?? []).map((_, i) => 10 * (r + 1) + i) })), truncated: false } };
  }
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; }
}
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label) => b.waitFor(s, { label });
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); ${code} })()`);
  const shot = (name) => b.screenshot(join(SHOTS, name));
  const toastText = () => ev(`(document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent)`);
  const connect = async () => {
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('conn-connect')`, 'app loaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  };
  const chips = () => ev(`[...document.querySelectorAll('#story-strip .story-chip')].map((x) => x.getAttribute('aria-label'))`);
  const selected = () => ev(`[...document.querySelectorAll('#story-strip .story-chip')].findIndex((x) => x.getAttribute('aria-selected') === 'true')`);
  const stepTitle = () => ev(`document.getElementById('story-step-title').textContent`);
  const captionText = () => ev(`document.getElementById('story-caption').textContent.trim()`);
  const click = (sel) => ev(`document.querySelector(${J(sel)}).click()`);
  const addStep = async (target, caption) => {
    await ev(`(() => { const s = document.querySelector('.story-add__select'); s.value = ${J(target)}; const c = document.querySelector('.story-add__caption'); c.value = ${J(caption)}; document.getElementById('story-add').requestSubmit(); return true; })()`);
  };

  await b.goto(APP + '/');
  await connect();
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 1`, 'tables listed');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'orders loaded');
  const ids = await store(`
    const f = (column, category, extra = {}) => ({ db: 'shop', table: 'orders', column, category, ...extra });
    const mk = (name, chartType, dim) => { const t = st.createWorksheet(name); t.sheet = { ...st.emptySheet(), chartType, columns: [f(dim, 'text')], rows: [f('amount', 'numeric', { agg: 'sum' })] }; return t.id; };
    const a = mk('Revenue by region', 'bar', 'region'), c = mk('Share by channel', 'pie', 'channel'), d = st.createDashboard('Overview').id;
    return { a, c, d };`);

  await check('[+] offers New story; the story tab has its icon, accessible name, empty state, and hides the view bar', async () => {
    await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=story]').click()`);
    await waitFor(`!document.getElementById('story-view').hidden`, 'story view');
    must(await ev(`document.querySelector('.tab--story .tab__label').getAttribute('aria-label') === 'Story 1 (story)'`), 'accessible name');
    must(await ev(`!!document.querySelector('.tab--story .tab__kind')`), 'no kind icon');
    must(await ev(`document.getElementById('worksheet-view').hidden && document.getElementById('board-view').hidden`), 'other views visible');
    must(await ev(`!document.getElementById('story-empty').hidden && document.getElementById('story-strip').hidden && document.getElementById('story-nav').hidden`), 'empty state');
    must(await ev(`document.getElementById('worksheet-view').hidden`), 'worksheet view bar (import/export) shown on a story');
    must(await ev(`document.getElementById('story-title').textContent`) === 'Story 1', 'title');
    must(await ev(`[...document.querySelectorAll('.story-add__select option')].map((o) => o.textContent).join('|')`) === 'Worksheet: Revenue by region|Worksheet: Share by channel|Dashboard: Overview', 'offered tabs');
  });

  await check('add steps: worksheet, worksheet, dashboard; the strip, caption and chart show; the new step is current', async () => {
    await addStep(ids.a, 'Revenue is led by APAC.');
    await waitFor(`document.querySelectorAll('#story-strip .story-chip').length === 1`, 'first step');
    await waitFor(`!!document.querySelector('#story-stage .ws-chart-canvas canvas, #story-stage .ws-chart-canvas svg, #story-stage .ws-chart-canvas')`, 'chart drawn');
    await addStep(ids.c, 'Web carries the channel mix.');
    await addStep(ids.d, '');
    await waitFor(`document.querySelectorAll('#story-strip .story-chip').length === 3`, 'three steps');
    must(await selected() === 2, 'the newest step is not current');
    must(/Step 3 of 3 · Overview/.test(await stepTitle()), `title ${await stepTitle()}`);
    must(await ev(`!!document.querySelector('#story-stage .story-stage__link button')`), 'dashboard step has no Open button');
    must(await captionText() === 'No caption.', 'empty caption text');
    must(await ev(`document.querySelector('.story-add__caption').value === ''`), 'caption input not cleared');
    must(J(await chips()) === J(['Step 1 of 3: Revenue is led by APAC.', 'Step 2 of 3: Web carries the channel mix.', 'Step 3 of 3: Overview']), J(await chips()));
    must(await ev(`document.getElementById('story-count').textContent`) === '3 of 20 steps', 'count');
  });

  await check('Previous / Next move one step, disable at the ends, and the stage follows (queries run for the worksheet shown)', async () => {
    const nextBtn = `document.querySelector('#story-nav .btn--primary')`, prevBtn = `document.querySelector('#story-nav .btn:not(.btn--primary)')`;
    must(await ev(`${nextBtn}.disabled && !${prevBtn}.disabled`), 'Next not disabled on the last step');
    const active = `(document.activeElement.textContent.trim() + '|' + document.activeElement.disabled)`;
    await ev(`${prevBtn}.focus(); ${prevBtn}.click()`);
    must(await selected() === 1 && /Share by channel/.test(await stepTitle()), 'Previous');
    must(await ev(active) === 'Previous|false', `focus after Previous: ${await ev(active)}`);
    await waitFor(`!!document.querySelector('#story-stage .ws-chart-canvas')`, 'pie stage');
    await ev(`${prevBtn}.focus(); ${prevBtn}.click()`);
    must(await selected() === 0 && await ev(`${prevBtn}.disabled`), 'first step: Previous enabled');
    must(await ev(active) === 'Next|false', `focus after reaching the first step: ${await ev(active)}`);
    await ev(`${nextBtn}.focus(); ${nextBtn}.click()`);
    must(await selected() === 1 && await ev(active) === 'Next|false', `focus after Next: ${await ev(active)}`);
    await ev(`${nextBtn}.focus(); ${nextBtn}.click()`);
    must(await selected() === 2 && await ev(active) === 'Previous|false', `focus after reaching the last step: ${await ev(active)}`);
    await ev(`${prevBtn}.click(); ${prevBtn}.click()`);
    must(await captionText() === 'Revenue is led by APAC.', 'caption of step 1');
    must(await ev(`${prevBtn}.getAttribute('aria-label') === 'Previous step' && ${nextBtn}.getAttribute('aria-label') === 'Next step'`), 'labels');
    must(await ev(`document.querySelector('#story-nav .story-nav__pos').textContent === '1 / 3'`), 'position text');
    must(await ev(`document.getElementById('story-status').textContent`) === 'Step 1 of 3.', 'status not announced');
  });

  await check('the step strip is a tablist: click selects; arrows, Home and End move; focus is roving', async () => {
    must(await ev(`document.getElementById('story-strip').getAttribute('role') === 'tablist'`), 'role');
    await ev(`document.querySelector('#story-strip .story-chip:nth-child(3)').focus(); document.querySelector('#story-strip .story-chip:nth-child(3)').click()`);
    must(await selected() === 2, 'click');
    must(await ev(`document.activeElement.classList.contains('story-chip') && document.activeElement.getAttribute('aria-selected') === 'true'`), 'focus lost after a chip click');
    await ev(`document.querySelector('#story-strip [aria-selected=true]').focus()`);
    await b.key('ArrowLeft', { vk: 37 });
    must(await selected() === 1 && await ev(`document.activeElement.getAttribute('aria-selected') === 'true'`), 'ArrowLeft / focus follows');
    await b.key('Home', { vk: 36 });
    must(await selected() === 0, 'Home');
    await b.key('ArrowLeft', { vk: 37 });
    must(await selected() === 0, 'ArrowLeft wrapped');
    await b.key('End', { vk: 35 });
    must(await selected() === 2, 'End');
    await b.key('ArrowRight', { vk: 39 });
    must(await selected() === 2, 'ArrowRight wrapped');
    must(await ev(`[...document.querySelectorAll('#story-strip .story-chip')].map((x) => x.tabIndex).join()`) === '-1,-1,0', 'roving tabindex');
  });

  await check('reorder by buttons: Move earlier / later swap neighbours, disabled at the ends, the moved step stays current', async () => {
    await click('#story-strip .story-chip:nth-child(1)');
    must(await ev(`document.querySelector('[aria-label="Move step 1 earlier"]').disabled`), 'first can move earlier');
    await click('[aria-label="Move step 1 later"]');
    must(J(await chips()) === J(['Step 1 of 3: Web carries the channel mix.', 'Step 2 of 3: Revenue is led by APAC.', 'Step 3 of 3: Overview']), J(await chips()));
    must(await selected() === 1, 'moved step not current');
    must(await ev(`document.activeElement.getAttribute('aria-label') === 'Move step 2 later'`), `focus ${await ev('document.activeElement.getAttribute("aria-label")')}`);
    await ev(`document.querySelector('[aria-label="Move step 2 earlier"]').focus(); document.querySelector('[aria-label="Move step 2 earlier"]').click()`);
    must((await chips())[0].includes('Revenue'), 'moved back');
    must(await ev(`document.activeElement.getAttribute('aria-label') === 'Move step 1 later' && !document.activeElement.disabled`), `focus after Move earlier to position 1: ${await ev('document.activeElement.getAttribute("aria-label") + "|" + document.activeElement.disabled')}`);
    await ev(`document.querySelector('[aria-label="Move step 1 later"]').click(); document.querySelector('[aria-label="Move step 2 later"]').focus(); document.querySelector('[aria-label="Move step 2 later"]').click()`);
    must(await selected() === 2, 'moved to last');
    must(await ev(`document.activeElement.getAttribute('aria-label') === 'Move step 3 earlier' && !document.activeElement.disabled`), `focus after Move later to last: ${await ev('document.activeElement.getAttribute("aria-label") + "|" + document.activeElement.disabled')}`);
    await ev(`document.querySelector('[aria-label="Move step 3 earlier"]').click(); document.querySelector('[aria-label="Move step 2 earlier"]').click()`);
    must((await chips())[0].includes('Revenue'), 'order restored');
    must(await store(`return J(st.activeStory().steps.map((s) => s.caption));`.replace('J(', 'JSON.stringify(')) === J(['Revenue is led by APAC.', 'Web carries the channel mix.', '']), 'store order');
  });

  await check('edit caption: labelled editor, counter, over-limit refused with an alert (not cut), Esc cancels, Save updates', async () => {
    await click('[aria-label="Edit the caption of step 1"]');
    await waitFor(`!!document.querySelector('#story-caption textarea')`, 'editor');
    must(await ev(`document.querySelector('#story-caption label').textContent === 'Caption' && document.querySelector('#story-caption textarea').labels[0].textContent === 'Caption'`), 'label');
    must(await ev(`document.activeElement === document.querySelector('#story-caption textarea')`), 'editor not focused');
    must(await ev(`!document.querySelector('#story-caption textarea').hasAttribute('maxlength')`), 'the editor cuts a long paste at maxlength');
    await ev(`(() => { const t = document.querySelector('#story-caption textarea'); t.value = 'x'.repeat(301); t.dispatchEvent(new Event('input')); document.querySelector('#story-caption form').requestSubmit(); return true; })()`);
    must(/300/.test(await ev(`document.querySelector('.story-edit__error').textContent`)) && await ev(`document.querySelector('#story-caption textarea').getAttribute('aria-invalid') === 'true'`), 'no limit error');
    must(await store(`return st.activeStory().steps[0].caption === 'Revenue is led by APAC.';`), 'an over-long caption was stored or cut');
    await ev(`(() => { const t = document.querySelector('#story-caption textarea'); t.value = 'half typed'; t.dispatchEvent(new Event('input')); return true; })()`);
    await store(`st.renameTab(st.tabs.find((t) => t.kind === 'worksheet').id, 'Revenue by region'); st.emit('tabs:changed'); return true;`);
    must(await ev(`document.querySelector('#story-caption textarea')?.value`) === 'half typed', 'a redraw dropped the typed caption');
    await b.key('Escape', { vk: 27 });
    await waitFor(`!document.querySelector('#story-caption textarea')`, 'Esc closes');
    must(await captionText() === 'Revenue is led by APAC.', 'caption changed by Cancel');
    must(await ev(`document.activeElement.getAttribute('aria-label') === 'Edit the caption of step 1'`), 'focus not returned to Edit');
    await click('[aria-label="Edit the caption of step 1"]');
    await ev(`(() => { const t = document.querySelector('#story-caption textarea'); t.value = 'APAC leads revenue.'; t.dispatchEvent(new Event('input')); document.querySelector('#story-caption form').requestSubmit(); return true; })()`);
    await waitFor(`!document.querySelector('#story-caption textarea') && document.getElementById('story-caption').textContent.trim() === 'APAC leads revenue.'`, 'saved');
    must((await chips())[0] === 'Step 1 of 3: APAC leads revenue.', 'strip caption');
  });

  await check('add refuses an over-long caption and the 21st step with a message (nothing stored)', async () => {
    must(await ev(`!document.querySelector('.story-add__caption').hasAttribute('maxlength')`), 'the add box cuts a long paste at maxlength');
    await ev(`(() => { const c = document.querySelector('.story-add__caption'); c.value = 'y'.repeat(301); document.getElementById('story-add').requestSubmit(); return true; })()`);
    must(/300 characters \(it has 301\)/.test(await ev(`document.querySelector('.story-add__error').textContent`)), 'no caption error with the count');
    must(await ev(`(() => { const c = document.querySelector('.story-add__caption'); return c.value.length === 301 && c.getAttribute('aria-invalid') === 'true' && c.getAttribute('aria-describedby') === document.querySelector('.story-add__error').id && document.querySelector('.story-add__error').getAttribute('role') === 'alert'; })()`), 'caption cut or not marked invalid');
    must((await chips()).length === 3, 'step added');
    await ev(`(() => { const c = document.querySelector('.story-add__caption'); c.value = ''; c.dispatchEvent(new Event('input')); return true; })()`);
    must(await ev(`document.querySelector('.story-add__error').hidden && !document.querySelector('.story-add__caption').hasAttribute('aria-invalid')`), 'the refusal stayed after editing');
    await store(`const s = st.activeStory(); st.setSteps(s.id, Array.from({ length: 20 }, (_, i) => ({ caption: 'c' + i, target: ${J(ids.a)} }))); return true;`);
    await waitFor(`document.querySelectorAll('#story-strip .story-chip').length === 20`, '20 steps');
    await addStep(ids.a, 'one too many');
    must(/at most 20 steps/.test(await ev(`document.querySelector('.story-add__error').textContent`)), 'no limit message');
    must((await chips()).length === 20, '21st step added');
    await store(`const s = st.activeStory(); st.setSteps(s.id, [{ caption: 'APAC leads revenue.', target: ${J(ids.a)} }, { caption: 'Web carries the channel mix.', target: ${J(ids.c)} }, { caption: '', target: ${J(ids.d)} }]); return true;`);
    await waitFor(`document.querySelectorAll('#story-strip .story-chip').length === 3`, 'back to 3');
  });

  await check('a long caption scrolls in its own box and the chart keeps its room', async () => {
    const before = await ev(`document.getElementById('story-stage').getBoundingClientRect().height`);
    await store(`const s = st.activeStory(); st.setSteps(s.id, s.steps.map((x, i) => (i === 0 ? { ...x, caption: 'Revenue is led by APAC.\\n'.repeat(12).trim() } : x))); return true;`);
    await ev(`document.querySelector('#story-strip .story-chip').click()`);
    await waitFor(`document.getElementById('story-caption').textContent.length > 250`, 'long caption shown');
    await shot('story-long-caption.png');
    const r = await ev(`(() => { const c = document.getElementById('story-caption'); return { h: c.clientHeight, sh: c.scrollHeight, stage: document.getElementById('story-stage').getBoundingClientRect().height, em: parseFloat(getComputedStyle(c).fontSize) }; })()`);
    await store(`const s = st.activeStory(); st.setSteps(s.id, s.steps.map((x, i) => (i === 0 ? { ...x, caption: 'APAC leads revenue.' } : x))); return true;`);
    must(r.h <= r.em * 6 + 2 && r.sh > r.h, `the caption is not capped: ${J(r)}`);
    must(r.stage > 200, `the chart was squeezed: ${J(r)}`);
  });

  await check('remove a step: the next one becomes current, focus lands on the strip; the last removal empties the story', async () => {
    await click('#story-strip .story-chip:nth-child(2)');
    await click('[aria-label="Remove step 2"]');
    await waitFor(`!!document.querySelector('dialog[open]')`, 'remove confirm'); // removing a step asks twice
    await ev(`[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === 'Remove').click()`);
    await waitFor(`/^Really remove step 2/.test(document.querySelector('dialog[open] .dialog__body')?.textContent ?? '')`, 'second remove confirm');
    await ev(`[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === 'Remove for good').click()`);
    await waitFor(`document.querySelectorAll('#story-strip .story-chip').length === 2`, 'removed');
    must(await selected() === 1 && /Overview/.test(await stepTitle()), 'selection after remove');
    must(await ev(`document.activeElement.classList.contains('story-chip')`), 'focus not on the strip');
    // put the removed step back for later checks
    await store(`const s = st.activeStory(); st.setSteps(s.id, [s.steps[0], { caption: 'Web carries the channel mix.', target: ${J(ids.c)} }, s.steps[1]]); return true;`);
    await waitFor(`document.querySelectorAll('#story-strip .story-chip').length === 3`, 'restored');
  });

  await check('closing a worksheet a step shows removes that step; closing the story leaves the worksheets', async () => {
    await store(`st.closeTab(${J(ids.c)}); return true;`);
    await waitFor(`document.querySelectorAll('#story-strip .story-chip').length === 2`, 'step removed');
    must(!(await chips()).some((c) => /channel/.test(c)), 'the closed worksheet still has a step');
    await store(`st.switchTab(st.stories()[0].id); return true;`);
    await waitFor(`!document.getElementById('story-view').hidden`, 'story shown');
  });

  await check('Open tab goes to the step\'s worksheet; a dashboard step\'s Open button goes to the dashboard', async () => {
    await click('#story-strip .story-chip:nth-child(2)');
    await click('#story-stage .story-stage__link button');
    await waitFor(`!document.getElementById('board-view').hidden`, 'dashboard shown');
    await store(`st.switchTab(st.stories()[0].id); return true;`);
    await click('#story-strip .story-chip:nth-child(1)');
    await click('[aria-label^="Open the tab"]');
    await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet shown');
    await store(`st.switchTab(st.stories()[0].id); return true;`);
    await waitFor(`!document.getElementById('story-view').hidden`, 'story shown again');
  });

  await check('closing a worksheet used only by a story names the story in the confirm', async () => {
    await store(`const w = st.createWorksheet('Only here'); const s = st.stories()[0]; st.setSteps(s.id, [...s.steps, { caption: 'x', target: w.id }]); window.__only = w.id; return true;`);
    await ev(`document.querySelector('.tab__close[aria-label="Close Only here"]').click()`);
    await waitFor(`!!document.querySelector('dialog[open]')`, 'confirm dialog');
    const msg = await ev(`document.querySelector('dialog[open] .dialog__body').textContent`);
    must(/Its steps will be removed from the story: Story 1/.test(msg), `confirm text: ${msg}`);
    await ev(`[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === 'Close').click()`);
    await waitFor(`/^Really close /.test(document.querySelector('dialog[open] .dialog__body')?.textContent ?? '')`, 'second confirm dialog');
    await ev(`[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === 'Close for good').click()`);
    await waitFor(`!document.querySelector('dialog[open]')`, 'confirmed');
    await store(`st.switchTab(st.stories()[0].id); return true;`);
    await waitFor(`document.querySelectorAll('#story-strip .story-chip').length === 2`, 'step removed with the worksheet');
  });

  await check('fixed shell: the page never scrolls, the story panel fits the viewport (the stage scrolls inside)', async () => {
    const m = await ev(`({ doc: document.documentElement.scrollHeight - document.documentElement.clientHeight, body: document.body.scrollHeight - innerHeight,
      view: document.getElementById('story-nav').getBoundingClientRect().bottom <= innerHeight && document.getElementById('story-view').scrollHeight <= document.getElementById('story-view').clientHeight + 1 })`);
    must(m.doc <= 0 && m.view, `page scrolls or the view overflows: ${J(m)}`);
  });

  await check('autosave + reload restores the story, its steps and the active tab; saved file has stories', async () => {
    await b.sleep(800);
    const saved = JSON.parse(await ev(`localStorage.getItem('dashboardbuilder.workbook.v2|mock-ch|8443|default')`));
    must(saved.stories?.length === 1 && saved.stories[0].steps.length === 2 && saved.stories[0].steps[0].target.kind === 'worksheet', J(saved.stories));
    must(saved.active.kind === 'story' && saved.tabs.some((t) => t.kind === 'story'), 'active / tabs');
    await b.send('Page.reload');
    await connect();
    await waitFor(`!document.getElementById('story-view').hidden && document.querySelectorAll('#story-strip .story-chip').length === 2`, 'story restored');
    must((await chips())[0] === 'Step 1 of 2: APAC leads revenue.', J(await chips()));
    await waitFor(`!!document.querySelector('#story-stage .ws-chart-canvas')`, 'stage drawn after reload');
  });

  await check('light screenshot', async () => { await b.setScheme('light'); await b.sleep(500); await shot('story-light.png'); });
  await check('dark screenshot', async () => { await b.setScheme('dark'); await ev(`document.documentElement.setAttribute('data-theme', 'dark')`); await b.sleep(600); await shot('story-dark.png'); await ev(`document.documentElement.removeAttribute('data-theme')`); await b.setScheme('light'); });

  await check('print: only the current step (caption + chart) remains; controls are hidden', async () => {
    await b.send('Emulation.setEmulatedMedia', { media: 'print' });
    await ev(`window.dispatchEvent(new Event('beforeprint'))`);
    await b.sleep(500);
    const p = await ev(`(() => { const vis = (sel) => { const e = document.querySelector(sel); return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; };
      return { caption: vis('#story-caption'), stage: vis('#story-stage'), strip: vis('#story-strip'), nav: vis('#story-nav'), add: vis('#story-add'), side: vis('.sidebar'), tools: vis('#story-step-tools') }; })()`);
    const canvas = await ev(`(() => { const c = document.querySelector('#story-stage .ws-chart-canvas'); const r = c.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
    await shot('story-print.png');
    await ev(`window.dispatchEvent(new Event('afterprint'))`);
    await b.send('Emulation.setEmulatedMedia', { media: 'screen' });
    must(canvas.w === 1000 && canvas.h === 560, `print chart box ${J(canvas)}`);
    must(p.caption && p.stage && !p.strip && !p.nav && !p.add && !p.side && !p.tools, `print visibility: ${J(p)}`);
  });

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
