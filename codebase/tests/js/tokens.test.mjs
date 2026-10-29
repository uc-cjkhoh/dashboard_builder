import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
const root = new URL("../../src/DashboardBuilder/Features/", import.meta.url);
const css = readdirSync(root, { recursive: true }).filter((f) => f.endsWith(".css")).map((f) => [f, readFileSync(new URL(f, root), "utf8")]);
const RETIRED = /var\(--(brand|side-|pend-|info-|glow|hi\)|surface-grad|head-grad|motion|ease-back|elev-1\)|elev-3\)|shadow\)|r-sm\)|danger-soft)/;
test("no retired token is referenced", () => { for (const [f, t] of css) assert.doesNotMatch(t, RETIRED, f); });
test("no hex colour outside the :root token blocks", () => {
  for (const [f, t] of css) {
    const outside = t.replace(/:root[^{]*\{[^}]*\}/g, "");
    assert.doesNotMatch(outside, /#[0-9a-fA-F]{3,8}\b/, f);
  }
});
test("dark mode redefines the surfaces", () => {
  const core = css.find(([f]) => f.endsWith("core.css"))[1];
  assert.match(core, /:root\[data-scheme="dark"\]\s*\{[^}]*--surface:/);
});
// The in-app light/dark toggle sets data-scheme (Core/scheme.js); a stylesheet asking the OS directly
// would ignore the user's choice.
test("no stylesheet reads prefers-color-scheme (data-scheme is the one switch)", () => {
  for (const [f, t] of css) assert.doesNotMatch(t, /prefers-color-scheme/, f);
});

// :root[data-scheme="dark"] outweighs a bare :root, so the opaque-glass fallbacks must match it too.
test("the opaque-glass fallbacks apply in the dark scheme as well", () => {
  const core = css.find(([f]) => f.endsWith("core.css"))[1];
  const fallbacks = [...core.matchAll(/@(?:supports not|media \(prefers-reduced-transparency)[^{]*\{\s*([^{]+)\{[^}]*--glass:/g)];
  assert.equal(fallbacks.length, 2);
  for (const [, sel] of fallbacks) assert.match(sel, /:root\[data-scheme\]/);
});

// Glass only on chrome with nothing but the wash beneath it; anything floating over content is solid,
// otherwise blurred text behind it reads through the text on top.
test("menus, popovers, toasts and dialogs are never glass", () => {
  const all = css.map(([, t]) => t).join("\n");
  for (const sel of [".menu__list", ".toast", ".dialog"]) {
    const rules = [...all.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, s]) => s.split(",").some((x) => x.trim().startsWith(sel)));
    for (const [, s, body] of rules) assert.doesNotMatch(body, /var\(--glass\)|backdrop-filter/, `${s.trim()} must be solid`);
  }
  const markup = ["Workbook/_Workbook.cshtml", "Shell/Index.cshtml"].map((f) => readFileSync(new URL(f, root), "utf8")).join("\n");
  assert.doesNotMatch(markup, /class="(menu__list|toast|dialog)[^"]*\bglass\b/);
});

test("the multi-layer body background keeps its colour layer valid (wash and base set apart)", () => {
  const core = css.find(([f]) => f.endsWith("core.css"))[1];
  assert.match(core, /body \{[^}]*background-color: var\(--bg\);[^}]*background-image: var\(--wash\)/);
});

// Design rules (CLAUDE.md): one radius, a 4/8/16/24 space scale, 14/16 body and 24/32 title sizes,
// saturation capped near 70%.
const coreCss = css.find(([f]) => f.endsWith("core.css"))[1];
test("space, type and radius tokens are the short fixed scales", () => {
  assert.match(coreCss, /--s1: 4px; --s2: 8px; --s4: 16px; --s6: 24px;/);
  assert.match(coreCss, /--fs-body: 14px; --fs-lead: 16px; --fs-title: 24px; --fs-display: 32px;/);
  assert.match(coreCss, /--r: 8px; --r-pill: 999px;/);
  const all = css.map(([, t]) => t).join("\n");
  assert.doesNotMatch(all, /var\(--(s3|s5|s7|fs-xs|fs-sm|fs-kpi|r-ctl|r-lg)\)/);
});
test("no ad-hoc screen font sizes or radii outside the tokens", () => {
  for (const [f, t] of css) {
    const screen = t.split("@media print")[0];
    assert.doesNotMatch(screen, /font-size:\s*\d+(\.\d+)?px/, f);
    assert.doesNotMatch(screen, /border-radius:\s*(?!999px)[1-9]\d*px/, f);
  }
});
test("token colours keep HSL saturation at or near 70% (<= 72% after 8-bit rounding)", () => {
  const hex = (h) => { const n = parseInt(h.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn; return d && l < 0.9 ? d / (1 - Math.abs(2 * l - 1)) : 0; }; // near-white tints are exempt (8-bit rounding)
  for (const [, block] of coreCss.matchAll(/:root[^{]*\{([^}]*)\}/g))
    for (const line of block.split("\n")) {
      if (/--print|--chart-axis/.test(line)) continue;
      for (const [h] of line.matchAll(/#[0-9a-f]{6}\b/gi)) assert.ok(hex(h) <= 0.72, `${h} in: ${line.trim().slice(0, 50)}`);
    }
});

// A JS fallback colour must come from theme-model.js (the capped values), never a second hex copy
// that drifts from the tokens; chart corner radii read --r.
test("chart and colour modules carry no hard-coded accent or categorical hexes", () => {
  for (const f of ["Dashboard/chart.js", "Dashboard/colour-model.js", "Dashboard/render-table.js"]) {
    const t = readFileSync(new URL(f, root), "utf8");
    assert.doesNotMatch(t, /#(c4142c|fdeff1|2a78d6|008300|e87ba4|eda100|1baf7a|eb6834|4a3aa7|e34948)\b/i, f);
  }
  assert.doesNotMatch(readFileSync(new URL("Dashboard/chart.js", root), "utf8"), /borderRadius:\s*\[[^\]]*\b[1-9]\b/);
});
