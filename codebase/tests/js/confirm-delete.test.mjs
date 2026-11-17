import { test } from "node:test";
import assert from "node:assert/strict";

// A just-enough DOM for confirmDialog: elements record their text and handlers; the dialog is "opened" by openDialog's fallback.
function fakeEl(tag) {
  const handlers = {};
  const el = { tag, className: "", textContent: "", children: [], handlers, open: false, type: "",
    append(...c) { this.children.push(...c); }, remove() { this.removed = true; },
    addEventListener(t, fn) { handlers[t] = fn; }, setAttribute() {}, showModal() { this.open = true; }, close() { this.open = false; } };
  return el;
}
const dialogs = [];
globalThis.document = { createElement: (tag) => { const e = fakeEl(tag); if (tag === "dialog") dialogs.push(e); return e; }, body: fakeEl("body") };
const { confirmDeleteTwice } = await import("../../src/DashboardBuilder/Features/Core/ui.js");

const buttons = (dlg) => dlg.children.at(-1).children; // the foot: [Cancel, confirm]
const body = (dlg) => dlg.children[0].textContent;
const tick = () => new Promise((r) => setTimeout(r, 0));

test("both confirmations → true; the second names the item and says it can't be undone", async () => {
  dialogs.length = 0;
  const p = confirmDeleteTwice("Delete the thing?", "“thing”");
  assert.equal(dialogs.length, 1);
  assert.equal(body(dialogs[0]), "Delete the thing?");
  buttons(dialogs[0])[1].handlers.click();
  await tick();
  assert.equal(dialogs.length, 2);
  assert.match(body(dialogs[1]), /Really delete “thing”\? This can't be undone\./);
  assert.equal(buttons(dialogs[1])[1].textContent, "Delete for good");
  buttons(dialogs[1])[1].handlers.click();
  assert.equal(await p, true);
});

test("cancelling the first dialog stops there: no second dialog, false", async () => {
  dialogs.length = 0;
  const p = confirmDeleteTwice("Delete?", "x");
  buttons(dialogs[0])[0].handlers.click();
  assert.equal(await p, false);
  assert.equal(dialogs.length, 1);
});

test("cancelling the second dialog (button or Esc) → false", async () => {
  for (const how of ["button", "escape"]) {
    dialogs.length = 0;
    const p = confirmDeleteTwice("Remove?", "x", { confirmText: "Remove" });
    buttons(dialogs[0])[1].handlers.click();
    await tick();
    assert.match(body(dialogs[1]), /^Really remove x\?/);
    if (how === "button") buttons(dialogs[1])[0].handlers.click();
    else dialogs[1].handlers.cancel({ preventDefault() {} });
    assert.equal(await p, false);
  }
});
