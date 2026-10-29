import { test } from "node:test";
import assert from "node:assert/strict";
import { validateImageFile, isImageSrc, altFromName, IMAGE_TYPES, imageChars, budgetError } from "../../src/DashboardBuilder/Features/Board/image-model.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

test("image limits", () => {
  assert.equal(LIMITS.imageBytes, 262144);
  assert.equal(LIMITS.images, 4);
  assert.equal(LIMITS.imageAlt, 120);
  assert.equal(LIMITS.imagesTotal, 2097152);
});

test("a PNG, JPEG, GIF or WebP up to the size limit is accepted and named by its file", () => {
  for (const type of IMAGE_TYPES) assert.equal(validateImageFile({ name: "logo.x", type, size: 1000 }).ok, true);
  const r = validateImageFile({ name: "Company logo.png", type: "image/png", size: LIMITS.imageBytes });
  assert.deepEqual(r, { ok: true, alt: "Company logo" });
});

test("SVG, other types, empty and oversize files are refused with a reason", () => {
  assert.match(validateImageFile({ name: "a.svg", type: "image/svg+xml", size: 10 }).error, /PNG, JPEG, GIF or WebP/);
  assert.equal(validateImageFile({ name: "a.pdf", type: "application/pdf", size: 10 }).ok, false);
  assert.equal(validateImageFile({ name: "a.png", type: "image/png", size: 0 }).ok, false);
  assert.match(validateImageFile({ name: "a.png", type: "image/png", size: LIMITS.imageBytes + 1 }).error, /256 KB/);
});

test("isImageSrc accepts only a bounded base64 raster data URL", () => {
  assert.equal(isImageSrc("data:image/png;base64,iVBORw0KGgo="), true);
  assert.equal(isImageSrc("data:image/webp;base64,AAAA"), true);
  assert.equal(isImageSrc("data:image/svg+xml;base64,AAAA"), false);
  assert.equal(isImageSrc("https://example.com/a.png"), false);
  assert.equal(isImageSrc("javascript:alert(1)"), false);
  assert.equal(isImageSrc("data:image/png;base64,AA\"onerror=x"), false);
  assert.equal(isImageSrc(null), false);
  assert.equal(isImageSrc("data:image/png;base64," + "A".repeat(Math.ceil(LIMITS.imageBytes / 3) * 4 + 2)), false);
});

test("altFromName drops the extension, trims and caps the length", () => {
  assert.equal(altFromName("photo.final.JPG"), "photo.final");
  assert.equal(altFromName("  .png"), "");
  assert.equal(altFromName("a".repeat(300) + ".png").length, LIMITS.imageAlt);
});

test("imageChars sums the picture sizes across every dashboard's widgets", () => {
  const d = (...n) => ({ widgets: n.map((k) => ({ kind: "image", src: "x".repeat(k) })).concat([{ kind: "spacer" }]) });
  assert.equal(imageChars([d(10, 20), d(5)]), 35);
  assert.equal(imageChars([]), 0);
});

test("budgetError refuses a picture that would take the workbook past 2 MB of pictures, in words", () => {
  assert.equal(budgetError(0, 1000), null);
  assert.equal(budgetError(LIMITS.imagesTotal - 1000, 1000), null);
  assert.match(budgetError(LIMITS.imagesTotal - 999, 1000), /pictures in a workbook can take at most 2 MB/i);
});
