import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { SCHEME_PREFS, STORAGE_KEY, normalizePref, resolveScheme } from "../../src/DashboardBuilder/Features/Core/scheme-model.js";
const boot = readFileSync(new URL("../../src/DashboardBuilder/Features/Core/scheme-boot.js", import.meta.url), "utf8");

test("the three choices, System first (the default)", () => {
  assert.deepEqual(SCHEME_PREFS.map((p) => p.id), ["system", "light", "dark"]);
  for (const p of SCHEME_PREFS) assert.ok(p.label && p.icon, p.id);
});
test("normalizePref keeps a known choice and falls back to system", () => {
  for (const p of ["system", "light", "dark"]) assert.equal(normalizePref(p), p);
  for (const bad of [null, undefined, "", "Dark", "auto", 1]) assert.equal(normalizePref(bad), "system");
});
test("resolveScheme: an explicit choice wins over the OS; system follows it", () => {
  assert.equal(resolveScheme("light", true), "light");
  assert.equal(resolveScheme("dark", false), "dark");
  assert.equal(resolveScheme("system", true), "dark");
  assert.equal(resolveScheme("system", false), "light");
  assert.equal(resolveScheme("garbage", true), "dark");
});

// The classic boot script runs before first paint and can't import the model — it must agree with it.
function runBoot(stored, osDark, { storageThrows = false } = {}) {
  const attrs = {};
  const ctx = {
    localStorage: { getItem: (k) => { if (storageThrows) throw new Error("blocked"); return k === STORAGE_KEY ? stored : null; } },
    matchMedia: (q) => ({ matches: q === "(prefers-color-scheme: dark)" && osDark }),
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
  };
  vm.runInNewContext(boot, ctx);
  return attrs["data-scheme"];
}
test("scheme-boot.js sets data-scheme exactly as resolveScheme decides", () => {
  for (const stored of [null, "system", "light", "dark", "junk"]) for (const osDark of [false, true])
    assert.equal(runBoot(stored, osDark), resolveScheme(normalizePref(stored), osDark), `${stored} / ${osDark}`);
});
test("scheme-boot.js follows the OS when storage is blocked", () => {
  assert.equal(runBoot("light", true, { storageThrows: true }), "dark");
  assert.equal(runBoot("dark", false, { storageThrows: true }), "light");
});
