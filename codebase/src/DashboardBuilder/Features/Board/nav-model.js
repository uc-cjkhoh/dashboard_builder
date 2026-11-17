// A navigation button widget — pure (tests/js/nav-model.test.mjs). { kind: "nav", label, tip, target } where `target` is a tab id
// (worksheet or dashboard) or null (the button is not linked yet). The saved form points at the tab by { kind, index }.
import { LIMITS, text } from "../Core/validate.js";

/** { label, tip, target } as typed → { ok: true, value } or { ok: false, errors: { label?, tip?, target? } }. `target` "" = no tab;
 *  `offered` = the tab ids the picker lists. */
export function validateNavEdit({ label, tip, target }, offered) {
  const l = text(label, { label: "The label", max: LIMITS.navLabel, required: true });
  const t = text(tip, { label: "The tooltip", max: LIMITS.navTip });
  const errors = {};
  if (!l.ok) errors.label = l.error;
  if (!t.ok) errors.tip = t.error;
  if (target && !offered.includes(target)) errors.target = "Choose a tab from the list.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { label: l.value, tip: t.value, target: target || null } };
}

/** The tabs a button on dashboard `ownId` may go to: every worksheet and dashboard but that dashboard (never a story). */
export const navTargets = (tabs, ownId) => tabs.filter((t) => t.id !== ownId && t.kind !== "story").map((t) => ({ id: t.id, name: t.name, kind: t.kind }));

/** Does saving `value` change the button? */
export const navChanged = (w, v) => (w.label ?? "") !== v.label || (w.tip ?? "") !== v.tip || (w.target ?? null) !== v.target;

/** The dashboards with a button that goes to tab `tabId`. */
export const dashboardsLinking = (tabs, tabId) => tabs.filter((t) => t.kind === "dashboard" && t.widgets.some((w) => w.kind === "nav" && w.target === tabId));

/** The widgets with every button that went to tab `tabId` unlinked (the same array when none did). */
export function clearNavTarget(widgets, tabId) {
  return widgets.some((w) => w.kind === "nav" && w.target === tabId)
    ? widgets.map((w) => (w.kind === "nav" && w.target === tabId ? { ...w, target: null } : w))
    : widgets;
}
