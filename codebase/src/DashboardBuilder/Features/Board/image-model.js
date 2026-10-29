// An image widget's picture — pure (tests/js/image-model.test.mjs). The picture lives in the workbook as a base64 data URL, so it
// is self-contained, self-hosted and never reaches the server (golden rules 4 and 10). Raster types only (no SVG: a vector file can
// carry script), at most LIMITS.imageBytes per file and LIMITS.images per dashboard; there is no remote-URL image.
import { LIMITS } from "../Core/validate.js";

export const IMAGE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const SRC = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_SRC = Math.ceil(LIMITS.imageBytes / 3) * 4 + 23; // the base64 of the largest file plus the longest "data:image/jpeg;base64," prefix

/** A picked file { name, type, size } → { ok: true, alt } (alt = the file name without its extension) or { ok: false, error }. */
export function validateImageFile({ name, type, size }) {
  if (!IMAGE_TYPES.includes(type)) return { ok: false, error: "An image has to be a PNG, JPEG, GIF or WebP file." };
  if (!(size > 0)) return { ok: false, error: "That image file is empty." };
  if (size > LIMITS.imageBytes) return { ok: false, error: `An image can be at most ${LIMITS.imageBytes / 1024} KB.` };
  return { ok: true, alt: altFromName(name) };
}

/** Is `src` a bounded base64 raster data URL? The only source an image widget may have. */
export const isImageSrc = (src) => typeof src === "string" && src.length <= MAX_SRC && SRC.test(src);

/** The file name without its last extension, trimmed, at most LIMITS.imageAlt characters. */
export const altFromName = (name) => String(name ?? "").replace(/\.[^.]*$/, "").trim().slice(0, LIMITS.imageAlt);
