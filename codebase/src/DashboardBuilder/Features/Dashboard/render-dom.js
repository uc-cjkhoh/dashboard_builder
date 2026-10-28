import { icon } from "../Core/icons.js";

// DOM builders every render module (and the editor) shares.
export function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
export const hint = (text) => el("div", "ws-hint", text);
export const warn = (text) => el("div", "ws-hint ws-hint--warn", text);
export function iconSpan(cls, name) { const s = el("span", cls); s.append(icon(name)); return s; }
