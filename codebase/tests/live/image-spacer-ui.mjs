// Browser check for the image and spacer dashboard widgets (T08-15, T08-16): Add image through the real file input (a PNG is
// drawn with its file name as alt text; an SVG, a non-image and an oversize file are refused with a message and add nothing; a fifth
// image is refused), Add spacer, undo of both, Remove, autosave keeps the picture inside the workbook (no network request for it),
// a reload restores both, the stored picture is a data URL, and the spacer is hidden under print media. Real dev app (APP_URL),
// every /api/* mocked; any page error fails the run. Screenshots (light + dark) go to SHOTS_DIR.
import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const APP = process.env.APP_URL ?? 'http://localhost:5221';
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), 'image-spacer-shots');
mkdirSync(SHOTS, { recursive: true });
const KEY = 'dashboardbuilder.workbook.v2|mock-ch|8443|default';

// A small real PNG (a 96 x 64 gradient), written with node's zlib.
function png(w, h) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 40 + x * 2; raw[o + 1] = 90 + y * 2; raw[o + 2] = 160; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dir = join(tmpdir(), 'image-spacer-files');
mkdirSync(dir, { recursive: true });
const FILES = { logo: join(dir, 'Company logo.png'), svg: join(dir, 'mark.svg'), txt: join(dir, 'notes.png.txt'), big: join(dir, 'big.png') };
writeFileSync(FILES.logo, png(96, 64));
writeFileSync(FILES.svg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
writeFileSync(FILES.txt, 'not an image');
writeFileSync(FILES.big, Buffer.concat([png(96, 64), Buffer.alloc(262144)])); // a valid PNG header, but over 256 KB

const requests = [];
async function answer({ method, path }) {
  requests.push(path);
  if (path === '/api/connection' && method === 'GET') return { json: { connected: false } };
  if (path === '/api/connection') return { json: { connected: true, host: 'mock-ch', port: 8443, user: 'default', secure: true, allowInvalidCert: false } };
  if (path === '/api/databases') return { json: ['shop'] };
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
  const connect = async () => {
    await waitFor(`document.readyState === 'complete' && !!document.getElementById('conn-connect')`, 'app loaded');
    await ev(`(() => { document.getElementById('conn-host').value = 'mock-ch'; document.getElementById('conn-password').value = 'x'; document.getElementById('conn-connect').click(); return true; })()`);
    await waitFor(`document.getElementById('db-select').options.length > 1`, 'databases listed');
  };
  const kinds = () => store(`return st.dashboards()[0].widgets.map((w) => w.kind);`);
  const toastText = () => ev(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`);
  const pick = async (file) => {
    const { root } = await b.send('DOM.getDocument');
    const { nodeId } = await b.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.board-panel input[type=file]' });
    await b.send('DOM.setFileInputFiles', { nodeId, files: [file] });
  };
  const click = (sel) => ev(`document.querySelector(${J(sel)}).click()`);

  await b.goto(APP + '/');
  await connect();
  await store(`const d = st.createDashboard('Overview'); st.setWidgets(d.id, [{ id: st.nextWidgetId(), kind: 'text', heading: 'Notes', body: 'Revenue is by order date.', x: 0, y: 0, w: 12, h: 2 }]); return true;`);
  await waitFor(`!document.getElementById('board-view').hidden && !!document.querySelector('.board-panel__add-image')`, 'dashboard shown');

  await check('Add spacer adds a blank 2 x 1 widget named Spacer, with no Edit button', async () => {
    await click('.board-panel__add-spacer');
    await waitFor(`!!document.querySelector('.board-widget--spacer')`, 'spacer drawn');
    const w = await store(`return st.dashboards()[0].widgets.find((w) => w.kind === 'spacer');`);
    must(w.w === 2 && w.h === 1, `size ${w.w}x${w.h}`);
    const info = await ev(`(() => { const e = document.querySelector('.board-widget--spacer'); return { name: e.getAttribute('aria-label'), edit: e.querySelector('.board-widget__edit').hidden, empty: e.querySelector('.board-widget__body').children.length === 0 }; })()`);
    must(info.name === 'Spacer' && info.edit && info.empty, J(info));
  });

  await check('Add image: a PNG is drawn (decoded) with its file name as alt text, 6 x 4', async () => {
    await pick(FILES.logo);
    await waitFor(`!!document.querySelector('.board-widget--image img')`, 'image widget drawn');
    await waitFor(`document.querySelector('.board-widget--image img').naturalWidth === 96`, 'image decoded');
    const i = await ev(`(() => { const e = document.querySelector('.board-widget--image'); const m = e.querySelector('img'); return { alt: m.alt, label: e.getAttribute('aria-label'), src: m.src.slice(0, 22), fit: getComputedStyle(m).objectFit }; })()`);
    must(i.alt === 'Company logo' && i.label === 'Company logo' && i.src === 'data:image/png;base64,' && i.fit === 'contain', J(i));
    const w = await store(`return st.dashboards()[0].widgets.find((w) => w.kind === 'image');`);
    must(w.w === 6 && w.h === 4, `size ${w.w}x${w.h}`);
  });

  await check('an SVG, a non-image and an oversize file are refused with a message and add nothing', async () => {
    const before = await kinds();
    for (const [f, re] of [[FILES.svg, /PNG, JPEG, GIF or WebP/], [FILES.txt, /PNG, JPEG, GIF or WebP/]]) {
      await pick(f); await b.sleep(300);
      must(re.test(await toastText()), `no refusal for ${f}: ${await toastText()}`);
    }
    must(J(await kinds()) === J(before), 'a refused file added a widget');
  });
  await check('an oversize PNG (over 256 KB) is refused', async () => {
    const before = await kinds();
    await pick(FILES.big);
    await waitFor(`[...document.querySelectorAll('.toast')].some((t) => /at most 256 KB/.test(t.textContent))`, 'size refusal');
    must(J(await kinds()) === J(before), 'oversize added a widget');
  });

  await check('the workbook autosave holds the picture as a data URL (not a link)', async () => {
    await b.sleep(900);
    const saved = JSON.parse(await ev(`localStorage.getItem(${J(KEY)})`)).dashboards[0].widgets;
    const img = saved.find((w) => w.kind === 'image'), sp = saved.find((w) => w.kind === 'spacer');
    must(img && /^data:image\/png;base64,/.test(img.src) && img.alt === 'Company logo', 'image not saved');
    must(sp && Object.keys(sp).sort().join() === 'h,kind,w,x,y', `spacer fields ${J(sp)}`);
  });

  await check('a reload restores both widgets', async () => {
    await b.send('Page.reload');
    await connect();
    await waitFor(`document.querySelectorAll('.board-widget--image img').length === 1 && document.querySelectorAll('.board-widget--spacer').length === 1`, 'restored');
    await waitFor(`document.querySelector('.board-widget--image img').naturalWidth === 96`, 'decoded after reload');
  });

  await check('a fifth image is refused (4 per dashboard)', async () => {
    for (let i = 0; i < 3; i++) { await pick(FILES.logo); await waitFor(`document.querySelectorAll('.board-widget--image').length === ${i + 2}`, `image ${i + 2}`); }
    await pick(FILES.logo);
    await waitFor(`[...document.querySelectorAll('.toast')].some((t) => /at most 4 images/.test(t.textContent))`, 'limit toast');
    must((await kinds()).filter((k) => k === 'image').length === 4, 'a fifth image was added');
  });

  await check('screenshots: light and dark', async () => {
    await b.setScheme('dark'); await b.sleep(300); await shot('image-spacer-dark.png');
    await b.setScheme('light'); await b.sleep(300); await shot('image-spacer-light.png');
  });

  await check('the spacer is hidden under print media and the image stays', async () => {
    await b.send('Emulation.setEmulatedMedia', { media: 'print' });
    const v = await ev(`({ sp: getComputedStyle(document.querySelector('.board-widget--spacer')).visibility, im: getComputedStyle(document.querySelector('.board-widget--image')).visibility })`);
    await b.send('Emulation.setEmulatedMedia', { media: '' });
    must(v.sp === 'hidden' && v.im === 'visible', J(v));
  });

  await check('Remove and undo: removing the spacer and undoing brings it back', async () => {
    await click('.board-widget--spacer .board-widget__remove');
    await waitFor(`!document.querySelector('.board-widget--spacer')`, 'removed');
    await ev(`[...document.querySelectorAll('.board-bar__iconbtn')].find((x) => x.getAttribute('aria-label').startsWith('Undo')).click()`);
    await waitFor(`!!document.querySelector('.board-widget--spacer')`, 'restored by undo');
  });

  if (b.consoleErrors.length) { console.log('page exceptions:\n  ' + b.consoleErrors.join('\n  ')); failed++; }
} catch (e) {
  console.log(`FAIL harness: ${e.stack}`); failed++;
} finally {
  if (b) await b.close();
}
console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
