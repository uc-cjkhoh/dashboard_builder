// Browser check: auto-backup to a folder on disk (Workbook/backup.js), the Settings dialog and its two buttons. Real dev app (APP_URL, default
// http://localhost:5188) in headless Chromium over the DevTools protocol (tests/live/cdp.mjs); every /api/* call is mocked.
// The folder picker is replaced by one that answers with a folder in the page's origin-private file system: the same FileSystemDirectoryHandle
// interface (and IndexedDB storage of it) as a real picked folder. What this can't cover: the real picker window and the permission prompt.
// Run: node tests/live/auto-backup-ui.mjs  (start the app: cd src/DashboardBuilder && dotnet run --no-launch-profile --urls http://localhost:5188; stop it by port)
import { launch } from './cdp.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5188';
const PASSWORD = 'sekret-pass-9917';
const COLUMNS = {
  orders: [['cust_id', 'Int32', 'numeric'], ['amount', 'Float64', 'numeric']],
  customers: [['id', 'Int32', 'numeric'], ['name', 'String', 'text']],
};
function answer({ method, path }) {
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
  if (path === '/api/databases/shop/tables') return { json: Object.keys(COLUMNS) };
  const m = path.match(/^\/api\/databases\/shop\/tables\/(\w+)\/columns$/);
  if (m && COLUMNS[m[1]]) return { json: COLUMNS[m[1]].map(([name, type, category]) => ({ name, type, category })) };
  return null;
}
let failed = 0, passed = 0;
async function check(name, fn) { try { await fn(); console.log(`ok ${name}`); passed++; } catch (e) { console.log(`FAIL ${name}: ${e.message}`); failed++; } }
const must = (c, m) => { if (!c) throw new Error(m); };
const J = JSON.stringify;
const FOLDER = 'mock-ch-8443-default';

let b = null;
try {
  b = await launch({ port: process.env.CDP_PORT ? Number(process.env.CDP_PORT) : undefined });
  await b.mock(answer);
  const ev = (s) => b.evaluate(s);
  const waitFor = (s, label, timeout) => b.waitFor(s, { label, timeout });
  await b.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await b.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.showDirectoryPicker = async () => { const r = await navigator.storage.getDirectory(); return r.getDirectoryHandle('picked', { create: true }); };`,
  });

  // The files in the picked folder: { "<connection folder>": [names] }.
  const files = () => ev(`(async () => { const r = await navigator.storage.getDirectory(); const out = {};
    try { const root = await (await r.getDirectoryHandle('picked')).getDirectoryHandle('DashboardBuilder-backups');
      for await (const [n, h] of root.entries()) { const names = []; for await (const [f] of h.entries()) names.push(f); out[n] = names.sort(); } } catch { /* none yet */ }
    return out; })()`);
  const readFile = (name) => ev(`(async () => { const r = await navigator.storage.getDirectory(); const d = await (await (await r.getDirectoryHandle('picked')).getDirectoryHandle('DashboardBuilder-backups')).getDirectoryHandle(${J(FOLDER)});
    return await (await (await d.getFileHandle(${J(name)})).getFile()).text(); })()`);
  const putFile = (name, text) => ev(`(async () => { const r = await navigator.storage.getDirectory(); const d = await (await (await r.getDirectoryHandle('picked')).getDirectoryHandle('DashboardBuilder-backups')).getDirectoryHandle(${J(FOLDER)});
    const w = await (await d.getFileHandle(${J(name)}, { create: true })).createWritable(); await w.write(${J(text)}); await w.close(); return true; })()`);
  const names = async () => (await files())[FOLDER] ?? [];
  const mine = async () => (await names()).filter((n) => /^workbook-\d{8}-\d{6}\.json$/.test(n));

  const connect = async () => {
    await waitFor(`!!document.getElementById('conn-connect')`, 'app loaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = ${J(PASSWORD)}; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.querySelectorAll('.db-row[data-db]').length > 0`, 'databases listed');
  };
  const addTable = async (t) => {
    await ev(`(() => { for (const r of document.querySelectorAll('.db-row[data-db]')) if ((r.dataset.db === 'shop') !== (r.getAttribute('aria-expanded') === 'true')) r.click(); return true; })()`);
    await waitFor(`document.querySelectorAll('.table-chip').length === 2`, 'tables listed');
    await ev(`document.dispatchEvent(new CustomEvent('table:add', { detail: { db: 'shop', table: ${J(t)} } }))`);
    await waitFor(`[...document.querySelectorAll('.entity')].some((x) => x.querySelector('.entity__table').textContent === ${J(t)}) && [...document.querySelectorAll('.entity__status')].every((s) => s.hidden)`, `${t} loaded`);
  };
  const openSettings = async (id) => {
    await ev(`document.getElementById(${J(id)}).click()`);
    await waitFor(`!!document.querySelector('dialog.backup-dialog[open]')`, 'settings open');
  };
  const closeSettings = async () => {
    await ev(`[...document.querySelectorAll('dialog.backup-dialog .dialog__foot button')].find((x) => x.textContent === 'Close').click()`);
    await waitFor(`!document.querySelector('dialog.backup-dialog')`, 'settings closed');
  };
  const dialogText = () => ev(`document.querySelector('dialog.backup-dialog')?.textContent ?? ''`);
  const press = (label) => ev(`(() => { const x = [...document.querySelectorAll('dialog.backup-dialog .dialog__foot button, dialog.backup-dialog .backup-row button')].find((y) => y.textContent === ${J(label)} && !y.disabled); if (!x) return false; x.click(); return true; })()`);

  await b.goto(APP + '/');
  await connect();
  await addTable('orders');

  const dockState = () => ev(`(() => { const foot = document.getElementById('sidebar-foot'), d = document.getElementById('settings-dock-btn');
    return { last: foot.lastElementChild === d && foot.parentElement.classList.contains('sidebar'), shown: !d.hidden && d.offsetParent !== null, label: d.getAttribute('aria-label'), noRail: !document.getElementById('settings-side-btn') }; })()`);
  await check('Data Source tab: Settings is the last tile of the sidebar foot, and no other Settings button exists', async () => {
    const s = await dockState();
    must(s.last && s.shown && s.noRail && s.label === 'Settings', J(s));
  });

  await check('the dialog opens with no folder chosen and says so', async () => {
    await openSettings('settings-dock-btn');
    const t = await dialogText();
    must(/None chosen/.test(t) && /Choose folder/.test(t) && /Not backing up/.test(t), t);
    await closeSettings();
  });

  await check('choosing a folder writes a backup at once: the connection folder holds one workbook file, no password in it', async () => {
    await openSettings('settings-dock-btn');
    must(await press('Choose folder…'), 'no Choose folder button');
    await waitFor(`document.querySelector('#backup-folder')?.textContent === 'picked'`, 'folder name shown');
    const t0 = Date.now(); let list = [];
    while (Date.now() - t0 < 6000 && (list = await mine()).length < 1) await b.sleep(100);
    must(list.length === 1, `files: ${J(await files())}`);
    const text = await readFile(list[0]);
    const wb = JSON.parse(text);
    must(wb.format === 'dashboard-builder-workbook' && wb.entities.some((e) => e.table === 'orders'), 'not the workbook: ' + text.slice(0, 120));
    must(!text.includes(PASSWORD), 'the password is in the backup');
    must(/Last backup \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(await dialogText()), 'status: ' + (await dialogText()));
    await closeSettings();
  });

  await check('a change right after a backup waits for the 10-minute interval: no second file', async () => {
    await addTable('customers');
    await b.sleep(2000); // the autosave (500 ms) has run and the backup has declined: too soon
    must((await mine()).length === 1, `files: ${J(await files())}`);
  });

  await check('Back up now writes at once; only the newest 5 stay; files the app did not write are never touched', async () => {
    await putFile('notes.txt', 'keep me');
    await putFile('workbook-final.json', '{}');
    await openSettings('settings-dock-btn');
    const chosenNow = () => ev(`document.querySelector('dialog.backup-dialog .backup-pick input:checked')?.value ?? ''`);
    for (let i = 0; i < 6; i++) {
      must(await press('Back up now'), 'no Back up now'); await b.sleep(1100); // names carry seconds
      const newest = [...(await mine())].sort().reverse()[0];
      must((await chosenNow()) === newest, `backup ${i + 1}: the newest (${newest}) is not the chosen one (${await chosenNow()}) while the dialog is open`);
    }
    const list = await mine();
    must(list.length === 5, `expected 5, got ${list.length}: ${J(await files())}`);
    must((await names()).includes('notes.txt') && (await names()).includes('workbook-final.json'), 'a foreign file was removed');
    const radios = await ev(`document.querySelectorAll('dialog.backup-dialog .backup-pick input').length`);
    must(radios === 5, `the dialog lists ${radios}`);
    // a choice the user makes stays chosen when another backup arrives
    const mineName = await ev(`(() => { const r = document.querySelectorAll('dialog.backup-dialog .backup-pick input')[2]; r.click(); return r.value; })()`);
    must(await press('Back up now'), 'no Back up now'); await b.sleep(1500);
    must((await chosenNow()) === mineName, `the user's choice ${mineName} was replaced by ${await chosenNow()}`);
    await closeSettings();
  });

  await check('a worksheet tab: Settings is in the sidebar foot too; it opens the same dialog', async () => {
    await ev(`(async () => { const s = await import('/features/Core/store.js'); s.createWorksheet('Sheet 1'); return true; })()`);
    await waitFor(`document.querySelector('.app').dataset.view === 'sheet'`, 'worksheet view');
    const s = await dockState();
    must(s.last && s.shown && s.noRail, J(s));
    await openSettings('settings-dock-btn');
    await waitFor(`document.querySelector('#backup-folder')?.textContent === 'picked'`, 'folder name shown');
    must(/Auto-backup/.test(await dialogText()) && /picked/.test(await dialogText()), 'wrong dialog');
    await closeSettings();
  });

  await check('a dashboard tab and a story tab keep Settings in the sidebar foot too', async () => {
    await ev(`(async () => { const s = await import('/features/Core/store.js'); s.createDashboard('Board 1'); return true; })()`);
    await waitFor(`document.querySelector('.app').dataset.view === 'board'`, 'board view');
    const d = await dockState();
    must(d.last && d.shown, 'dashboard: ' + J(d));
    await ev(`(async () => { const s = await import('/features/Core/store.js'); s.createStory('Story 1'); return true; })()`);
    await b.sleep(500);
    const t = await dockState();
    must(t.last && t.shown, 'story: ' + J(t));
  });

  await check('with the stored workbook gone and the folder still known, connecting offers the newest backup; Restore opens it', async () => {
    await b.sleep(1000); // let the pending autosave land before the key is removed
    await ev(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('dashboardbuilder.workbook')) localStorage.removeItem(k); return true; })()`);
    await b.goto(APP + '/');
    await connect();
    await waitFor(`!!document.querySelector('dialog.dialog--sm[open]') && /Restore your workbook from the backup of/.test(document.querySelector('dialog.dialog--sm[open]').textContent)`, 'restore offer', 8000);
    await ev(`[...document.querySelector('dialog.dialog--sm[open]').querySelectorAll('button')].find((y) => y.textContent.trim() === 'Restore').click()`);
    await waitFor(`[...document.querySelectorAll('.entity__table')].some((x) => x.textContent === 'orders') && [...document.querySelectorAll('.entity__table')].some((x) => x.textContent === 'customers')`, 'both tables restored', 8000);
  });

  await check('after the site data is cleared (folder link gone): no offer, but Settings → choose the folder lists the backups and Restore opens one', async () => {
    await ev(`(async () => { localStorage.clear(); await new Promise((res) => { const r = indexedDB.deleteDatabase('dashboardbuilder'); r.onsuccess = r.onerror = r.onblocked = () => res(); }); return true; })()`);
    await b.goto(APP + '/');
    await connect();
    await b.sleep(800);
    must(!(await ev(`!!document.querySelector('dialog.dialog--sm[open]')`)), 'an offer appeared with no folder known');
    must(await ev(`document.querySelectorAll('.entity').length === 0`), 'the canvas is not empty');
    await openSettings('settings-dock-btn');
    must(/None chosen/.test(await dialogText()), 'folder still known');
    const was = await mine();
    must(await press('Choose folder…'), 'no Choose folder');
    await waitFor(`document.querySelectorAll('dialog.backup-dialog .backup-pick input').length === 5`, 'the 5 backups listed', 8000);
    await b.sleep(1200);
    must(J(await mine()) === J(was), `an empty workbook wrote a backup: ${J(was)} -> ${J(await mine())}`); // choosing a folder on an empty canvas writes nothing
    must(/Backups for default@mock-ch/.test(await dialogText()), 'list heading');
    must(await press('Restore'), 'no Restore');
    await waitFor(`!document.querySelector('dialog.backup-dialog')`, 'dialog closed');
    await waitFor(`document.querySelectorAll('.entity').length === 2`, 'the workbook is back', 8000);
  });

  await check('a browser with no folder picker: the dialog says why and its controls are off', async () => {
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.showDirectoryPicker = undefined;` }); // runs after the picker stub above
    await b.goto(APP + '/');
    await connect();
    await openSettings('settings-dock-btn');
    const s = await ev(`(() => ({ text: document.querySelector('dialog.backup-dialog').textContent, choose: document.getElementById('backup-choose').disabled, now: document.getElementById('backup-now').disabled, toggle: document.getElementById('backup-toggle').hidden }))()`);
    must(/Chrome or Edge/.test(s.text) && s.choose && s.now && s.toggle, J(s));
    await closeSettings();
  });
} catch (e) {
  console.log(`FAIL setup: ${e.stack ?? e.message}`); failed++;
} finally {
  await b?.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
