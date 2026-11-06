// URL actions — pure, DOM-free (unit-tested in tests/js/action-model.test.mjs). A worksheet may carry
// one link action { label, template }: the template is an https:// address with {value} where the
// clicked mark's value goes (URL-encoded). It opens only from the selection chip, in a new tab with
// noopener — never automatically, never to anything but https.
import { checkValue } from "../Core/parameters-model.js";
export const MAX_TEMPLATE = 500;
export const MAX_LABEL = 40;

/** Why a template can't be used, or null when it can. */
export function templateError(template) {
  const t = String(template ?? "").trim();
  if (!t) return "Enter a link, e.g. https://crm.example.com/customers/{value}.";
  if (t.length > MAX_TEMPLATE) return `A link can be at most ${MAX_TEMPLATE} characters.`;
  if (!/^https:\/\//i.test(t)) return "Links must start with https://.";
  if (/\s/.test(t)) return "A link can't contain spaces.";
  if (!t.includes("{value}")) return "Put {value} where the clicked value goes.";
  const probe = urlFrom(t, "x");
  return probe ? null : "That isn't a valid web address.";
}

/** The link for a clicked value: { url } or { error }. */
export function buildActionUrl(template, value) {
  const err = templateError(template);
  if (err) return { error: err };
  if (value === null || value === undefined || value === "") return { error: "This mark has no value to link to." };
  const url = urlFrom(String(template).trim(), String(value));
  return url ? { url } : { error: "That isn't a valid web address." };
}

// Substitute the encoded value and parse; only an https URL with a host survives.
function urlFrom(template, value) {
  try {
    const u = new URL(template.split("{value}").join(encodeURIComponent(value)));
    return u.protocol === "https:" && u.hostname ? u.href : null;
  } catch { return null; }
}

/** A saved action, checked: { label, template } or null (+ an issue). */
export function cleanAction(raw, where, issues) {
  if (raw == null) return null;
  const label = typeof raw?.label === "string" ? raw.label.trim().slice(0, MAX_LABEL) : "";
  if (typeof raw !== "object" || typeof raw.template !== "string" || templateError(raw.template)) {
    issues.push(`${where}: the link action was invalid — removed.`);
    return null;
  }
  return { label: label || "Open link", template: raw.template.trim() };
}

// Parameter action: a worksheet may also carry one { param: <parameter id> } — a click on a mark offers
// "Set <parameter>" on the selection chip, which writes the mark's value into that parameter (checked
// against its type and allowed values, like any edit). Never automatic.

/** A saved parameter action, checked: { param } or null (+ an issue). */
export function cleanParamAction(raw, where, issues) {
  if (raw == null) return null;
  if (typeof raw !== "object" || typeof raw.param !== "string" || !/^prm\d{1,6}$/.test(raw.param)) {
    issues.push(`${where}: the parameter action was invalid — removed.`);
    return null;
  }
  return { param: raw.param };
}

/** The new value for the action's parameter: { ok, id, name, value } or { ok: false, error }. */
export function applyParamAction(action, params, raw) {
  const p = params.find((x) => x.id === action?.param);
  if (!p) return { ok: false, error: "That parameter no longer exists." };
  if (raw === null || raw === undefined || raw === "") return { ok: false, error: "This mark has no value to set." };
  const r = checkValue(p, raw);
  return r.ok ? { ok: true, id: p.id, name: p.name, value: r.value } : { ok: false, error: r.error };
}
