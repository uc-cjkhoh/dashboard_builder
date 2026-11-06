// Dashboard size — pure, DOM-free (tests/js/board-size.test.mjs). A dashboard is Automatic (null: the board fills its panel) or fixed ({ width, height } in whole pixels: the board is exactly that box, scrolling inside the panel
// when the window is smaller). Saved in workbook v2 as an optional `size` on the dashboard; absent = Automatic.
export const SIZE_LIMITS = Object.freeze({ minW: 320, maxW: 3840, minH: 240, maxH: 2400 });

/** The sizes the toolbar offers (Automatic is the null choice). */
export const SIZE_PRESETS = Object.freeze([
  { width: 800, height: 600 }, { width: 1024, height: 768 }, { width: 1280, height: 720 },
  { width: 1366, height: 768 }, { width: 1920, height: 1080 },
]);

/** A select value / label for a size: "auto" or "1280x720". */
export const sizeKey = (size) => (size ? `${size.width}x${size.height}` : "auto");
export const sizeLabel = (size) => (size ? `${size.width} × ${size.height}` : "Automatic");

/** The first thing wrong with a size, in the user's words, or null. */
export function sizeError(size) {
  if (!size || typeof size !== "object") return "A fixed size needs a width and a height.";
  const { width, height } = size;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return "The width and height are whole pixels.";
  if (width < SIZE_LIMITS.minW || width > SIZE_LIMITS.maxW) return `The width is ${SIZE_LIMITS.minW}–${SIZE_LIMITS.maxW} pixels.`;
  if (height < SIZE_LIMITS.minH || height > SIZE_LIMITS.maxH) return `The height is ${SIZE_LIMITS.minH}–${SIZE_LIMITS.maxH} pixels.`;
  return null;
}

/** Import: saved `size` → { width, height } or null (Automatic). Anything `sizeError` refuses (not an object, not whole pixels, out of range) is
 *  rejected, never clamped: the dashboard opens Automatic and the reason is pushed to `issues`. */
export function cleanSize(raw, where, issues) {
  if (raw == null) return null;
  const error = sizeError(raw);
  if (error) { issues.push(`${where}: the saved size was ignored (${error.replace(/\.$/, "")}) — the dashboard is automatic.`); return null; }
  return { width: raw.width, height: raw.height };
}

/** The saved fragment: `{ size }` for a fixed dashboard, `{}` for Automatic. */
export const savedSize = (size) => (size ? { size: { width: size.width, height: size.height } } : {});

// Range size — an Automatic dashboard may bound its board: `range` { minWidth?, maxWidth?, minHeight?, maxHeight? } (each optional, whole pixels inside
// SIZE_LIMITS, min <= max). The board is the panel's width clamped to the range; its height is the content height clamped (scrolling inside past the maximum).
// A fixed size wins over a range. Saved as an optional `range` on the dashboard.
export const RANGE_KEYS = Object.freeze(["minWidth", "maxWidth", "minHeight", "maxHeight"]);
const RANGE_LIMIT = { minWidth: ["minW", "maxW", "width"], maxWidth: ["minW", "maxW", "width"], minHeight: ["minH", "maxH", "height"], maxHeight: ["minH", "maxH", "height"] };

/** The first thing wrong with a range, in the user's words, or null. */
export function rangeError(range) {
  if (!range || typeof range !== "object" || Array.isArray(range)) return "A size range is an object.";
  let any = false;
  for (const k of Object.keys(range)) if (!RANGE_KEYS.includes(k)) return `Unknown range field "${k}".`;
  for (const k of RANGE_KEYS) {
    const v = range[k];
    if (v == null) continue;
    any = true;
    const [lo, hi, what] = RANGE_LIMIT[k];
    if (!Number.isInteger(v)) return "The range is whole pixels.";
    if (v < SIZE_LIMITS[lo] || v > SIZE_LIMITS[hi]) return `The ${what} is ${SIZE_LIMITS[lo]}–${SIZE_LIMITS[hi]} pixels.`;
  }
  if (!any) return "Set at least one limit.";
  if (range.minWidth != null && range.maxWidth != null && range.minWidth > range.maxWidth) return "The minimum width is above the maximum width.";
  if (range.minHeight != null && range.maxHeight != null && range.minHeight > range.maxHeight) return "The minimum height is above the maximum height.";
  return null;
}

/** Import: saved `range` → a clean { …limits } or null. Anything `rangeError` refuses is rejected, never clamped, with an issue. */
export function cleanRange(raw, where, issues) {
  if (raw == null) return null;
  const error = rangeError(raw);
  if (error) { issues.push(`${where}: the saved size range was ignored (${error.replace(/\.$/, "")}).`); return null; }
  const out = {};
  for (const k of RANGE_KEYS) if (raw[k] != null) out[k] = raw[k];
  return out;
}

/** The saved fragment: `{ range }` or `{}`. */
export const savedRange = (range) => (range ? { range: cleanRangeCopy(range) } : {});
function cleanRangeCopy(range) { const o = {}; for (const k of RANGE_KEYS) if (range[k] != null) o[k] = range[k]; return o; }

/** The board's width for a panel width: clamped into the range (min wins when the range is contradictory — rangeError forbids that). */
export function rangedWidth(range, panel) {
  let w = panel;
  if (range?.maxWidth != null) w = Math.min(w, range.maxWidth);
  if (range?.minWidth != null) w = Math.max(w, range.minWidth);
  return w;
}
/** The board's height for its content height: at least the minimum, at most the maximum. */
export function rangedHeight(range, content) {
  let h = content;
  if (range?.maxHeight != null) h = Math.min(h, range.maxHeight);
  if (range?.minHeight != null) h = Math.max(h, range.minHeight);
  return h;
}

/** A short label for a range, e.g. "800–1280 × 400+". */
export function rangeLabel(range) {
  if (!range) return "";
  const part = (lo, hi) => (lo != null && hi != null ? `${lo}–${hi}` : lo != null ? `${lo}+` : hi != null ? `up to ${hi}` : "any");
  return `${part(range.minWidth, range.maxWidth)} × ${part(range.minHeight, range.maxHeight)}`;
}
