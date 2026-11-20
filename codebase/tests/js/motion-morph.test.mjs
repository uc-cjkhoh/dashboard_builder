import { test } from "node:test";
import assert from "node:assert/strict";
import { morphFrame, morphIn, morphOut } from "../../src/DashboardBuilder/Features/Core/motion.js";

const dialog = { left: 340, top: 164, width: 720, height: 560 };

test("the first frame centres the dialog on the trigger and opens a trigger-sized window in its middle", () => {
  const f = morphFrame({ left: 600, top: 100, width: 24, height: 24 }, dialog);
  assert.equal(f.transform, "translate(-88px, -332px)"); // (612 - 700, 112 - 444)
  assert.equal(f.clipPath, "inset(268px 348px 268px 348px round 8px)"); // (560-24)/2, (720-24)/2
});
test("a trigger as large as the dialog opens no window insets, and a larger one never goes negative", () => {
  assert.match(morphFrame(dialog, dialog).clipPath, /^inset\(0px 0px 0px 0px/);
  assert.match(morphFrame({ left: 0, top: 0, width: 2000, height: 2000 }, dialog).clipPath, /^inset\(0px 0px 0px 0px/);
});
test("without Element.animate, or with no usable trigger box, the morph is skipped", async () => {
  assert.equal(morphIn({}, { left: 1, top: 1, width: 24, height: 24 }), null);
  const dlg = { animate() { throw new Error("must not animate"); }, children: [], getBoundingClientRect: () => dialog, style: {} };
  assert.equal(morphIn(dlg, { left: 0, top: 0, width: 0, height: 0 }), null);
  await morphOut(dlg, null);
});
