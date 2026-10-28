// The raw-row dialog (DOM only; every rule lives in rows-model.js): a bounded, scrollable table of the first rows
// of a table, opened from the schema browser's preview button and the worksheet's "View data". Read-only; Escape,
// Close and the backdrop-free X all close it; closing cancels a request still in flight.
import { api } from "../Core/api.js";
import { icon } from "../Core/icons.js";
import { makeButton, openDialog, closeDialog, toast } from "../Core/ui.js";
import { tableRowsRequest, rowsSummary, rowsToCsv, cellText } from "./rows-model.js";

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
let seq = 0;

/** Preview the first rows of one table (schema browser). */
export function openTablePreview(db, table) {
  openRowsDialog({ title: `${table} — first rows`, subtitle: `${db}.${table}`, request: tableRowsRequest(db, table), filename: `${table}-rows` });
}

/** Show the rows of `request` (a /api/rows body). `notes` are sentences about what could not be applied. */
export function openRowsDialog({ title, subtitle = "", request, notes = [], filename = "rows" }) {
  const id = `rows-dialog-${++seq}`;
  const dlg = el("dialog", "dialog rows-dialog");
  dlg.setAttribute("aria-labelledby", `${id}-title`);
  const head = el("div", "rows-dialog__head");
  const titles = el("div", "rows-dialog__titles");
  const h = el("h2", "dialog__title rows-dialog__title", title); h.id = `${id}-title`;
  titles.append(h);
  if (subtitle) titles.append(el("p", "rows-dialog__sub", subtitle));
  const x = makeButton("", "iconbtn"); x.append(icon("close")); x.setAttribute("aria-label", "Close");
  head.append(titles, x);

  const noteBox = el("div", "rows-dialog__notes");
  for (const n of notes) { const p = el("p", "rows-dialog__note"); const g = el("span", "rows-dialog__note-icon"); g.setAttribute("aria-hidden", "true"); g.append(icon("info", { size: 14 })); p.append(g, document.createTextNode(" " + n)); noteBox.append(p); }
  noteBox.hidden = notes.length === 0;

  const scroll = el("div", "rows-dialog__scroll");
  scroll.tabIndex = 0; scroll.setAttribute("role", "region"); scroll.setAttribute("aria-label", "Rows");
  const status = el("p", "rows-dialog__status", "Loading rows…");
  status.setAttribute("role", "status");
  scroll.append(status);

  const foot = el("div", "dialog__foot rows-dialog__foot");
  const summary = el("span", "rows-dialog__summary");
  const csv = makeButton("Export CSV", "btn"); csv.prepend(icon("export", { size: 14 })); csv.disabled = true;
  const close = makeButton("Close", "btn btn--primary");
  foot.append(summary, csv, close);
  dlg.append(head, noteBox, scroll, foot);
  document.body.append(dlg);

  const ctl = new AbortController();
  const finish = () => { ctl.abort(); closeDialog(dlg); };
  x.addEventListener("click", finish); close.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
  openDialog(dlg);
  close.focus();

  api.rows(request, { signal: ctl.signal }).then((res) => {
    summary.textContent = rowsSummary(res) + (res.columnsTruncated ? ` · first ${res.columns.length} columns` : "");
    if (!res.rows.length) { status.textContent = "No rows."; return; }
    scroll.replaceChildren(buildTable(res));
    csv.disabled = false;
    csv.addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob([rowsToCsv(res.columns, res.rows)], { type: "text/csv;charset=utf-8" }));
      const a = el("a"); a.href = url; a.download = `${filename}.csv`; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    });
  }).catch((err) => {
    if (err?.name === "AbortError") return;
    const glyph = el("span", "rows-dialog__note-icon"); glyph.setAttribute("aria-hidden", "true"); glyph.append(icon("warning", { size: 14 }));
    status.classList.add("rows-dialog__status--error");
    status.replaceChildren(glyph, document.createTextNode(" " + err.message));
    toast(err.message, "danger");
  });
  return dlg;
}

function buildTable(res) {
  const table = el("table", "rows-table");
  const thead = el("thead"); const hr = el("tr");
  for (const c of res.columns) {
    const th = el("th"); th.scope = "col";
    th.append(el("span", "rows-table__name", c.name), el("span", "rows-table__type", c.type));
    hr.append(th);
  }
  thead.append(hr);
  const tbody = el("tbody");
  for (const r of res.rows) {
    const tr = el("tr");
    for (const v of r) { const { text, isNull } = cellText(v); tr.append(el("td", isNull ? "rows-table__null" : "", text)); }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}
