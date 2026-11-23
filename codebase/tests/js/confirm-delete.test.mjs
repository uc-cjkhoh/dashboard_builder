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
const { confirmDestructive } = await import("../../src/DashboardBuilder/Features/Core/ui.js");

const buttons = (dlg) => dlg.children.at(-1).children; // the foot: [Cancel, confirm]
const body = (dlg) => dlg.children[0].textContent;

test("one confirmation → true; the one dialog carries the message and says it can't be undone", async () => {
  dialogs.length = 0;
  const p = confirmDestructive("Delete the thing?");
  assert.equal(dialogs.length, 1);
  assert.equal(body(dialogs[0]), "Delete the thing? This can't be undone.");
  assert.equal(buttons(dialogs[0])[1].textContent, "Delete");
  buttons(dialogs[0])[1].handlers.click();
  assert.equal(await p, true);
  assert.equal(dialogs.length, 1, "no second dialog follows");
});

test("the confirm button takes its label from confirmText", async () => {
  dialogs.length = 0;
  const p = confirmDestructive("Remove x?", { confirmText: "Remove" });
  assert.equal(buttons(dialogs[0])[1].textContent, "Remove");
  buttons(dialogs[0])[1].handlers.click();
  assert.equal(await p, true);
});

test("Cancel or Esc → false", async () => {
  for (const how of ["button", "escape"]) {
    dialogs.length = 0;
    const p = confirmDestructive("Remove?", { confirmText: "Remove" });
    if (how === "button") buttons(dialogs[0])[0].handlers.click();
    else dialogs[0].handlers.cancel({ preventDefault() {} });
    assert.equal(await p, false);
    assert.equal(dialogs.length, 1);
  }
});
