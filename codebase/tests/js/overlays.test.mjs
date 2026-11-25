// dismissOverlays closes whatever floats over the page when the session ends (D163): each dialog is asked through its own cancel
// handler first (topmost first), a dialog whose handler opens another is looked at again, and whatever refuses is closed outright.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dismissOverlays } from "../../src/DashboardBuilder/Features/Core/overlays.js";

class FakeDialog extends EventTarget {
  constructor(name, log) { super(); this.name = name; this.open = true; this.log = log; }
  close() { this.open = false; this.log.push(`close:${this.name}`); }
}
const world = () => {
  const log = [], dialogs = [];
  const root = {
    menu: false,
    querySelectorAll: (sel) => (sel === "dialog[open]" ? dialogs.filter((d) => d.open) : []),
    querySelector: (sel) => (sel === ".ctx-menu" && root.menu ? {} : null),
  };
  const dialog = (name, onCancel) => {
    const d = new FakeDialog(name, log);
    d.addEventListener("cancel", (e) => { log.push(`cancel:${name}`); onCancel?.(e, d); });
    dialogs.push(d);
    return d;
  };
  return { root, dialogs, log, dialog };
};

test("a dialog is closed through its own cancel handler, so its cleanup runs", () => {
  const w = world();
  let cleaned = false;
  w.dialog("memcol", (e, d) => { e.preventDefault(); cleaned = true; d.close(); });
  assert.equal(dismissOverlays(w.root), 1);
  assert.equal(cleaned, true);
  assert.deepEqual(w.dialogs.filter((d) => d.open), []);
});

test("a dialog with no cancel handler is closed outright", () => {
  const w = world();
  const d = new FakeDialog("bare", w.log); w.dialogs.push(d);
  assert.equal(dismissOverlays(w.root), 1);
  assert.equal(d.open, false);
});

test("the topmost dialog is asked first", () => {
  const w = world();
  w.dialog("below", (e, d) => d.close());
  w.dialog("top", (e, d) => d.close());
  dismissOverlays(w.root);
  assert.deepEqual(w.log.filter((l) => l.startsWith("cancel:")), ["cancel:top", "cancel:below"]);
});

test("a dialog whose close opens a 'Discard changes?' confirm: the confirm is cancelled, and the dialog still ends up closed", () => {
  const w = world();
  let asking = false;
  w.dialog("calc", (e, d) => {
    if (asking) return;                         // like requestClose: one question at a time
    asking = true;
    w.dialog("discard?", (ev, c) => c.close()); // the confirm is created and opened synchronously
  });
  assert.equal(dismissOverlays(w.root), 2);
  assert.deepEqual(w.dialogs.filter((d) => d.open), [], "nothing left open");
});

test("a dialog that keeps itself open is closed outright after the passes", () => {
  const w = world();
  const stubborn = w.dialog("stubborn", (e) => e.preventDefault());
  assert.equal(dismissOverlays(w.root), 1);
  assert.equal(stubborn.open, false);
  assert.equal(w.log.filter((l) => l === "cancel:stubborn").length, 3, "asked on each of the three passes, then closed");
});

test("an open context menu counts, and with nothing open the count is 0", () => {
  const w = world();
  assert.equal(dismissOverlays(w.root), 0);
  w.root.menu = true;
  assert.equal(dismissOverlays(w.root), 1);
});
