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
const port = Number(process.env.UI_PORT ?? 5193);
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const files = readdirSync(here).filter((f) => f.endsWith('-ui.mjs') && (!only || only.includes(f.replace('-ui.mjs', '')))).sort();
const fuser = (args) => {
  const r = spawnSync('fuser', args, { stdio: 'ignore' });
  if (r.error) { console.error(`run-ui-all: cannot run fuser (${r.error.code ?? r.error.message}) — install psmisc; refusing to continue`); process.exit(2); }
  return r.status;
};
const stop = () => fuser(['-k', `${port}/tcp`]);

// Never kill an unrelated listener: only a previous dev run of THIS app (a DashboardBuilder page) may be on the port.
if (fuser([`${port}/tcp`]) === 0) {
  let ours = false;
  try { ours = /Dashboard Builder|ws-chart|dashboard-view/.test(await (await fetch(`http://localhost:${port}/`)).text()); } catch { /* not HTTP */ }
  if (!ours) { console.error(`run-ui-all: port ${port} has an unrelated listener; set UI_PORT to a free port`); process.exit(2); }
  stop();
}
const app = spawn('dotnet', ['run', '--no-launch-profile', '--urls', `http://localhost:${port}`], {
  cwd: join(root, 'src', 'DashboardBuilder'), stdio: 'ignore', detached: true });
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
  stop();
  try { process.kill(-app.pid, 'SIGTERM'); } catch { /* gone */ }
}
let bad = !up;
for (const r of rows) {
  const good = r.status === 0 && r.fail === 0 && r.ok > 0;
  if (!good) bad = true;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${r.name.padEnd(20)} ok=${r.ok} fail=${r.fail} exit=${r.status}`);
}
console.log(`total ok=${rows.reduce((a, r) => a + r.ok, 0)} fail=${rows.reduce((a, r) => a + r.fail, 0)}`);
process.exit(bad ? 1 : 0);
