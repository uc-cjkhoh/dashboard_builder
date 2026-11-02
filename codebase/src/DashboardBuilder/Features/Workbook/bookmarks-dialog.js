// Bookmarks: save the open worksheet's view (its whole sheet — filters, selection, drill, page,
// date range, format — plus the shared filters) under a name, and re-apply it later. Bookmarks save with
// the workbook. Applying one whose worksheet was closed recreates that worksheet. Dashboards are not bookmarked.
import {
  activeWorksheet, worksheetById, bookmarks, addBookmark, removeBookmark, createWorksheet, tabLimitError,
  updateSheet, switchTab, sharedFilters, setSharedFilters,
} from "../Core/store.js";
import { LIMITS, text } from "../Core/validate.js";
import { makeButton, openDialog, closeDialog, toast, fieldError } from "../Core/ui.js";

/** Workbook menu → Save view as bookmark…: name it, then save the open worksheet's view. */
export function saveBookmarkDialog() {
  const dash = activeWorksheet();
  if (!dash) { toast("Open a worksheet first — a bookmark saves a worksheet's view.", "info"); return; }
  if (bookmarks.length >= LIMITS.bookmarks) { toast(`A workbook can keep at most ${LIMITS.bookmarks} bookmarks — delete one first.`, "info"); return; }
  const { dlg, body, foot } = shell("Save view as bookmark", "dialog--sm");
  const field = el("label", "form-field");
  field.append(el("span", "form-field__label", "Name"));
  const input = el("input", "input");
  input.maxLength = LIMITS.tabName;
  input.value = `${dash.name} — ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
  field.append(input);
  body.append(field, el("p", "bookmark-note", "Saves this worksheet's filters, date range, selection, drill level, page, chart type and format — and the shared filters."));
  const cancel = makeButton("Cancel", "btn"), save = makeButton("Save", "btn btn--primary");
  foot.append(cancel, save);
  const done = () => closeDialog(dlg);
  cancel.addEventListener("click", done);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(); });
  const submit = () => {
    const r = text(input.value, { label: "Bookmark name", max: LIMITS.tabName, required: true });
    if (!r.ok) { fieldError(input, r.error); input.focus(); return; }
    addBookmark({ name: r.value, worksheetId: dash.id, worksheetName: dash.name, sheet: snapshot(dash.sheet),
      sharedFilters: structuredClone(sharedFilters), savedAt: new Date().toISOString() });
    done();
    toast(`Saved bookmark “${r.value}”.`, "ok");
  };
  save.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
  document.body.append(dlg);
  openDialog(dlg);
  input.select();
}

/** Workbook menu → Bookmarks…: the list, each with Apply and Delete. */
export function openBookmarksDialog() {
  const { dlg, body, foot } = shell("Bookmarks");
  const close = makeButton("Close", "btn");
  foot.append(close);
  const done = () => closeDialog(dlg);
  close.addEventListener("click", done);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(); });
  const render = () => {
    body.replaceChildren();
    if (!bookmarks.length) {
      body.append(el("p", "bookmark-note", "No bookmarks yet. Open a worksheet and choose Workbook → Save view as bookmark…"));
      return;
    }
    const list = el("ul", "bookmark-list");
    for (const b of bookmarks) {
      const li = el("li", "bookmark");
      const info = el("div", "bookmark__info");
      const where = worksheetById(b.worksheetId);
      info.append(el("span", "bookmark__name", b.name),
        el("span", "bookmark__meta", `${where ? where.name : `${b.worksheetName} (closed — reopens)`}${b.savedAt ? ` · ${new Date(b.savedAt).toLocaleString()}` : ""}`));
      const apply = makeButton("Apply", "btn btn--primary");
      apply.setAttribute("aria-label", `Apply bookmark ${b.name}`);
      apply.addEventListener("click", () => { applyBookmark(b); done(); });
      const del = makeButton("Delete", "btn");
      del.setAttribute("aria-label", `Delete bookmark ${b.name}`);
      del.addEventListener("click", () => { removeBookmark(b.id); render(); });
      li.append(info, apply, del);
      list.append(li);
    }
    body.append(list);
  };
  render();
  document.body.append(dlg);
  openDialog(dlg);
  body.querySelector("button")?.focus();
}

/** Re-apply a bookmark: its worksheet (recreated if closed) gets the saved sheet; shared filters too. */
export function applyBookmark(b) {
  let dash = worksheetById(b.worksheetId);
  if (!dash) {
    dash = createWorksheet(b.worksheetName);
    if (!dash) { toast(tabLimitError(), "danger"); return; }
    b.worksheetId = dash.id;
  }
  setSharedFilters(structuredClone(b.sharedFilters ?? []));
  updateSheet(dash.id, snapshot(b.sheet));
  switchTab(dash.id);
  toast(`Applied bookmark “${b.name}”.`, "ok");
}

// A deep copy without the transient Pages member list (re-fetched on demand).
function snapshot(sheet) {
  const copy = structuredClone(sheet);
  if (copy.pages) { delete copy.pages.members; delete copy.pages.loadError; delete copy.pages.more; }
  return copy;
}

function shell(titleText, extra = "") {
  const dlg = el("dialog", `dialog ${extra}`.trim());
  const head = el("div", "dialog__head");
  const title = el("h2", null, titleText);
  title.id = `dlg-${Math.random().toString(36).slice(2)}`;
  dlg.setAttribute("aria-labelledby", title.id);
  head.append(title);
  const body = el("div", "dialog__body");
  const foot = el("div", "dialog__foot");
  dlg.append(head, body, foot);
  return { dlg, body, foot };
}
function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; }
