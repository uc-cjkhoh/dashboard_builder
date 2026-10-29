// Entity card width follows its `db.table` name: the name's text width plus the head's fixed parts
// (collapse + remove buttons, gaps, padding), held between the card's min and max. Pure: unit-tested
// in tests/js/card-width.test.mjs. The limits are CSS tokens on `.entity` (canvas.css), read by canvas.js.
export const CARD_CHROME = 112; // 2 x 16 icon glyphs + paddings + gaps around the title, px

/** The card width for a title `textPx` wide, and whether the title no longer fits (it then ellipsises). */
export function entityWidth(textPx, { min, max }) {
  const hi = Math.max(min, max);
  const text = Number.isFinite(textPx) && textPx > 0 ? Math.ceil(textPx) : Number.isNaN(textPx) || textPx < 0 || textPx == null ? 0 : hi; // Infinity -> max
  const want = text + CARD_CHROME;
  return { width: Math.min(hi, Math.max(min, want)), truncated: want > hi };
}
