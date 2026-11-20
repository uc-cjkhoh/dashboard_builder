// Rendered design probe for a component that is already on screen (the app's CDP harness, tests/live/cdp.mjs, drives it there).
// Measures what a reviewer would eyeball: near-miss alignment (siblings and nested items), off-scale gaps and uneven rhythm, colours that are
// not design tokens in the active scheme, text contrast, type and radius scale, clipped / truncated text, tiny hit targets.
// Run it per scheme: the tokens are resolved with getComputedStyle, so a colour that only matches in light shows up in dark.
//
//   import { designProbe, formatProbe } from './design-probe.mjs';
//   const r = await designProbe(ev, '.key-pairs', { sleep: b.sleep });          // schemes: light, dark (+ onedark look)
//   console.log(formatProbe(r));
//
// `ev` is the harness's evaluate(expression). Findings are evidence for a review, not a verdict: tolerances are in PROBE below.
export const PROBE = { edgeNear: [0.5, 3], gapScale: [0, 1, 2, 4, 8, 16, 24], font: [14, 16, 24, 32], colorTol: 2, alphaTol: 0.03, minHit: 24 };

const inPage = (sel, cfg) => {
  const P = cfg;
  const roots = [...document.querySelectorAll(sel)].filter((r) => r.getClientRects().length);
  const findings = [];
  const info = { roots: roots.length, elements: 0, truncated: [] };
  if (!roots.length) return { findings: [{ rule: 'probe', msg: `no visible element matches ${sel}` }], info };
  const num = (v) => parseFloat(v) || 0;
  const desc = (el) => {
    const c = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${c ? '.' + c : ''}`;
  };
  const parse = (s) => { const x = s.match(/color\(srgb ([^)]+)\)/); if (x) { const q = x[1].split(/[ /]+/).filter(Boolean).map(Number); return [q[0] * 255, q[1] * 255, q[2] * 255, q.length > 3 ? q[3] : 1]; } /* a color-mix() value computes as color(srgb 0-1 …) */ const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  // 1. the scheme's token palette: every :root custom property that resolves as a colour
  const names = new Set();
  for (const sh of document.styleSheets) { let rs; try { rs = sh.cssRules; } catch { continue; } const walk = (list) => { for (const r of list) { if (r.cssRules && !r.selectorText) walk(r.cssRules); else if (r.selectorText && /:root|html/.test(r.selectorText)) for (const n of r.style) if (n.startsWith('--')) names.add(n); } }; walk(rs); }
  const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:-9999px;color:rgb(1,2,3)'; document.body.append(holder);
  const palette = [];
  for (const n of names) { const s = document.createElement('span'); s.style.color = `var(${n})`; holder.append(s); const c = parse(getComputedStyle(s).color); if (c && !(c[0] === 1 && c[1] === 2 && c[2] === 3)) palette.push({ n, c }); }
  holder.remove();
  for (const base of [[255, 255, 255, 1], [0, 0, 0, 1]]) palette.push({ n: 'white/black', c: base });
  const isToken = (c) => palette.some((p) => Math.abs(p.c[0] - c[0]) <= P.colorTol && Math.abs(p.c[1] - c[1]) <= P.colorTol && Math.abs(p.c[2] - c[2]) <= P.colorTol && Math.abs(p.c[3] - c[3]) <= P.alphaTol);
  const lum = (c) => { const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1); };
  const backdrop = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) { const bg = parse(getComputedStyle(e).backgroundColor); if (bg && bg[3] > 0) { chain.push(bg); if (bg[3] >= .99) break; } } let c = [255, 255, 255, 1]; for (const bg of chain.reverse()) c = over(bg, c); return c; };
  const all = [];
  for (const r of roots) { all.push(r, ...r.querySelectorAll('*')); }
  const els = [...new Set(all)].filter((e) => e.getClientRects().length && !['SCRIPT', 'STYLE', 'OPTION', 'selectedcontent'].includes(e.tagName) && getComputedStyle(e).visibility !== 'hidden');
  info.elements = els.length;
  const seen = new Set();
  const add = (rule, msg, el) => { const k = rule + '|' + msg; if (seen.has(k)) return; seen.add(k); findings.push({ rule, msg, el: desc(el) }); };

  for (const el of els) {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    // 2. colour: foreground, fill and edge must be tokens
    const checks = [['color', cs.color, el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())], ['background', cs.backgroundColor, true],
      ['border', cs.borderTopColor, num(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none']];
    if (el instanceof SVGElement) { checks.push(['fill', cs.fill, cs.fill !== 'none'], ['stroke', cs.stroke, cs.stroke !== 'none']); }
    for (const [prop, val, used] of checks) { if (!used) continue; const c = parse(val); if (c && c[3] > 0 && !isToken(c)) add('colour', `${prop} ${val} on <${desc(el)}> is not a design token in this scheme`, el); }
    // 3. text contrast against what is really behind it
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasText && !el.matches(':disabled,[aria-disabled=true]') && +cs.opacity === 1) {
      const fg = parse(cs.color), bg = backdrop(el); if (fg) { const f = over(fg, bg); const L1 = lum(f), L2 = lum(bg); const ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05);
        const fs = num(cs.fontSize), bold = num(cs.fontWeight) >= 700; const need = fs >= 24 || (fs >= 18.66 && bold) ? 3 : 4.5;
        if (ratio < need) add('contrast', `text on <${desc(el)}> is ${ratio.toFixed(2)}:1 (needs ${need}:1)`, el); }
      // 5. type scale
      const fs = num(cs.fontSize); if (!P.font.includes(Math.round(fs))) add('type', `font-size ${fs}px on <${desc(el)}> (scale: ${P.font.join(' / ')})`, el);
    }
    // 5. one radius
    if ((cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || num(cs.borderTopWidth)) && r.width > 0) {
      for (const c of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']) { const v = cs[c]; const px = num(v); if (px && px !== 8 && px < 500 && !v.includes('%')) { add('radius', `radius ${v} on <${desc(el)}> (one radius: 8px, pills 999px, 50%)`, el); break; } }
    }
    // 7. clipped / truncated text, hit targets
    if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible' && el.clientWidth > 0) { const ell = cs.textOverflow === 'ellipsis'; if (ell) info.truncated.push(`${desc(el)}: "${(el.textContent || '').trim().slice(0, 40)}"`); else if (cs.overflowX === 'hidden') add('overflow', `<${desc(el)}> clips content without an ellipsis (${el.scrollWidth}px in ${el.clientWidth}px)`, el); }
    if (el.matches('button,a[href],input:not([type=hidden]),select,[role=button],summary') && !el.closest('[hidden]')) { const hit = (el.closest('label') ?? el).getBoundingClientRect(); /* a wrapping label is the target */ if (hit.height < P.minHit || hit.width < P.minHit) add('target', `<${desc(el)}> is ${Math.round(hit.width)}x${Math.round(hit.height)}px, under the ${P.minHit}px minimum hit target`, el); }
    // 4. alignment and rhythm among the element's children
    const kids = [...el.children].filter((k) => k.getClientRects().length && getComputedStyle(k).position !== 'absolute' && getComputedStyle(k).position !== 'fixed');
    if (el instanceof SVGElement) continue; // icon internals are drawn, not laid out
    if (kids.length >= 1) {
      const pl = r.left + num(cs.borderLeftWidth) + num(cs.paddingLeft);
      for (const k of kids) { const kr = k.getBoundingClientRect(); const d = Math.abs(kr.left - pl); if (d > P.edgeNear[0] && d <= P.edgeNear[1] && !(cs.display.includes('flex') && cs.justifyContent === 'center')) add('align', `<${desc(k)}> starts ${d.toFixed(1)}px off the content edge of its parent <${desc(el)}> (nested misalignment)`, k); }
    }
    if (kids.length >= 2) {
      const rects = kids.map((k) => [k, k.getBoundingClientRect()]);
      const rows = []; for (const it of rects) { const row = rows.find((g) => it[1].top < g[0][1].bottom - 1 && it[1].bottom > g[0][1].top + 1); if (row) row.push(it); else rows.push([it]); }
      for (const row of rows) if (row.length >= 2) { // siblings sharing a line: centre, top or bottom must agree; a 0.5-3px miss is the tell
        const axes = [['centre', (b) => (b.top + b.bottom) / 2], ['top', (b) => b.top], ['bottom', (b) => b.bottom]];
        const spread = axes.map(([n, f]) => { const v = row.map((it) => f(it[1])); return [n, Math.max(...v) - Math.min(...v)]; });
        if (!spread.some(([, s]) => s <= .5)) { const best = Math.min(...spread.map(([, s]) => s)); if (best <= P.edgeNear[1]) add('align', `siblings on one line in <${desc(el)}> miss a shared centre/top/bottom by ${best.toFixed(1)}px`, row[0][0]); } }
      if (rows.length === kids.length) { // a column of siblings: left edges and gaps
        const lefts = rects.map(([, b]) => b.left); for (let i = 0; i < lefts.length; i++) for (let j = i + 1; j < lefts.length; j++) { const d = Math.abs(lefts[i] - lefts[j]); if (d > P.edgeNear[0] && d <= P.edgeNear[1]) add('align', `<${desc(rects[i][0])}> and <${desc(rects[j][0])}> stack ${d.toFixed(1)}px off a shared left edge`, rects[i][0]); }
        const gaps = []; for (let i = 1; i < rects.length; i++) gaps.push(rects[i][1].top - rects[i - 1][1].bottom);
        for (const g of gaps) if (g > 0.5 && !P.gapScale.some((s) => Math.abs(s - g) <= .6)) add('gap', `${g.toFixed(1)}px gap between children of <${desc(el)}> (scale: 4 / 8 / 16 / 24)`, el);
        const real = gaps.filter((g) => g > .5); if (real.length >= 3 && Math.max(...real) - Math.min(...real) > .6 && !/space-/.test(cs.justifyContent)) add('rhythm', `uneven spacing between children of <${desc(el)}>: ${real.map((g) => g.toFixed(0)).join(' / ')}px`, el);
      } else if (/flex|grid/.test(cs.display) && rows.every((row) => row.length === 1) === false) { // rows of siblings (laid out, not flowing text): the gaps between rows, then the gaps along each row
        for (let i = 1; i < rows.length; i++) { const g = Math.min(...rows[i].map((it) => it[1].top)) - Math.max(...rows[i - 1].map((it) => it[1].bottom)); if (g > .5 && !P.gapScale.some((v) => Math.abs(v - g) <= .6)) add('gap', `${g.toFixed(1)}px between rows inside <${desc(el)}> (scale: 4 / 8 / 16 / 24)`, el); }
        for (const row of rows) { const s = row.map((it) => it[1]).sort((a, b) => a.left - b.left); for (let i = 1; i < s.length; i++) { const g = s[i].left - s[i - 1].right; if (g > .5 && !P.gapScale.some((v) => Math.abs(v - g) <= .6) && !/space-|center|end/.test(cs.justifyContent) && !/auto/.test(getComputedStyle(row[i]?.[0] ?? el).marginLeft)) add('gap', `${g.toFixed(1)}px between siblings on one line in <${desc(el)}> (scale: 4 / 8 / 16 / 24)`, el); } }
      }
    }
  }
  // 6. does the component leave the window (the open lists / dialogs it spawns are checked separately by the caller)
  for (const r of roots) { const b = r.getBoundingClientRect(); if (b.right > innerWidth + 1 || b.left < -1) add('overflow', `<${desc(r)}> extends outside the viewport (${Math.round(b.left)}..${Math.round(b.right)} of ${innerWidth})`, r); }
  return { findings, info };
};

/** Run the probe for `selector` under each scheme and merge: a finding keeps the list of schemes it appears in. */
export async function designProbe(ev, selector, { schemes = ['light', 'dark', 'onedark'], sleep = (ms) => new Promise((r) => setTimeout(r, ms)), settle = 450 } = {}) {
  const prior = await ev(`JSON.stringify([document.documentElement.dataset.scheme ?? null, document.documentElement.dataset.look ?? null])`);
  const merged = new Map(); const info = {};
  try {
    for (const s of schemes) {
      await ev(`(() => { const d = document.documentElement.dataset; if (${JSON.stringify(s)} === 'light') { delete d.scheme; delete d.look; } else if (${JSON.stringify(s)} === 'dark') { d.scheme = 'dark'; delete d.look; } else { d.scheme = 'dark'; d.look = ${JSON.stringify(s)}; } return true; })()`);
      await sleep(settle); // token transitions finish before the colours are read
      const out = await ev(`(${inPage.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(PROBE)})`);
      info[s] = out.info;
      for (const f of out.findings) { const k = f.rule + '|' + f.msg; const e = merged.get(k) ?? { ...f, schemes: [] }; e.schemes.push(s); merged.set(k, e); }
    }
  } finally {
    const [sc, lk] = JSON.parse(prior);
    await ev(`(() => { const d = document.documentElement.dataset; ${sc ? `d.scheme = ${JSON.stringify(sc)};` : 'delete d.scheme;'} ${lk ? `d.look = ${JSON.stringify(lk)};` : 'delete d.look;'} return true; })()`);
  }
  return { selector, schemes, findings: [...merged.values()], info };
}

/** Plain-text report: findings grouped by rule, the schemes each one shows in, then the truncated (ellipsised) text. */
export function formatProbe(r) {
  const lines = [`design probe ${r.selector}  (${r.schemes.join(', ')})`];
  const by = {}; for (const f of r.findings) (by[f.rule] ??= []).push(f);
  if (!r.findings.length) lines.push('  no findings');
  for (const [rule, list] of Object.entries(by)) { lines.push(`  ${rule} (${list.length})`); for (const f of list) lines.push(`    - ${f.msg}${f.schemes.length < r.schemes.length ? `  [only: ${f.schemes.join(', ')}]` : ''}`); }
  const tr = new Set(Object.values(r.info).flatMap((i) => i.truncated ?? [])); if (tr.size) { lines.push(`  truncated with an ellipsis (${tr.size}): check the full text is reachable (title / tooltip / wider container)`); for (const t of tr) lines.push(`    · ${t}`); }
  return lines.join('\n');
}
