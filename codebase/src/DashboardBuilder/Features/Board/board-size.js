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
