// Runs every browser check (tests/live/*-ui.mjs) against ONE dev app and prints a per-check summary.
//   node tests/live/run-ui-all.mjs            (env: UI_PORT, default 5193; ONLY=calc,rows to filter)
// Starts `dotnet run` from src/DashboardBuilder on UI_PORT, runs each check with APP_URL pointing at it,
// stops the app by port (never by process name), and exits non-zero if any check failed or crashed.
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
let port = process.env.UI_PORT ? Number(process.env.UI_PORT) : null;
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const files = readdirSync(here).filter((f) => f.endsWith('-ui.mjs') && (!only || only.includes(f.replace('-ui.mjs', '')))).sort();
import { createServer } from 'node:net';
// Never touch a listener this script did not start: UI_PORT unset -> a free port is picked; UI_PORT set and busy -> refuse.
const freePort = () => new Promise((res, rej) => { const srv = createServer(); srv.on('error', rej); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); }); });
const busy = (p) => new Promise((res) => { const srv = createServer(); srv.on('error', () => res(true)); srv.listen(p, '127.0.0.1', () => srv.close(() => res(false))); });
if (port === null) port = await freePort();
if (process.env.UI_PORT) { if (await busy(port)) { console.error(`run-ui-all: port ${port} busy (another run?)`); process.exit(2); } }
const app = spawn('dotnet', ['run', '--no-launch-profile', '--urls', `http://localhost:${port}`], {
  cwd: join(root, 'src', 'DashboardBuilder'), stdio: 'ignore', detached: true });
const killApp = () => { try { process.kill(-app.pid, 'SIGTERM'); } catch { /* gone */ } }; // only the process group this script spawned
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killApp(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); killApp(); process.exit(1); });
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try { up = (await fetch(`http://localhost:${port}/`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); }
}
const rows = [];
try {
  if (!up) throw new Error(`dev app did not start on ${port}`);
  for (const f of files) {
    const r = spawnSync(process.execPath, [join(here, f)], { env: { ...process.env, APP_URL: `http://localhost:${port}` }, encoding: 'utf8', timeout: 300000 });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    const ok = (out.match(/^ok /gm) ?? []).length, fail = (out.match(/^FAIL /gm) ?? []).length;
    rows.push({ name: f, ok, fail, status: r.status });
    if (fail || r.status !== 0) console.log(out.split('\n').filter((l) => /^FAIL|rror/.test(l)).join('\n'));
  }
} finally {
  killApp();
}
let bad = !up;
for (const r of rows) {
  const good = r.status === 0 && r.fail === 0 && r.ok > 0;
  if (!good) bad = true;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${r.name.padEnd(20)} ok=${r.ok} fail=${r.fail} exit=${r.status}`);
}
console.log(`total ok=${rows.reduce((a, r) => a + r.ok, 0)} fail=${rows.reduce((a, r) => a + r.fail, 0)}`);
process.exit(bad ? 1 : 0);
