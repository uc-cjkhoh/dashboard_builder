// Dashboard/field-group.js — the one collapsible group of the worksheet's field pane: Marks and every
// table share this header (chevron + bold name) and spacing. Which groups are collapsed survives the pane's rebuilds.
import { icon } from "../Core/icons.js";

const collapsed = new Set();

/** A `<details class="ws-group {cls}">` whose summary is the header; `key` identifies it across rebuilds, `id` goes on the header (aria-labelledby). */
export function fieldGroup(cls, key, title, id) {
  const group = document.createElement("details");
  group.className = `ws-group ${cls}`;
  group.dataset.key = key;
  group.open = !collapsed.has(key);
  group.addEventListener("toggle", () => { if (group.open) collapsed.delete(key); else collapsed.add(key); });
  const head = document.createElement("summary");
  head.className = "ws-group__head";
  if (id) head.id = id;
  const chev = icon("chevron", { size: 16 });
  const name = document.createElement("span");
  name.className = "ws-group__name"; name.textContent = title;
  head.append(chev, name);
  group.append(head);
  return group;
}
