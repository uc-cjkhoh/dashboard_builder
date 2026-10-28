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
