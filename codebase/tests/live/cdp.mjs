// Minimal Chrome DevTools Protocol driver (no playwright-core on this host): launches headless Chromium,
// opens one page, answers /api/* through Fetch interception, and offers evaluate / waitFor / screenshot.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const root = join(homedir(), '.cache/ms-playwright');
  if (!existsSync(root)) throw new Error(`no Playwright browser cache at ${root} (install Chromium, or set CHROME_BIN)`);
  for (const dir of readdirSync(root).sort().reverse()) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-headless-shell-linux64/headless_shell', 'chrome-linux/chrome']) {
      const p = join(root, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  throw new Error('no Chromium under ~/.cache/ms-playwright (set CHROME_BIN)');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((res, rej) => { const srv = createServer(); srv.on('error', rej); srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)); }); });

export async function launch({ port, width = 1400, height = 900 } = {}) {
  port ??= await freePort();
  const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'calc-ui-'));
  let proc = null;
  const onSignal = (sig) => () => { cleanup(); process.exit(128 + (sig === 'SIGINT' ? 2 : 15)); };
  const handlers = { SIGINT: onSignal('SIGINT'), SIGTERM: onSignal('SIGTERM') };
  const cleanup = () => {
    for (const [sig, fn] of Object.entries(handlers)) process.off(sig, fn);
    process.off('exit', cleanup);
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(profile, { recursive: true, force: true });
  };
  // a killed or interrupted script never reaches its `finally`; without these the profile outlives it
  for (const [sig, fn] of Object.entries(handlers)) process.on(sig, fn);
  process.on('exit', cleanup);
  try {
  proc = spawn(findChrome(), [
    '--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore', detached: true }); // own process group, so close() can kill every helper process
  let spawnError = null;
  proc.on('error', (e) => { spawnError = e; });
  let version = null;
  for (let i = 0; i < 100 && !version; i++) {
    if (spawnError) break;
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(100); }
  }
  if (!version) throw new Error(`Chromium did not start${spawnError ? `: ${spawnError.message}` : ''}`);
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket failed')); });

  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? rej(new Error(`${msg.error.message}`)) : res(msg.result);
    } else if (msg.method) for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const on = (ev, fn) => { (listeners.get(ev) ?? listeners.set(ev, []).get(ev)).push(fn); };

  const consoleErrors = [];
  on('Runtime.exceptionThrown', (p) => consoleErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
  on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push('console.error: ' + (p.args ?? []).map((x) => x.value ?? x.description ?? '').join(' ')); });
  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const api = {
    send, on, consoleErrors,
    async evaluate(expression) {
      // D139: the page imports its modules from /features/v-<id>/…, so a test's import('/features/…') would load a second copy of each module (its own empty store).
      // Point such imports at the page's own prefix.
      if (/['"`]\/features\//.test(expression)) {
        const pre = (await send('Runtime.evaluate', { returnByValue: true, expression: `(() => { for (const e of document.querySelectorAll('script[src], link[href]')) { const m = /^(.*\\/features\\/v-[0-9a-f]{12})\\//.exec(new URL(e.src || e.href, location.href).pathname); if (m) return m[1]; } return ''; })()` })).result.value;
        if (pre) expression = expression.replace(/(['"`])\/features\//g, `$1${pre}/`);
      }
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n  in: ${expression.slice(0, 200)}`);
      return r.result.value;
    },
    async waitFor(expression, { timeout = 8000, label = expression } = {}) {
      const t0 = Date.now();
      for (;;) {
        let v = false;
        try { v = await api.evaluate(expression); } catch { /* page navigating */ }
        if (v) return v;
        if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for: ${label}`);
        await sleep(50);
      }
    },
    sleep,
    async goto(url) { await send('Page.navigate', { url }); await sleep(100); await api.waitFor("document.readyState === 'complete'"); },
    async screenshot(path, clip) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      (await import('node:fs')).writeFileSync(path, Buffer.from(data, 'base64'));
    },
    /** Light or dark, the way a viewer picks it (the app ignores the OS setting): stored for pages that load next, and applied now through the Appearance card's own rows. */
    async setScheme(scheme) {
      const store = `try { localStorage.setItem('dashboardbuilder.scheme', ${JSON.stringify(scheme)}); } catch (e) { /* about:blank */ }`;
      await send('Page.addScriptToEvaluateOnNewDocument', { source: store });
      await send('Runtime.evaluate', { expression: `(() => { ${store} document.querySelector('[data-scheme-pref=${scheme}]')?.click(); return true; })()` });
    },
    async click(x, y) {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    },
    async key(key, { code = key, vk } = {}) {
      const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    async type(text) { await send('Input.insertText', { text }); },
    /** Answer /api/* with `handler({method, path, body})` -> { status?, json?, text?, headers? }. */
    async mock(handler) {
      await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
      on('Fetch.requestPaused', async (p) => {
        const u = new URL(p.request.url);
        let body = null;
        try { body = p.request.postData ? JSON.parse(p.request.postData) : null; } catch { body = p.request.postData; }
        let out;
        try { out = await handler({ method: p.request.method, path: u.pathname, search: u.search, body }); } catch (e) { out = { status: 500, json: { error: String(e) } }; }
        out ??= { status: 404, json: { error: `unmocked ${u.pathname}` } };
        const text = out.text ?? JSON.stringify(out.json ?? null);
        await send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: out.status ?? 200,
          responseHeaders: [{ name: 'Content-Type', value: out.text !== undefined ? 'text/plain' : 'application/json' }, ...(out.headers ?? [])],
          body: Buffer.from(text).toString('base64'),
        }).catch(() => {});
      });
    },
    /** Close the browser. Any uncaught exception / unhandled rejection / console.error seen on the page fails the check
     *  (printed as `FAIL page errors: ...`, which run-ui-all.mjs counts); set ALLOW_PAGE_ERRORS=1 to only list them. */
    async close() {
      try { ws.close(); } catch {} cleanup(); await sleep(100);
      if (consoleErrors.length) {
        const uniq = [...new Set(consoleErrors.map((e) => String(e).split('\n')[0]))];
        console.log(`${process.env.ALLOW_PAGE_ERRORS ? 'warn' : 'FAIL'} page errors (${consoleErrors.length}): ${uniq.slice(0, 5).join(' | ')}`);
        if (!process.env.ALLOW_PAGE_ERRORS) process.exitCode = 1;
      }
    },
  };
  return api;
  } catch (e) { cleanup(); throw e; } // a failed start must not leave Chromium or its profile behind
}
