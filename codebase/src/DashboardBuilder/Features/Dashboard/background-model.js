// Worksheet background — pure, DOM-free (tests/js/worksheet-background.test.mjs). Format → Background shades the
// area behind a worksheet's chart or table with a palette surface token (dashboard.css), never a free colour.
import { BACKGROUNDS } from "../Core/sheet-schema.js";

export const BACKGROUND_CHOICES = [["none", "None"], ["subtle", "Subtle"], ["muted", "Muted"]];

/** The class the worksheet's container takes; null at the default so an untouched worksheet is unchanged. */
export const backgroundClass = (bg) => (bg !== "none" && BACKGROUNDS.has(bg) ? `ws-bg-${bg}` : null);
