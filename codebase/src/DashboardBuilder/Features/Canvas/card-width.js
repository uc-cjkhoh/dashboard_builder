// Entity card width follows its `db.table` name: the name's text width plus the head's always-present parts
// (collapse + remove buttons, gaps, padding), held between the card's min and max. The optional parts (Edit SQL pencil,
// link button, "Needs a partner" button) are measured by canvas.js `fitWidth` and added to `textPx` before this is called. Pure: unit-tested
// in tests/js/card-width.test.mjs. The limits are CSS tokens on `.view--model` (canvas.css), read by canvas.js.
export const CARD_CHROME = 112; // 2 x 16 icon glyphs + paddings + gaps around the title, px

/** The card width for a title `textPx` wide, and whether the title no longer fits (it then ellipsises). */
export function entityWidth(textPx, { min, max }) {
  const hi = Math.max(min, max);
  const text = Number.isFinite(textPx) && textPx > 0 ? Math.ceil(textPx) : Number.isNaN(textPx) || textPx < 0 || textPx == null ? 0 : hi; // Infinity -> max
  const want = text + CARD_CHROME;
  return { width: Math.min(hi, Math.max(min, want)), truncated: want > hi };
}
