// The Data Source data preview's columns (data-preview.js calls sizeColumns after each read): each column starts as wide as its
// content (capped at AUTO_MAX), and a grip on the right edge of its header resizes it — drag it, ← / → in 8px steps (Shift = five
// steps), Delete or a double click for automatic. The same feel as a worksheet table's column handles (render-table.js), with the
// same 48–600px bounds. Widths are view state: kept per card and column name for the session (so Refresh and Edit SQL keep them),
// dropped when the card goes, never saved in the workbook. Numbers (UInt*, Int*, Float*, Decimal) are right-aligned after the first
// column, so their digits line up. The pure helpers are unit-tested in tests/js/preview-columns.test.mjs.
import { nudgeWidth, COL_MIN, COL_MAX, COL_STEP } from "../Dashboard/table-columns-model.js";

export { COL_MIN, COL_MAX };
export const AUTO_MAX = 320; // a column's automatic width never passes this; a drag can go to COL_MAX

/** True when a ClickHouse type holds plain numbers (Nullable / LowCardinality wrappers ignored). */
export function isNumericType(type) {
  let t = String(type ?? "").trim();
  for (let m; (m = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(t)); ) t = m[1].trim();
  return /^(?:U?Int(?:8|16|32|64|128|256)|Float(?:32|64)|BFloat16|Decimal(?:32|64|128|256)?(?:\(.*\))?)$/.test(t);
}

/** A column's automatic width from its widest cell, in px: COL_MIN to AUTO_MAX. */
export const autoWidth = (contentPx) => Math.min(AUTO_MAX, Math.max(COL_MIN, Math.ceil(Number(contentPx) || 0)));

/** The width one keyboard step gives: ← / → is ±COL_STEP, Shift five times that, inside COL_MIN–COL_MAX. */
export const stepWidth = (w, key, shift = false) => nudgeWidth(w, (key === "ArrowRight" ? 1 : -1) * (shift ? 5 : 1));

/** The width a drag `dx` px from width `w0` gives, inside COL_MIN–COL_MAX. */
export const dragWidth = (w0, dx) => nudgeWidth(w0, dx / COL_STEP);

/** Session widths per card: { get(id, name), set(id, name, px), clear(id, name?), auto(id, name, measured), clearAuto(id) }. */
export function widthMemory() {
  const byCard = new Map(), autoByCard = new Map();
  const put = (m, id, name, px) => { if (!m.has(id)) m.set(id, new Map()); m.get(id).set(name, px); };
  return {
    get: (id, name) => byCard.get(id)?.get(name) ?? null,
    set: (id, name, px) => put(byCard, id, name, px),
    clear(id, name) { if (name === undefined) { byCard.delete(id); autoByCard.delete(id); } else byCard.get(id)?.delete(name); },
    /** The automatic width a column has had on this card's pages so far: it only grows, so paging never makes columns jump narrower. */
    auto(id, name, measured) {
      const w = Math.max(autoByCard.get(id)?.get(name) ?? 0, measured);
      put(autoByCard, id, name, w);
      return w;
    },
    clearAuto: (id) => autoByCard.delete(id),
  };
}

/**
 * Size a rendered rows table (rowsTable in Rows/rows-dialog.js, already in the document): measure every column's content in one
 * pass, then fix the widths in a <colgroup> (remembered ones win) and give each header a resize grip.
 */
export function sizeColumns(table, columns, memory, cardId) {
  if (table.classList.contains("rows-table--sized")) return;
  const head = [...table.tHead.rows[0].cells];
  const rows = [...table.tBodies[0].rows];
  // Numbers first: tabular figures change a cell's width, so they go on before anything is measured.
  head.forEach((th, i) => {
    if (i === 0 || !isNumericType(columns[i].type)) return;
    th.classList.add("is-num");
    for (const tr of rows) tr.cells[i]?.classList.add("is-num");
  });
  // Read pass: the widest cell of each column. No writes until it ends. Every cell is measured as text, to the subpixel, plus its
  // padding and its column rule (a <col> width includes the cell's border): scrollWidth rounds and leaves the border out, and a
  // value 0.3px over its box shows an ellipsis ("120.5" read "12…"). Padding and border are the same down a column, so the first
  // row's cell gives them. The 1px is slack for rounding.
  const range = document.createRange();
  const textW = (el) => { range.selectNodeContents(el); return range.getBoundingClientRect().width; };
  const edge = (el) => el.offsetWidth - el.clientWidth + padX(el);
  const auto = head.map((th, i) => {
    const name = th.querySelector(".rows-table__name");
    let w = name ? textW(name) + edge(th) : 0;
    const first = rows[0]?.cells[i];
    if (first) {
      let text = 0;
      for (const tr of rows) { const td = tr.cells[i]; if (td) text = Math.max(text, textW(td)); }
      w = Math.max(w, text + edge(first));
    }
    return memory.auto(cardId, columns[i].name, autoWidth(w + 1));
  });
  // Write pass.
  const cols = head.map(() => document.createElement("col"));
  const group = document.createElement("colgroup");
  group.append(...cols);
  table.prepend(group);
  table.classList.add("rows-table--sized");
  const widthOf = (i) => memory.get(cardId, columns[i].name) ?? auto[i];
  const fitTable = () => { table.style.width = `${cols.reduce((s, c) => s + parseFloat(c.style.width), 0)}px`; };
  const apply = (i, w) => { cols[i].style.width = `${w}px`; grips[i].setAttribute("aria-valuenow", String(w)); fitTable(); };
  const grips = head.map((th, i) => grip(th, columns[i]));
  head.forEach((th, i) => {
    const c = columns[i];
    th.title = `${c.name} · ${c.type}`;
    cols[i].style.width = `${widthOf(i)}px`;
    grips[i].setAttribute("aria-valuenow", String(widthOf(i)));
  });
  fitTable();

  function grip(th, column) {
    const i = head.indexOf(th);
    const g = document.createElement("span");
    g.className = "rows-table__grip";
    g.tabIndex = 0;
    g.title = "Drag to resize · double-click for automatic";
    g.setAttribute("role", "separator");
    g.setAttribute("aria-orientation", "vertical");
    g.setAttribute("aria-label", `Resize column ${column.name}`);
    g.setAttribute("aria-valuemin", String(COL_MIN));
    g.setAttribute("aria-valuemax", String(COL_MAX));
    const set = (w) => { memory.set(cardId, column.name, w); apply(i, w); };
    const reset = () => { memory.clear(cardId, column.name); apply(i, auto[i]); };
    g.addEventListener("dblclick", reset);
    g.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      g.classList.add("is-active");
      document.body.classList.add("is-resizing");
      const x0 = e.clientX, w0 = widthOf(i);
      const move = (m) => apply(i, dragWidth(w0, m.clientX - x0));
      const up = () => {
        g.removeEventListener("pointermove", move); g.removeEventListener("pointerup", up); g.removeEventListener("pointercancel", up);
        g.classList.remove("is-active");
        document.body.classList.remove("is-resizing");
        const w = parseFloat(cols[i].style.width);
        if (w !== w0) set(w);
      };
      g.addEventListener("pointermove", move); g.addEventListener("pointerup", up); g.addEventListener("pointercancel", up);
    });
    g.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); set(stepWidth(widthOf(i), e.key, e.shiftKey)); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); reset(); }
    });
    th.append(g);
    return g;
  }
}

const padX = (el) => { const s = getComputedStyle(el); return parseFloat(s.paddingLeft) + parseFloat(s.paddingRight); };
