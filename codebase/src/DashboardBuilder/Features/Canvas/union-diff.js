// The "Compare columns" control on a union card (DOM only; rules in Core/source-model.js unionMismatch): reads each table's
// columns from the catalog and lists what the union leaves out and why. Read-only; nothing is stored.
import { api } from "../Core/api.js";
import { unionMismatch, mismatchSummary } from "../Core/source-model.js";

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

/** The note's companion: a button that toggles a list of the left-out columns. Returns the element to put under the note. */
export function unionDiffControl(source) {
  const wrap = el("div", "entity__diff");
  const btn = el("button", "btn entity__diff-btn", "Compare columns");
  btn.type = "button"; btn.setAttribute("aria-expanded", "false");
  const out = el("div", "entity__diff-out"); out.hidden = true; out.setAttribute("role", "status");
  wrap.append(btn, out);
  let loaded = false, loading = false;
  btn.addEventListener("click", async () => {
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", String(open)); out.hidden = !open;
    if (!open || loaded || loading) return;
    loading = true;
    out.textContent = "Loading…";
    try {
      const tables = await Promise.all(source.tables.map(async (table) => ({ table, columns: await api.columns(source.db, table) })));
      const m = unionMismatch(tables);
      out.replaceChildren(el("p", "entity__diff-sum", mismatchSummary(m)));
      const list = el("ul", "entity__diff-list");
      for (const x of m.missing) list.append(el("li", "", `${x.column}: only in ${x.in.join(", ")} (not in ${x.notIn.join(", ")})`));
      for (const x of m.kind) list.append(el("li", "", `${x.column}: unlike kinds (${Object.entries(x.kinds).map(([t, k]) => `${t} ${k}`).join(", ")})`));
      if (list.children.length) out.append(list);
      loaded = true;
    } catch (err) { out.textContent = `${err.message} Click Compare columns again to retry.`; }
    finally { loading = false; }
  });
  return wrap;
}
