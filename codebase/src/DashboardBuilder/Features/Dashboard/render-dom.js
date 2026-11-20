import { icon } from "../Core/icons.js";

// DOM builders every render module (and the editor) shares.
export function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
// The empty worksheet's picture: a dashed ghost bar chart (axes and five bars), the worksheet's counterpart of the Data Source's ghost model. Static markup, decoration only.
const GHOST_CHART = `<svg class="ws-ghost" viewBox="0 0 240 120" aria-hidden="true" focusable="false">
  <rect class="ws-ghost__bar" x="33" y="65" width="26" height="43" rx="4" /><rect class="ws-ghost__bar" x="69" y="29" width="26" height="79" rx="4" />
  <rect class="ws-ghost__bar" x="105" y="49" width="26" height="59" rx="4" /><rect class="ws-ghost__bar" x="141" y="17" width="26" height="91" rx="4" />
  <rect class="ws-ghost__bar" x="177" y="57" width="26" height="51" rx="4" />
  <path class="ws-ghost__axis" d="M17 5v103h214" /></svg>`;
// lead: the one next action on an empty surface — larger, full-strength ink, centred in the pane under the ghost chart
export function hint(text, lead = false) {
  if (!lead) return el("div", "ws-hint", text);
  const h = el("div", "ws-hint ws-hint--lead");
  h.insertAdjacentHTML("beforeend", GHOST_CHART);
  h.append(document.createTextNode(text));
  return h;
}
export const warn = (text) => el("div", "ws-hint ws-hint--warn", text);
export function iconSpan(cls, name) { const s = el("span", cls); s.append(icon(name)); return s; }
