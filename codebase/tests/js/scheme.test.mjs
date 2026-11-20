import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { SCHEME_PREFS, STORAGE_KEY, normalizePref } from "../../src/DashboardBuilder/Features/Core/scheme-model.js";
const boot = readFileSync(new URL("../../src/DashboardBuilder/Features/Core/scheme-boot.js", import.meta.url), "utf8");
const scheme = readFileSync(new URL("../../src/DashboardBuilder/Features/Core/scheme.js", import.meta.url), "utf8");

test("two choices, Light first (the default); no System", () => {
  assert.deepEqual(SCHEME_PREFS.map((p) => p.id), ["light", "dark"]);
  for (const p of SCHEME_PREFS) assert.ok(p.label && p.icon, p.id);
});
test("normalizePref keeps a known choice and falls back to light (a stored \"system\" included)", () => {
  for (const p of ["light", "dark"]) assert.equal(normalizePref(p), p);
  for (const bad of [null, undefined, "", "Dark", "auto", "system", 1]) assert.equal(normalizePref(bad), "light");
});
test("the OS setting is never read at runtime", () => {
  assert.doesNotMatch(scheme, /matchMedia|prefers-color-scheme/);
  assert.doesNotMatch(boot, /matchMedia|prefers-color-scheme/);
});

// The classic boot script runs before first paint and can't import the model — it must agree with it.
function runBoot(stored, { storageThrows = false } = {}) {
  const attrs = {};
  const ctx = {
    localStorage: { getItem: (k) => { if (storageThrows) throw new Error("blocked"); return k === STORAGE_KEY ? stored : null; } },
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
  };
  vm.runInNewContext(boot, ctx);
  return attrs["data-scheme"];
}
test("scheme-boot.js sets data-scheme exactly as normalizePref decides", () => {
  for (const stored of [null, "system", "light", "dark", "junk"]) assert.equal(runBoot(stored), normalizePref(stored), String(stored));
});
test("scheme-boot.js is light when storage is blocked", () => {
  assert.equal(runBoot("dark", { storageThrows: true }), "light");
});
