// Browser checks for member labels (T02-29) and group fields (T02-30): the real dev app (APP_URL, default http://localhost:5203)
// in headless Chromium, driven over the DevTools protocol (tests/live/cdp.mjs), every /api/* call answered by a mock — the mock
// "server" even evaluates the calculation tree it is sent, so a group field's categories come from the tree the client built.
// Run:  node tests/live/labels-ui.mjs   (start the app first: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5203)
// Env: APP_URL, SHOTS_DIR (screenshot folder), CDP_PORT, CHROME_BIN.
import { launch } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:5203';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'labels-ui-shots');
mkdirSync(SHOTS, { recursive: true });

// ---- the mocked server ------------------------------------------------------------------------------------
const COLUMNS = { orders: [['amount', 'Float64', 'numeric'], ['region', 'String', 'text'], ['sku', 'String', 'text'], ['placed', 'DateTime', 'temporal']] };
const REGIONS = ['APAC', 'EU', 'US', 'constructor']; // "constructor": a member that is also an Object.prototype name
const SKUS = Array.from({ length: 60 }, (_, i) => `sku-${String(i).padStart(2, '0')}`);
const queries = [];
// Evaluate the wire tree the way the server's CASE would, for one region value.
const evalNode = (n, region) => {
  switch (n.k) {
    case 'field': return region;
    case 'str': return n.v;
    case 'cmp': return evalNode(n.l, region) === evalNode(n.r, region);
    case 'logic': return n.op === 'or' ? evalNode(n.l, region) || evalNode(n.r, region) : evalNode(n.l, region) && evalNode(n.r, region);
    case 'case': { for (const w of n.whens) if (evalNode(w.c, region) === true) return evalNode(w.t, region); return n.else ? evalNode(n.else, region) : null; }
    default: throw new Error(`mock cannot evaluate ${n.k}`);
  }
};
function answer({ method, path, body }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: ['orders'] };
  if (path === '/api/databases/shop/tables/orders/columns') return { json: COLUMNS.orders.map(([name, type, category]) => ({ name, type, category })) };
  if (/\/columns\/region\/distinct/.test(path)) return { json: [...REGIONS, null] };
  if (/\/columns\/sku\/distinct/.test(path)) return { json: SKUS };
  if (path === '/api/query') {
    queries.push(body);
    const dims = [...(body.rowDimensions ?? []), ...(body.columnDimensions ?? [])];
    const d = dims[0];
    const keyOf = (region) => (d?.calc ? evalNode(d.calc, region) : region);
    const groups = new Map(); // key -> sum of the regions' values
    REGIONS.forEach((r, i) => { const k = keyOf(r); groups.set(k, (groups.get(k) ?? 0) + 10 * (i + 1)); });
    const rows = dims.length ? [...groups].map(([k, v]) => ({ keys: dims.map(() => k), values: (body.measures ?? []).map(() => v) })) : [{ keys: [], values: (body.measures ?? []).map(() => 1) }];
    return { json: { rowDimensions: (body.rowDimensions ?? []).map((x) => x.column), columnDimensions: (body.columnDimensions ?? []).map((x) => x.column),
      measures: (body.measures ?? []).map((_, i) => `v${i}`), rows, truncated: false } };
  }
  return null;
}

let failed = 0, passed = 0;
async function check(name, fn) { try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; } }
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label, timeout) => b.waitFor(s, { label, timeout });
  const settle = async (quiet = 250) => { let n = -1; for (let i = 0; i < 60 && n !== queries.length; i++) { n = queries.length; await b.sleep(quiet); } };
  const last = () => queries[queries.length - 1];
  const store = (code) => ev(`(async () => { const st = await import('/features/Core/store.js'); const d = st.activeWorksheet(); ${code}; return true; })()`);
  const setSheet = (code) => store(`const s = d.sheet; const f = (c, category, extra = {}) => ({ db: 'shop', table: 'orders', column: c, category, ...extra }); ${code}; st.updateSheet(d.id, s)`);
  const chartHost = `document.querySelector('#ws-chart .ws-chart-canvas')`;
  const instOf = `window.echarts.getInstanceByDom(${chartHost})`;
  const option = (expr) => ev(`(() => { const o = ${instOf}.getOption(); return JSON.stringify(${expr}); })()`).then(JSON.parse);
  const clickBar = async (cat) => {
    const p = await ev(`(() => { const i = ${instOf}; const horiz = i.getOption().yAxis[0].type === 'category'; const [x, y] = i.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, horiz ? [5, ${J(cat)}] : [${J(cat)}, 5]); const r = ${chartHost}.getBoundingClientRect(); return [r.left + x, r.top + y]; })()`);
    await b.click(p[0], p[1]);
  };
  const fieldMenu = async (name, item) => {
    await ev(`(() => { const c = [...document.querySelectorAll('#ws-fields .ws-field')].find((x) => x.querySelector('.ws-field__name')?.textContent === ${J(name)}); c.querySelector('.ws-field__more').click(); return true; })()`);
    await ev(`(() => { const c = [...document.querySelectorAll('#ws-fields .ws-field')].find((x) => x.querySelector('.ws-field__name')?.textContent === ${J(name)}); [...c.querySelectorAll('.menu__item')].find((x) => x.textContent.trim().startsWith(${J(item)})).click(); return true; })()`);
  };
  const dlgBtn = (sel, text) => `[...document.querySelector(${J(sel)}).querySelectorAll('.dialog__foot button')].find((x) => x.textContent === ${J(text)})`;
  const typeInto = async (selector, text) => {
    await ev(`(() => { const e = document.querySelector(${J(selector)}); e.focus(); e.select(); return true; })()`);
    await b.key('Delete', { vk: 46 });
    await b.type(text);
  };
  const stripText = (sel) => ev(`document.querySelector(${J(sel)})?.textContent ?? ''`);

  // ---- setup ----
  await b.goto(APP + '/');
  await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
  await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
  await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  await ev(`(() => { const s = document.getElementById('db-select'); s.value = 'shop'; s.dispatchEvent(new Event('change')); return true; })()`);
  await waitFor(`document.querySelectorAll('.table-chip').length === 1`, 'tables');
  await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: 'orders' } }))`);
  await waitFor(`document.querySelectorAll('.entity').length === 1 && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, 'orders loaded');
  await ev(`document.querySelector('.tab-add').click(); document.querySelector('[data-new-tab=worksheet]').click()`);
  await waitFor(`!document.getElementById('worksheet-view').hidden`, 'worksheet open');
  await waitFor(`document.querySelectorAll('#ws-fields .ws-field').length >= 4`, 'fields');
  const base = `s.chartType = 'bar'; s.columns = [f('region', 'text')]; s.rows = [f('amount', 'numeric', { agg: 'sum' })]; s.selection = null; s.drill = null; s.pages = null; s.filters = []; s.color = []; s.tooltipText = null;`;
  await setSheet(base);
  await waitFor(`!!${chartHost}`, 'bar drawn');
  await settle();

  await check('before any labels the axis shows the raw members', async () => {
    must(J(await option('o.xAxis[0].data')) === J(REGIONS), `axis: ${J(await option('o.xAxis[0].data'))}`);
  });

  await check('Edit member labels…: dialog lists the members (NULL skipped), keyboard operable, Reset clears, Esc discards', async () => {
    await fieldMenu('region', 'Edit member labels');
    await waitFor(`!!document.querySelector('dialog.memlab-dialog[open]') && document.querySelectorAll('.memlab-row').length === 4`, 'dialog with 4 member rows');
    must(await ev(`document.activeElement?.classList.contains('memlab-input')`), 'focus goes to the first label input');
    must(await ev(`[...document.querySelectorAll('.memlab-row')].every((r) => r.querySelector('label').htmlFor === r.querySelector('input').id && r.querySelector('input').maxLength === 80)`), 'each member label is tied to its input, max 80');
    await typeInto('.memlab-row:nth-child(1) input', 'Asia Pacific');
    await b.key('Enter', { vk: 13 });
    must(await ev(`document.activeElement === document.querySelectorAll('.memlab-input')[1]`), 'Enter moves to the next member');
    await b.sleep(500);
    await b.screenshot(join(SHOTS, 'labels-dialog-light.png'));
    await ev(`${dlgBtn('dialog.memlab-dialog', 'Reset all')}.click()`);
    must(await ev(`[...document.querySelectorAll('.memlab-input')].every((i) => i.value === '')`), 'Reset all clears the inputs');
    await b.key('Escape', { vk: 27 });
    await b.sleep(150);
    if (await ev(`!!document.querySelector('dialog.memlab-dialog[open]')`)) await ev(`document.querySelector('dialog.memlab-dialog').dispatchEvent(new Event('cancel', { cancelable: true }))`);
    await waitFor(`!document.querySelector('dialog.memlab-dialog')`, 'dialog closed by Esc');
    must(J(await option('o.xAxis[0].data')) === J(REGIONS), 'Esc discarded: still raw');
  });

  await check('saving labels relabels the axis; the query still groups by the raw column', async () => {
    await fieldMenu('region', 'Edit member labels');
    await waitFor(`document.querySelectorAll('.memlab-row').length === 4`, 'dialog');
    await typeInto('.memlab-row:nth-child(1) input', 'Asia Pacific');
    await typeInto('.memlab-row:nth-child(4) input', 'Ctor <i>');
    await ev(`${dlgBtn('dialog.memlab-dialog', 'Save')}.click()`);
    await waitFor(`!document.querySelector('dialog.memlab-dialog')`, 'dialog closed');
    await waitFor(`${instOf}.getOption().xAxis[0].data[0] === 'Asia Pacific'`, 'axis relabelled');
    must(J(await option('o.xAxis[0].data')) === J(['Asia Pacific', 'EU', 'US', 'Ctor <i>']), `axis: ${J(await option('o.xAxis[0].data'))}`);
    const q = last();
    must(q.columnDimensions[0].column === 'region' && !J(q).includes('Asia Pacific'), `the query carries a label: ${J(q).slice(0, 300)}`);
    await b.screenshot(join(SHOTS, 'bar-labels-light.png'));
  });

  await check('click-selection: the chip shows the label, the Keep only filter carries the RAW value', async () => {
    await clickBar('Asia Pacific');
    await waitFor(`!!document.querySelector('.ws-select')`, 'selection chip');
    must(/Asia Pacific/.test(await stripText('.ws-select')) && !/APAC/.test(await stripText('.ws-select')), `chip: ${await stripText('.ws-select')}`);
    await ev(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Keep only').click()`);
    await settle();
    must((last().filters ?? []).some((f) => f.column === 'region' && f.op === '=' && f.value === 'APAC'), `filter: ${J(last().filters)}`);
    await ev(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Clear selection')?.click()`);
    await setSheet(base); await settle();
  });

  await check('pie: slice names show labels; a legend click selects the RAW member', async () => {
    await setSheet(`s.chartType = 'pie'`); await settle();
    await waitFor(`${instOf}.getOption().series[0].data.some((d) => d.name === 'Asia Pacific')`, 'pie relabelled');
    await ev(`(() => { ${instOf}.dispatchAction({ type: 'legendToggleSelect', name: 'Ctor <i>' }); return true; })()`);
    await waitFor(`!!document.querySelector('.ws-select')`, 'chip from legend');
    must(/Ctor <i>/.test(await stripText('.ws-select')), `chip: ${await stripText('.ws-select')}`);
    await ev(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Keep only').click()`);
    await settle();
    must((last().filters ?? []).some((f) => f.column === 'region' && f.value === 'constructor'), `filter: ${J(last().filters)}`);
    await setSheet(base); await settle();
  });

  await check('tooltip: the template shows the label and escapes it', async () => {
    await setSheet(`s.tooltipText = 'In <orders.region>'`); await settle();
    await waitFor(`!!${chartHost}`, 'bar drawn');
    const html = await ev(`(() => { const o = ${instOf}.getOption(); const fn = [].concat(o.tooltip)[0].formatter; return JSON.stringify([fn([{ dataIndex: 0, seriesName: 'v0', value: 1 }]), fn([{ dataIndex: 3, seriesName: 'v0', value: 1 }])]); })()`).then(JSON.parse);
    must(html[0].includes('Asia Pacific'), `tooltip: ${html[0]}`);
    must(html[1].includes('Ctor &lt;i&gt;') && !html[1].includes('<i>'), `tooltip lets markup through: ${html[1]}`);
    await setSheet(`s.tooltipText = null`);
  });

  await check('crosstab headers show labels', async () => {
    await setSheet(`s.chartType = 'table'`); await settle();
    await waitFor(`!!document.querySelector('#ws-chart table')`, 'crosstab');
    const txt = await ev(`[...document.querySelectorAll('#ws-chart table th')].map((t) => t.textContent).join('|')`);
    must(txt.includes('Asia Pacific') && txt.includes('Ctor <i>') && !txt.includes('APAC'), `headers: ${txt}`);
    await b.screenshot(join(SHOTS, 'crosstab-labels-light.png'));
    await setSheet(base); await settle();
  });

  await check('filter lists show the label with the raw value beside it; ticking one stores the RAW value', async () => {
    await setSheet(`s.filters = [{ db: 'shop', table: 'orders', column: 'region', category: 'text', op: 'in', values: [] }]`);
    await waitFor(`document.querySelectorAll('.ws-fcard__item').length === 5`, 'filter checklist');
    const rows = await ev(`[...document.querySelectorAll('.ws-fcard__item')].map((r) => [r.textContent, r.title, r.querySelector('input').checked])`);
    must(rows[0][0].startsWith('Asia Pacific') && rows[0][0].includes('APAC') && rows[0][1] === 'APAC', `row 0: ${J(rows[0])}`);
    must(rows[1][0] === 'EU' && rows[1][1] === '', `an unlabelled member is unchanged: ${J(rows[1])}`);
    await ev(`document.querySelector('.ws-fcard__item input').click()`);
    await settle();
    must((last().filters ?? []).some((f) => f.column === 'region' && J(f.values) === J(['APAC'])), `filter: ${J(last().filters)}`);
    await b.screenshot(join(SHOTS, 'filter-labels-light.png'));
    await setSheet(base); await settle();
  });

  await check('a saved-workbook round trip keeps labels and the unlabelled sheet unchanged (field settings)', async () => {
    const saved = await ev(`(async () => { const wb = await import('/features/Workbook/workbook-model.js'); const st = await import('/features/Core/store.js');
      const j = JSON.parse(JSON.stringify(wb.serializeWorkbook({ entities: new Map(), relationships: new Map(), tabs: [], active: null, fieldMeta: st.fieldMeta })));
      return JSON.stringify(j.fields); })()`);
    must(/"memberAliases":\{"APAC":"Asia Pacific","constructor":"Ctor <i>"\}/.test(saved), `saved fields: ${saved}`);
  });

  // ---- groups ----
  await check('Group…: name a group, put members in, save -> a "region (groups)" calculated field appears', async () => {
    await fieldMenu('region', 'Group');
    await waitFor(`!!document.querySelector('dialog.grp-dialog[open]') && document.querySelectorAll('.grp-member').length === 4`, 'group dialog with 4 members');
    must(await ev(`document.querySelector('dialog.grp-dialog .input').value === 'region (groups)'`), 'default name');
    must(await ev(`document.querySelector('dialog.grp-dialog .dialog__foot button.btn--primary').disabled`), 'Save disabled with nothing grouped');
    await typeInto('.grp-group__name', 'Asia & Europe');
    await ev(`(() => { const sels = document.querySelectorAll('.grp-member__select'); for (const i of [0, 1]) { sels[i].value = sels[i].options[1].value; sels[i].dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
    must(/2 of 49 members grouped/.test(await stripText('.grp-status')), `status: ${await stripText('.grp-status')}`);
    must(!(await ev(`document.querySelector('dialog.grp-dialog .dialog__foot button.btn--primary').disabled`)), 'Save enabled');
    await b.sleep(500);
    await b.screenshot(join(SHOTS, 'group-dialog-light.png'));
    await ev(`${dlgBtn('dialog.grp-dialog', 'Save')}.click()`);
    await waitFor(`!document.querySelector('dialog.grp-dialog')`, 'dialog closed');
    await waitFor(`[...document.querySelectorAll('#ws-fields .ws-field')].some((c) => c.querySelector('.ws-field__name')?.textContent === 'region (groups)')`, 'group field in the pane');
  });

  await check('using the group field: the request carries the CASE tree with bound string literals; the chart shows the group names', async () => {
    await setSheet(`const st2 = st; const c = st2.calculations.find((x) => x.name === 'region (groups)'); const { makeCalcPill } = await import('/features/Calc/calc-pill.js'); s.columns = [makeCalcPill(c, { type: 'text', isAggregate: false })]; s.rows = [f('amount', 'numeric', { agg: 'sum' })]; s.filters = []`);
    await settle();
    const dim = last().columnDimensions[0];
    must(dim.calc?.k === 'case', `no case tree: ${J(dim).slice(0, 300)}`);
    must(dim.calc.whens.length === 1 && dim.calc.whens[0].t.v === 'Asia & Europe', `whens: ${J(dim.calc.whens).slice(0, 300)}`);
    const lits = J(dim.calc).match(/"k":"str","v":"[^"]*"/g);
    must(J(lits) === J(['"k":"str","v":"APAC"', '"k":"str","v":"EU"', '"k":"str","v":"Asia & Europe"']), `literals: ${J(lits)}`);
    must(dim.calc.else.k === 'field' && dim.calc.else.column === 'region', `else: ${J(dim.calc.else)}`);
    await waitFor(`${instOf}.getOption().xAxis[0].data.includes('Asia & Europe')`, 'categories');
    must(J(await option('o.xAxis[0].data')) === J(['Asia & Europe', 'US', 'constructor']), `categories: ${J(await option('o.xAxis[0].data'))}`);
    must(J(await option('o.series[0].data')) === J([30, 30, 40]), `values (APAC+EU=30): ${J(await option('o.series[0].data'))}`);
    await b.screenshot(join(SHOTS, 'group-chart-light.png'));
  });

  await check('a remainder label: ungrouped members are labelled "Other", NULL is not; request tree has the extra WHEN', async () => {
    await ev(`(() => { const c = [...document.querySelectorAll('#ws-fields .calc-field')].find((x) => x.querySelector('.ws-field__name')?.textContent === 'region (groups)'); c.querySelector('.ws-field__more').click(); [...c.querySelectorAll('.menu__item')].find((x) => x.textContent.trim() === 'Edit…').click(); return true; })()`);
    await waitFor(`!!document.querySelector('dialog.grp-dialog[open]') && document.querySelectorAll('.grp-member').length === 4`, 'edit dialog');
    must(await ev(`document.querySelector('.grp-other input[type=text]').disabled`), 'label input off until ticked');
    await ev(`document.querySelector('.grp-other input[type=checkbox]').click()`);
    must(await ev(`document.querySelector('.grp-other input[type=text]').value === 'Other'`), 'default label');
    await b.sleep(300);
    await b.screenshot(join(SHOTS, 'group-other-light.png'));
    await ev(`${dlgBtn('dialog.grp-dialog', 'Save')}.click()`);
    await waitFor(`!document.querySelector('dialog.grp-dialog')`, 'closed');
    await settle();
    const dim = last().columnDimensions[0];
    must(dim.calc.whens.length === 2 && dim.calc.whens[1].t.v === 'Other' && dim.calc.whens[1].c.k === 'not', `whens: ${J(dim.calc.whens).slice(0, 400)}`);
  });

  await check('editing a group field reopens the dialog with the groups filled in', async () => {
    await ev(`(() => { const c = [...document.querySelectorAll('#ws-fields .calc-field')].find((x) => x.querySelector('.ws-field__name')?.textContent === 'region (groups)'); c.querySelector('.ws-field__more').click(); [...c.querySelectorAll('.menu__item')].find((x) => x.textContent.trim() === 'Edit…').click(); return true; })()`);
    await waitFor(`!!document.querySelector('dialog.grp-dialog[open]') && document.querySelectorAll('.grp-member').length === 4`, 'edit dialog');
    must(await ev(`document.querySelector('.grp-group__name').value === 'Asia & Europe'`), 'group name restored');
    must(await ev(`[...document.querySelectorAll('.grp-member__select')].map((s) => s.selectedOptions[0].textContent).join('|') === 'Asia & Europe|Asia & Europe|(not grouped)|(not grouped)'`), 'assignments restored');
    await ev(`${dlgBtn('dialog.grp-dialog', 'Cancel')}.click()`);
    await waitFor(`!document.querySelector('dialog.grp-dialog')`, 'closed');
  });

  await check('more members than the node budget is refused at edit time with a plain message', async () => {
    await fieldMenu('sku', 'Group');
    await waitFor(`!!document.querySelector('dialog.grp-dialog[open]') && document.querySelectorAll('.grp-member').length === 60`, '60 members');
    const assign = (n) => ev(`(() => { const sels = document.querySelectorAll('.grp-member__select'); sels.forEach((s, i) => { s.value = i < ${n} ? s.options[1].value : ''; s.dispatchEvent(new Event('change', { bubbles: true })); }); return true; })()`);
    await assign(50);
    must(await ev(`document.querySelector('dialog.grp-dialog .dialog__foot button.btn--primary').disabled`), 'Save enabled over the budget');
    must(/49 members/.test(await stripText('.grp-error:not(:empty)')), `message: ${await stripText('.grp-dialog__body .grp-error:not(:empty)')}`);
    await assign(49);
    must(!(await ev(`document.querySelector('dialog.grp-dialog .dialog__foot button.btn--primary').disabled`)), 'Save disabled at exactly 49');
    await ev(`(() => { const c = document.querySelector('.grp-other input[type=checkbox]'); c.click(); return true; })()`);
    must(await ev(`document.querySelector('dialog.grp-dialog .dialog__foot button.btn--primary').disabled`), 'with a remainder label, 49 members are over the budget');
    must(/48 members/.test(await stripText('.grp-error:not(:empty)')), `message: ${await stripText('.grp-error:not(:empty)')}`);
    await assign(48);
    must(!(await ev(`document.querySelector('dialog.grp-dialog .dialog__foot button.btn--primary').disabled`)), 'Save enabled at 48 with the label');
    await ev(`${dlgBtn('dialog.grp-dialog', 'Cancel')}.click()`);
    await waitFor(`!document.querySelector('dialog.grp-dialog')`, 'closed');
  });

  await check('a numeric / date field refuses Group… with a message', async () => {
    await fieldMenu('amount', 'Group');
    await waitFor(`/text fields only/.test(document.getElementById('toast')?.textContent ?? '')`, 'refusal toast');
    must(!(await ev(`!!document.querySelector('dialog.grp-dialog')`)), 'no dialog for a numeric field');
    must(!(await ev(`[...document.querySelectorAll('#ws-fields .ws-field')].find((c) => c.querySelector('.ws-field__name')?.textContent === 'placed')?.querySelector('.menu__item') ? [...[...document.querySelectorAll('#ws-fields .ws-field')].find((c) => c.querySelector('.ws-field__name')?.textContent === 'placed').querySelectorAll('.menu__item')].some((x) => /member labels/.test(x.textContent)) : false`)), 'a date field offers no member labels');
  });

  // ---- dark ----
  await b.setScheme('dark');
  await check('dark screenshots of the dialogs and the labelled chart', async () => {
    await setSheet(base); await settle();
    await b.screenshot(join(SHOTS, 'bar-labels-dark.png'));
    await fieldMenu('region', 'Edit member labels');
    await waitFor(`document.querySelectorAll('.memlab-row').length === 4`, 'dialog');
    await b.sleep(500);
    await b.screenshot(join(SHOTS, 'labels-dialog-dark.png'));
    await ev(`${dlgBtn('dialog.memlab-dialog', 'Cancel')}.click()`);
    await fieldMenu('region', 'Group');
    await waitFor(`document.querySelectorAll('.grp-member').length === 4`, 'group dialog');
    await b.sleep(500);
    await b.screenshot(join(SHOTS, 'group-dialog-dark.png'));
    await ev(`${dlgBtn('dialog.grp-dialog', 'Cancel')}.click()`);
  });

  if (b.consoleErrors.length) console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  '));
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
