import { createDrag, dropPlan } from "./board-drag.js";
import { keyStep, movedMessage, resizedMessage } from "./board-keys.js";
import { SHEET_MIME } from "./board-panel.js";
import { icon } from "../Core/icons.js";

// DOM wiring for editing the board: pointer move / resize, the keyboard, and dropping a worksheet from the side panel. All the
// geometry and every verdict come from the pure modules (board-layout / board-drag / board-keys / board-model); this file turns
// events into points, draws the ghost, and hands a result to `ctx.commit` — one committed step per edit.
//
//   ctx = { grid, scroll, getDash(), nameOf(widget), metrics(), commit(next), status(message, refused?), addAt(sheetId, cand) }
//   Points are grid-relative (clientX − grid left), so scrolling the canvas while dragging needs no correction.
const h = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

export function initInteract(ctx) {
  const { grid, scroll } = ctx;
  const drag = createDrag();
  const ghost = h("div", "board-ghost");
  ghost.hidden = true;
  ghost.setAttribute("aria-hidden", "true");
  const ghostLabel = h("span", "board-ghost__label");
  ghost.append(ghostLabel);
  grid.append(ghost);
  let dragEl = null; // the widget being dragged
  let abort = null, dragId = null; // ends the running gesture without committing

  const point = (e) => { const r = grid.getBoundingClientRect(); return { x: e.clientX - r.left + grid.scrollLeft, y: e.clientY - r.top + grid.scrollTop }; }; // a ranged board scrolls inside itself
  const cctx = () => { const dash = ctx.getDash(); return { widgets: dash?.widgets ?? [], panelWidth: grid.clientWidth, metrics: ctx.metrics(), nameOf: ctx.nameOf }; };

  function showGhost(g) {
    if (!g?.rect) { hideGhost(); return; }
    ghost.hidden = false;
    ghost.classList.toggle("is-refused", Boolean(g.error));
    Object.assign(ghost.style, { left: `${g.rect.left}px`, top: `${g.rect.top}px`, width: `${g.rect.width}px`, height: `${g.rect.height}px` });
    ghostLabel.replaceChildren(...(g.error ? [icon("warning", { size: 14 }), document.createTextNode("Can't drop here")] : []));
    ghost.title = g.error ?? "";
  }
  function hideGhost() { ghost.hidden = true; ghost.classList.remove("is-refused"); }
  function endDrag() { hideGhost(); dragEl?.classList.remove("is-dragging"); dragEl = null; grid.classList.remove("is-dragging"); }

  // --- pointer: move by the header, resize by the corner ---
  grid.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || drag.pressed) return;
    const grip = e.target.closest(".board-widget__resize");
    const head = e.target.closest(".board-widget__head");
    if (!grip && (!head || e.target.closest("button, input, textarea, select, a"))) return;
    const wEl = e.target.closest(".board-widget");
    const widget = ctx.getDash()?.widgets.find((w) => w.id === wEl?.dataset.widgetId);
    if (!widget || !drag.start(grip ? "resize" : "move", widget, point(e))) return;
    const handle = grip ?? head;
    dragEl = wEl;
    try { handle.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer id: the window listeners below still work */ }
    const mine = (ev) => ev.pointerId === e.pointerId; // a second pointer (another finger) never moves or ends this drag
    const onMove = (ev) => {
      if (!mine(ev)) return;
      const g = drag.move(point(ev), cctx());
      if (!g) return;
      dragEl.classList.add("is-dragging");
      grid.classList.add("is-dragging");
      showGhost(g);
    };
    const finish = (commit, ev) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      handle.removeEventListener("lostpointercapture", onLost);
      window.removeEventListener("blur", onBlur);
      abort = null;
      document.removeEventListener("keydown", onKey, true);
      const widgetEl = dragEl;
      if (!commit) { drag.cancel(); endDrag(); return; }
      const r = drag.end(point(ev), cctx());
      endDrag();
      if (r.type === "commit") {
        const dash = ctx.getDash();
        ctx.commit(dash.widgets.map((w) => (w.id === widget.id ? { ...w, x: r.cand.x, y: r.cand.y, w: r.cand.w, h: r.cand.h } : w)));
        ctx.status(r.mode === "move" ? movedMessage(r.cand) : resizedMessage(r.cand));
      } else if (r.type === "revert") ctx.status(r.error, true, { near: widget.id }); // snapped back: nothing moved
      widgetEl?.focus({ preventScroll: true });
    };
    const onUp = (ev) => { if (mine(ev)) finish(true, ev); };
    const onCancel = (ev) => { if (mine(ev)) finish(false); }; // pointercancel: no ghost left behind
    const onLost = (ev) => { if (mine(ev) && drag.pressed) finish(false); };
    const onBlur = () => finish(false); // only `blur` listens on window: losing focus mid-drag cancels
    abort = () => finish(false);
    dragId = widget.id;
    const onKey = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); finish(false); } };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    handle.addEventListener("lostpointercapture", onLost);
    window.addEventListener("blur", onBlur);
    document.addEventListener("keydown", onKey, true);
  });

  // --- keyboard: a focused widget moves with the arrows, resizes with Shift + arrows ---
  grid.addEventListener("keydown", (e) => {
    const el = e.target;
    if (!el.classList?.contains("board-widget") || e.ctrlKey || e.metaKey || e.altKey) return;
    const dash = ctx.getDash();
    const widget = dash?.widgets.find((w) => w.id === el.dataset.widgetId);
    const r = widget && keyStep(dash.widgets, widget, e.key, e.shiftKey, ctx.nameOf);
    if (!r) return;
    e.preventDefault();
    if (!r.ok) { ctx.status(r.message, true, { near: widget.id }); return; }
    ctx.commit(dash.widgets.map((w) => (w.id === widget.id ? { ...w, x: r.cand.x, y: r.cand.y, w: r.cand.w, h: r.cand.h } : w)));
    ctx.status(r.message);
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  // --- drop a worksheet from the side panel at the cell under the pointer ---
  const isSheetDrag = (e) => Array.from(e.dataTransfer?.types ?? []).includes(SHEET_MIME);
  const dropGhost = (e) => dropPlan(ctx.getDash()?.widgets ?? [], "sheet", point(e), cctx());
  scroll.addEventListener("dragover", (e) => {
    if (!isSheetDrag(e)) return;
    e.preventDefault(); // allow the drop
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    showGhost(dropGhost(e));
  });
  scroll.addEventListener("dragleave", (e) => { if (!scroll.contains(e.relatedTarget)) hideGhost(); });
  scroll.addEventListener("drop", (e) => {
    if (!isSheetDrag(e)) return;
    e.preventDefault();
    hideGhost();
    const sheetId = e.dataTransfer.getData(SHEET_MIME);
    const plan = dropGhost(e);
    if (plan.error) { ctx.status(plan.error, true); return; }
    ctx.addAt(sheetId, plan.cand);
  });
  document.addEventListener("dragend", hideGhost);

  return {
    cancel: () => { if (abort) abort(); else { drag.cancel(); endDrag(); } },
    /** The widget list changed (a removal): a gesture on a widget that no longer exists ends, committing nothing. */
    cancelIfGone: () => { if (abort && !ctx.getDash()?.widgets.some((w) => w.id === dragId)) abort(); },
    get dragging() { return drag.pressed; },
  };
}
