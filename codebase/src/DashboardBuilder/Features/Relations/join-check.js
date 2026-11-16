import { makeButton } from "../Core/ui.js";
import { icon } from "../Core/icons.js";
import { describePreview, joinEvidence, suggestionLabel } from "./join-preview-model.js";

// The relationship dialog's suggestion panel: as the dialog opens it makes one bounded read-only call and shows the
// cardinality the data suggests, with the evidence behind it. It never blocks saving and never changes the choice by
// itself — a relationship is the user's declaration (golden rule 5); "Use N:1" only selects. All text via textContent.
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
const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text != null) e.textContent = text; return e; };

/** The counts table: one column per side, one row per measure (`rows` from joinEvidence). */
function evidenceTable(rows, n) {
  const table = el("table", "join-check__table");
  const cap = el("caption", "join-check__caption", "Counts from both tables");
  const head = el("tr");
  head.append(el("td"), ...[`${n.fromTable}.${n.fromColumn}`, `${n.toTable}.${n.toColumn}`].map((t) => { const th = el("th", null, t); th.scope = "col"; th.title = t; return th; }));
  const thead = el("thead"); thead.append(head);
  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr");
    const th = el("th", null, r.label); th.scope = "row";
    tr.append(th, el("td", null, r.from), el("td", null, r.to));
    tbody.append(tr);
  }
  table.append(cap, thead, tbody);
  return table;
}

/** @param dlg the open <dialog> (the request is cancelled when it closes).
 *  @param {{run:(signal)=>Promise, names:object|(()=>object), apply?:{get:()=>string, set:(c:string)=>void}}} check — `apply` reads / sets the
 *  dialog's chosen cardinality: the comparison follows the live choice, and when the data reads differently the suggestion gets a "Use N:1"
 *  button (it only selects; Confirm still saves).
 *  @returns {{root:HTMLElement, start:()=>void, rerun:()=>void, redescribe:()=>void}} — call `start()` once the dialog is built and open;
 *  `rerun()` (debounced) after the key pairs change; `redescribe()` after the chosen cardinality changes (no new query). */
export function buildJoinCheck(dlg, { run, names, apply = null }) {
  const root = el("section", "join-check");
  root.setAttribute("aria-labelledby", "join-check-title");
  const head = el("div", "join-check__head");
  const title = el("h3", "rel-dialog__h join-check__title", "Suggestion");
  title.id = "join-check-title";
  const again = makeButton("", "iconbtn join-check__rerun");
  again.append(icon("refresh", { size: 16 }));
  again.setAttribute("aria-label", "Check the data again");
  again.title = "Check the data again";
  head.append(title, again);
  const out = el("div", "join-check__out");
  out.setAttribute("role", "status"); // always in the DOM, so a screen reader hears each change
  out.setAttribute("aria-live", "polite");
  const hint = el("p", "join-check__hint", "Read from a bounded sample of each table. Any choice can be saved.");
  root.append(head, out, hint);

  let ac = null, last = null, timer = 0;
  const namesNow = () => {
    const n = typeof names === "function" ? names() : names;
    return apply ? { ...n, declared: apply.get() } : n;
  };

  function show() {
    if (!last) return;
    const n = namesNow();
    const d = describePreview(last, n);
    const frag = el("div", "join-check__main"); // the suggestion and its notes; the evidence sits beside it when the panel is wide
    const sampled = last.sampled === true;
    const findings = [...d.findings];
    if (sampled && findings.length) { const f = findings.shift(); frag.append(note(f.level, "info", f.text)); } // the sampling caveat comes before the suggestion it qualifies
    if (d.verdict) {
      const box = el("div", "join-check__suggest");
      box.append(el("p", "join-check__label", sampled ? "Suggested cardinality, from a sample" : "Suggested cardinality"), el("p", "join-check__pick", suggestionLabel(d.observed))); // the headline says what d.verdict says
      if (apply && apply.get() === d.observed) box.append(note("ok", "check", "Matches your choice."));
      else if (apply) {
        const use = makeButton(`Use ${d.observed}`, "btn join-check__use");
        use.addEventListener("click", () => apply.set(d.observed)); // the dialog's cardinality click calls redescribe()
        box.append(use);
      }
      frag.append(box);
    }
    for (const f of findings) frag.append(note(f.level, f.level === "warn" ? "warning" : "info", f.text));
    if (last.from.rows > 0 && last.to.rows > 0) {
      const ev = joinEvidence(last, n);
      const sec = el("div", "join-check__evidence");
      sec.append(el("h4", "join-check__sub", "Evidence"));
      const list = el("ul", "join-check__reasons");
      const reason = (tagText, tagKind, text) => {
        const li = el("li", "join-check__reason");
        li.append(el("span", `join-check__tag join-check__tag--${tagKind}`, tagText), el("span", null, text)); // the shape in words, not colour alone
        list.append(li);
      };
      for (const r of ev.reasons) reason(r.side === "one" ? "One" : "Many", r.side, r.text);
      for (const line of d.summary.slice(0, 2)) reason("Match", "match", line); // the match shares; the repeats line is the reasons above
      sec.append(list);
      out.replaceChildren(frag, sec, evidenceTable(ev.rows, n)); // the counts table spans the panel under both columns
      return;
    }
    out.replaceChildren(frag);
  }

  // A pending run drops the last result at once, so a cardinality pick meanwhile can't show numbers read for the old key pairs.
  function pending() {
    last = null;
    again.disabled = true;
    root.setAttribute("aria-busy", "true");
    out.replaceChildren(note("busy", "refresh", "Checking the data…"));
  }

  async function check() {
    clearTimeout(timer);
    ac?.abort();
    ac = new AbortController();
    const mine = ac;
    pending();
    try {
      const result = await run(mine.signal);
      if (mine.signal.aborted) return;
      last = result;
      show();
    } catch (e) {
      if (mine.signal.aborted) return;
      last = null;
      out.replaceChildren(note("error", "error", `Couldn't check the join: ${e?.message ?? "unknown error"}`));
    } finally {
      if (ac === mine) { again.disabled = false; root.removeAttribute("aria-busy"); }
    }
  }

  dlg.addEventListener("close", () => { clearTimeout(timer); ac?.abort(); });
  again.addEventListener("click", check);
  return {
    root,
    start: check,
    rerun: () => { clearTimeout(timer); ac?.abort(); pending(); timer = setTimeout(check, 300); },
    redescribe: show,
  };
}
