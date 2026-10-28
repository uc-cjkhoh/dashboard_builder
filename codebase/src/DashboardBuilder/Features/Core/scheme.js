// Light / dark scheme at runtime — the only module that knows which one is showing. Sets
// <html data-scheme> (Core/core.css keys the dark tokens off it), follows the OS while the choice is
// System, and emits `scheme:changed` on the bus whenever the painted scheme flips so charts and the
// workbook theme re-apply. The choice lives in this browser (localStorage), not in the workbook.
import { bus } from "./store.js";
import { STORAGE_KEY, normalizePref, resolveScheme } from "./scheme-model.js";

const os = matchMedia("(prefers-color-scheme: dark)");
let pref = "system";

export const schemePref = () => pref;
export const isDark = () => document.documentElement.getAttribute("data-scheme") === "dark";

export function setSchemePref(p) {
  pref = normalizePref(p);
  try { localStorage.setItem(STORAGE_KEY, pref); } catch { /* not remembered — fine */ }
  apply();
  bus.dispatchEvent(new CustomEvent("scheme:pref", { detail: pref }));
}

function apply() {
  const next = resolveScheme(pref, os.matches);
  if (document.documentElement.getAttribute("data-scheme") === next) return;
  document.documentElement.setAttribute("data-scheme", next);
  bus.dispatchEvent(new CustomEvent("scheme:changed", { detail: next }));
}

export function initScheme() {
  try { pref = normalizePref(localStorage.getItem(STORAGE_KEY)); } catch { /* storage blocked — System */ }
  os.addEventListener("change", () => { if (pref === "system") apply(); });
  apply(); // scheme-boot.js has normally set it already; this is a no-op then
}
