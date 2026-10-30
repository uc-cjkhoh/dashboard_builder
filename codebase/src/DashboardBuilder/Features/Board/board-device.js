// Device preview — pure, DOM-free (tests/js/board-device.test.mjs). The toolbar previews the board at a phone, tablet or desktop
// width. Desktop is the normal board (fills its panel, or the fixed size); tablet and phone draw the same widgets in a box of that
// width, so board-layout.js decides the grid or the stack exactly as it would on a real device. Transient: never saved.
export const DEVICES = Object.freeze([
  { key: "desktop", label: "Desktop", width: null },
  { key: "tablet", label: "Tablet", width: 768 },
  { key: "phone", label: "Phone", width: 390 },
]);

/** The device for a key; an unknown key is Desktop. */
export const deviceOf = (key) => DEVICES.find((d) => d.key === key) ?? DEVICES[0];

/** The preview box width in px, or null for Desktop; never wider than the panel (`available`). */
export function previewWidth(key, available) {
  const { width } = deviceOf(key);
  return width == null ? null : Math.max(0, Math.min(width, available));
}
