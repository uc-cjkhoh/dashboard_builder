// Entity card width follows its `db.table` name: the name's text width plus the head's always-present parts
// (collapse + remove buttons, gaps, padding), held between the card's min and max. The other head parts (the ☰ actions button,
// "Needs a partner" button) are measured by canvas.js `fitWidth` and added to `textPx` before this is called. Pure: unit-tested
// in tests/js/card-width.test.mjs. The limits are CSS tokens on `.view--model` (canvas.css), read by canvas.js.
export const CARD_CHROME = 112; // 2 x 16 icon glyphs + paddings + gaps around the title, px
// A column row's own chrome, so the longest name and the type column both fit: the card's 2px border + the list's scrollbar gutter +
// the row's 16px left padding and its right padding (16px minus the scrollbar, so the type text still ends on the 16px gutter) + a gap before
// the type (8px) and, on a table card, the 32px Profile button and its gap (8px). The scrollbar's width cancels out while it is 16px or less
// (the usual 8-10px, or 0 for an overlay scrollbar): ROW_CHROME is that case, measured at 10px.
export const SCROLLBAR_W = 10; // the fallback when the browser's real scrollbar width is not measured (canvas.js measureScrollbar)
export const ROW_CHROME = 82, ROW_CHROME_NO_PROFILE = 42;

/** The row chrome for a scrollbar `sbPx` wide: constant up to 16px, then the row can no longer give up padding and the card grows by the excess. */
function rowChrome(profile, sbPx) {
  const sb = Number.isFinite(sbPx) && sbPx >= 0 ? sbPx : SCROLLBAR_W;
  return (profile ? ROW_CHROME : ROW_CHROME_NO_PROFILE) + Math.max(0, sb - 16);
}

/** The card width a column list needs: its longest name and its type column (both px) plus the row chrome. 0 when there are no rows. */
export function rowsWidth(namePx, typePx, { profile = true, scrollbar = SCROLLBAR_W } = {}) {
  const n = Number.isFinite(namePx) && namePx > 0 ? namePx : 0, t = Number.isFinite(typePx) && typePx > 0 ? typePx : 0;
  return n + t > 0 ? Math.ceil(n + t) + rowChrome(profile, scrollbar) : 0;
}

/** The card width for a title `textPx` wide (and, when given, the `rowsPx` its column rows need), and whether the title no longer fits (it then ellipsises). */
export function entityWidth(textPx, { min, max }, rowsPx = 0) {
  const hi = Math.max(min, max);
  const text = Number.isFinite(textPx) && textPx > 0 ? Math.ceil(textPx) : Number.isNaN(textPx) || textPx < 0 || textPx == null ? 0 : hi; // Infinity -> max
  const want = text + CARD_CHROME;
  const rows = Number.isFinite(rowsPx) && rowsPx > 0 ? Math.ceil(rowsPx) : 0; // rows that no longer fit only ellipsise the name; they never cap the title
  return { width: Math.min(hi, Math.max(min, want, rows)), truncated: want > hi };
}
