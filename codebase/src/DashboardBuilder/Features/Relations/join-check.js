import { makeButton } from "../Core/ui.js";
import { icon } from "../Core/icons.js";
import { describePreview } from "./join-preview-model.js";

// The relationship dialog's "Check this join": one bounded read-only call, then a plain-words result. It never blocks
// saving — a relationship is the user's declaration (golden rule 5). All text via textContent; state shown with `hidden`.
const note = (kind, glyph, text) => {
  const p = document.createElement("p");
  p.className = `join-check__note join-check__note--${kind}`;
  const g = document.createElement("span");
  g.className = "join-check__glyph"; g.setAttribute("aria-hidden", "true"); g.append(icon(glyph, { size: 14 }));
  const t = document.createElement("span");
  t.textContent = text;
  p.append(g, t);
  return p;
};

/** @param dlg the open <dialog> (the request is cancelled when it closes). @param {{run:(signal)=>Promise, names:object}} check */
export function buildJoinCheck(dlg, { run, names }) {
  const root = document.createElement("section");
  root.className = "join-check";
  root.setAttribute("aria-label", "Check this join");
  const btn = makeButton("Check this join", "btn join-check__btn");
  const hint = document.createElement("span");
  hint.className = "join-check__hint";
  hint.textContent = "Reads a bounded sample of both tables. Read-only; saving is never blocked.";
  const head = document.createElement("div");
  head.className = "join-check__head";
  head.append(btn, hint);
  const out = document.createElement("div");
  out.className = "join-check__out";
  out.setAttribute("role", "status"); // always in the DOM, so a screen reader hears each change
  out.setAttribute("aria-live", "polite");
  root.append(head, out);

  let ac = null;
  dlg.addEventListener("close", () => ac?.abort());
  btn.addEventListener("click", async () => {
    ac?.abort();
    ac = new AbortController();
    const mine = ac;
    btn.disabled = true;
    out.replaceChildren(note("busy", "refresh", "Checking the join…"));
    try {
      const result = await run(mine.signal);
      if (mine.signal.aborted) return;
      const d = describePreview(result, typeof names === "function" ? names() : names);
      const frag = document.createDocumentFragment();
      const list = document.createElement("ul");
      list.className = "join-check__summary";
      for (const line of d.summary) { const li = document.createElement("li"); li.textContent = line; list.append(li); }
      if (d.summary.length) frag.append(list);
      if (d.verdict) {
        const v = document.createElement("p");
        v.className = "join-check__verdict";
        v.textContent = d.verdict;
        frag.append(v);
      }
      for (const f of d.findings) frag.append(note(f.level, f.level === "warn" ? "warning" : "info", f.text));
      out.replaceChildren(frag);
    } catch (e) {
      if (mine.signal.aborted) return;
      out.replaceChildren(note("error", "error", `Couldn't check the join: ${e?.message ?? "unknown error"}`));
    } finally {
      if (ac === mine) btn.disabled = false;
    }
  });
  return root;
}
