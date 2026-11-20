// Light / dark scheme at runtime — the only module that knows which one is showing. Sets
// <html data-scheme> (Core/core.css keys the dark tokens off it) and emits `scheme:changed` on the
// bus whenever the painted scheme flips so charts and the workbook theme re-apply. The choice lives in
// this browser (localStorage), not in the workbook; the OS setting is not read.
import { bus } from "./store.js";
import { STORAGE_KEY, normalizePref } from "./scheme-model.js";

let pref = "light";

export const schemePref = () => pref;
export const isDark = () => document.documentElement.getAttribute("data-scheme") === "dark";

export function setSchemePref(p) {
  pref = normalizePref(p);
  try { localStorage.setItem(STORAGE_KEY, pref); } catch { /* not remembered — fine */ }
  apply();
  bus.dispatchEvent(new CustomEvent("scheme:pref", { detail: pref }));
}

function apply() {
  if (document.documentElement.getAttribute("data-scheme") === pref) return;
  document.documentElement.setAttribute("data-scheme", pref);
  bus.dispatchEvent(new CustomEvent("scheme:changed", { detail: pref }));
}

export function initScheme() {
  try { pref = normalizePref(localStorage.getItem(STORAGE_KEY)); } catch { /* storage blocked — Light */ }
  apply(); // scheme-boot.js has normally set it already; this is a no-op then
}
