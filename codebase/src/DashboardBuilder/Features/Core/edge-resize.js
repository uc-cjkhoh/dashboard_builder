// Core/edge-resize.js — expandable cards: hover a card's bottom border, then click and drag to set its height.
// Delegated on one container, so cards rebuilt by the field pane keep working. Alt+↑/↓ on a card's header does the
// same from the keyboard (16px steps); double-clicking the border returns the card to automatic sizing. The pure
// helpers (`onBottomEdge`, `clampHeight`, `heightStore`) are unit-tested under tests/js/.

/** Height of the border grip, in px: the card's 1px border plus the padding just inside it. */
export const EDGE = 6;
const STEP = 16;

/** True when pointer y sits on the bottom border strip of a card whose bottom edge is `bottom`. */
export function onBottomEdge(y, bottom, zone = EDGE) {
  return Number.isFinite(y) && Number.isFinite(bottom) && y <= bottom + 1 && y >= bottom - zone;
}

/** Clamp a height to [min, max] (rounded). A max below min yields min; a non-number yields min. */
export function clampHeight(px, min, max) {
  if (!Number.isFinite(px)) return min;
  return Math.round(Math.max(min, Math.min(Math.max(min, max), px)));
}

/** Remembered heights ({ key: px }) in one storage item; every read and write survives blocked storage. */
export function heightStore(storage, itemKey) {
  const read = () => {
    try {
      const raw = JSON.parse(storage?.getItem(itemKey) ?? "{}");
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch { return {}; }
  };
  const write = (all) => { try { storage?.setItem(itemKey, JSON.stringify(all)); } catch { /* not remembered — fine */ } };
  return {
    get(key) { const v = Number(read()[key]); return Number.isFinite(v) && v > 0 ? v : null; },
    set(key, px) { write({ ...read(), [key]: Math.round(px) }); },
    clear(key) { const all = read(); delete all[key]; write(all); },
  };
}

/**
 * Wire drag-to-expand on every `selector` card inside `root`.
 * @param opts.selector  cards that can be resized (e.g. ".ws-fieldset[open]")
 * @param opts.keyOf     (card) → the key its height is remembered under (falsy: not remembered)
 * @param opts.store     a heightStore, or null
 * @returns { apply(card) } — re-applies a card's remembered height after the card is (re)built
 */
export function wireEdgeResize(root, { selector, keyOf, store = null }) {
  const bounds = (card) => {
    const min = parseFloat(getComputedStyle(card).minHeight) || 0;
    const chrome = card.offsetHeight - card.clientHeight; // borders (no horizontal scrollbar: overflow-x is hidden)
    return { min, max: card.scrollHeight + chrome };
  };
  const setHeight = (card, px) => {
    const { min, max } = bounds(card);
    const h = clampHeight(px, min, max);
    card.style.setProperty("--ws-h", `${h}px`);
    card.classList.add("is-sized");
    return h;
  };
  const remember = (card, h) => { const key = keyOf(card); if (key) store?.set(key, h); };
  const forget = (card) => {
    card.style.removeProperty("--ws-h");
    card.classList.remove("is-sized");
    const key = keyOf(card); if (key) store?.clear(key);
  };
  const cardAt = (target) => (target instanceof Element ? target.closest(selector) : null);
  const edgeAt = (event) => {
    const card = cardAt(event.target);
    return card && event.pointerType !== "touch" && onBottomEdge(event.clientY, card.getBoundingClientRect().bottom) ? card : null;
  };

  let hot = null; // the card whose border is hovered (or being dragged)
  let dragging = false;
  const heat = (card) => {
    if (card === hot) return;
    hot?.classList.remove("is-edge");
    hot = card;
    hot?.classList.add("is-edge");
  };

  root.addEventListener("pointermove", (event) => { if (!dragging) heat(edgeAt(event)); });
  root.addEventListener("pointerleave", () => { if (!dragging) heat(null); });
  // The card's chips are draggable: stop the browser starting a native drag from the border strip.
  root.addEventListener("mousedown", (event) => { if (event.button === 0 && hot && onBottomEdge(event.clientY, hot.getBoundingClientRect().bottom)) event.preventDefault(); });

  root.addEventListener("pointerdown", (event) => {
    const card = event.button === 0 ? edgeAt(event) : null;
    if (!card) return;
    event.preventDefault();
    dragging = true;
    heat(card);
    card.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-y");
    const startY = event.clientY, startH = card.getBoundingClientRect().height;
    let last = startH;
    const move = (e) => { last = setHeight(card, startH + e.clientY - startY); };
    const up = () => {
      dragging = false;
      document.body.classList.remove("is-resizing-y");
      card.releasePointerCapture?.(event.pointerId);
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerup", up);
      card.removeEventListener("pointercancel", up);
      if (card.classList.contains("is-sized")) remember(card, last);
      if (!onBottomEdge(event.clientY, card.getBoundingClientRect().bottom, EDGE + 64)) heat(null);
    };
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerup", up);
    card.addEventListener("pointercancel", up);
  });

  root.addEventListener("dblclick", (event) => { const card = edgeAt(event); if (card) forget(card); });

  root.addEventListener("keydown", (event) => {
    const step = event.altKey && event.key === "ArrowDown" ? STEP : event.altKey && event.key === "ArrowUp" ? -STEP : 0;
    const head = event.target instanceof Element ? event.target.closest("summary") : null;
    const card = step && head ? head.closest(selector) : null;
    if (!card) return;
    event.preventDefault();
    remember(card, setHeight(card, card.getBoundingClientRect().height + step));
  });

  return {
    apply(card) {
      const key = keyOf(card), px = key ? store?.get(key) : null;
      if (px) { card.style.setProperty("--ws-h", `${px}px`); card.classList.add("is-sized"); }
    },
  };
}
