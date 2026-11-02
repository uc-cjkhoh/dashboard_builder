// The performance dialog: the recent query and render timings (Core/perf-log.js), newest first, with
// Copy as text and Clear. Opened from the top-bar gauge button; a native <dialog>, so Esc closes it
// and focus is trapped while it is open. Nothing here leaves the browser.
import { perfLog, formatPerfText } from "../Core/perf-log.js";
import { makeButton, openDialog, closeDialog, copyText } from "../Core/ui.js";

const cell = (tag, text) => { const c = document.createElement(tag); c.textContent = text; return c; };

function summaryOf(entries) {
  const q = entries.filter((e) => e.kind !== "render" && !e.cached);
  const hits = entries.filter((e) => e.cached).length;
  if (!entries.length) return "";
  const avg = q.length ? Math.round(q.reduce((a, e) => a + e.ms, 0) / q.length) : 0;
  return `${entries.length} recorded · ${q.length} queried (avg ${avg} ms) · ${hits} from cache`;
}

function fill(body, summary) {
  const entries = perfLog.entries().reverse();
  summary.textContent = summaryOf(entries);
  if (!entries.length) {
    const p = document.createElement("p"); p.className = "perf-empty"; p.textContent = "No timings yet — open a worksheet to record some.";
    body.replaceChildren(p); return;
  }
  const table = document.createElement("table"); table.className = "perf-table";
  const head = document.createElement("tr");
  head.append(...["Time (UTC)", "Kind", "Query ms", "Rows", "Cache", "Render ms"].map((t) => cell("th", t)));
  const thead = document.createElement("thead"); thead.append(head);
  const tbody = document.createElement("tbody");
  for (const e of entries) {
    const tr = document.createElement("tr");
    tr.append(cell("td", new Date(e.at).toISOString().slice(11, 19)), cell("td", e.kind), cell("td", e.kind === "render" ? "" : String(e.ms)),
      cell("td", e.rows ?? ""), cell("td", e.kind === "render" ? "" : e.cached ? "Hit" : "Miss"), cell("td", e.renderMs ?? ""));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  body.replaceChildren(table);
}

export function initPerfPanel() {
  const btn = document.getElementById("perf-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const dlg = document.createElement("dialog");
    dlg.className = "dialog perf-dialog"; dlg.setAttribute("aria-labelledby", "perf-title");
    const title = document.createElement("h2"); title.className = "dialog__title"; title.id = "perf-title"; title.textContent = "Performance";
    const summary = document.createElement("p"); summary.className = "perf-summary";
    const body = document.createElement("div"); body.className = "perf-dialog__body";
    const foot = document.createElement("div"); foot.className = "dialog__foot";
    const copy = makeButton("Copy as text", "btn"), clear = makeButton("Clear", "btn"), done = makeButton("Close", "btn btn--primary");
    foot.append(copy, clear, done);
    dlg.append(title, summary, body, foot);
    document.body.append(dlg);
    const render = () => fill(body, summary);
    const off = perfLog.subscribe(render);
    const finish = () => { off(); closeDialog(dlg); btn.focus(); };
    copy.addEventListener("click", () => copyText(formatPerfText(perfLog.entries()), "timings"));
    clear.addEventListener("click", () => perfLog.clear());
    done.addEventListener("click", finish);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
    render();
    openDialog(dlg);
    done.focus();
  });
}
