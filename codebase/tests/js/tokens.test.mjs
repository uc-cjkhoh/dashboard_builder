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
  assert.match(core, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[^}]*--surface:/);
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
