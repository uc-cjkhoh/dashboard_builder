// Worksheet font — pure, DOM-free (tests/js/worksheet-font.test.mjs). Format → Font picks the family of a
// worksheet's chart and table text from a small fixed list of system stacks (nothing is downloaded: golden
// rule 10). Each non-default choice is a CSS token in core.css; sizes are untouched (14 / 16 px scale).
import { FONTS } from "../Core/sheet-schema.js";

export const FONT_CHOICES = [["default", "Default"], ["serif", "Serif"], ["mono", "Monospace"]];
export const FONT_IDS = FONTS;

/** The CSS custom property holding a choice's stack; null for the default (the app's own `--font`). */
export const fontToken = (font) => (font !== "default" && FONTS.has(font) ? `--font-${font}` : null);
/** The class a table takes for a choice; null at the default so an untouched table is unchanged. */
export const fontClass = (font) => (font !== "default" && FONTS.has(font) ? `xt-f-${font}` : null);
