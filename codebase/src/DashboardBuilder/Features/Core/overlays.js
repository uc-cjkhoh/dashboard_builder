// Everything that floats over the page — modal dialogs, a context menu, the hover tip — and belongs to the workspace behind it.
// When the session ends (a redeploy, a restart, the 2 h idle timeout, Disconnect) the workspace is cleared and only the connect card is
// left, so these must go too: they are appended to <body>, so clearing the tabs and cards does not take them along (D163).
import { closeContextMenu } from "./menu.js";
import { hideHoverTip } from "./hover-tip.js";

const PASSES = 3; // a dialog's own close can open another (a "Discard your changes?" confirm): look again, a few times, then stop asking

/** Closes every open dialog (topmost first), the context menu and the hover tip. Returns how many overlays were closed.
 *  A dialog is asked first, through its own `cancel` handler (the one Esc uses), so it runs its own cleanup: promises settle, requests
 *  abort, `onClose` callbacks run. Whatever refuses (no handler, or a handler that keeps it open) is closed outright. */
export function dismissOverlays(root = document) {
  const open = () => [...root.querySelectorAll("dialog[open]")].reverse(); // last appended = on top
  let closed = 0;
  if (root.querySelector(".ctx-menu")) { closeContextMenu(); closed++; } // first: a menu can live inside an open dialog
  const seen = new Set();
  for (let pass = 0; pass < PASSES; pass++) {
    const dialogs = open();
    if (!dialogs.length) break;
    for (const dlg of dialogs) {
      if (!dlg.open) continue;
      seen.add(dlg);
      dlg.dispatchEvent(new Event("cancel", { cancelable: true }));
    }
  }
  for (const dlg of open()) { seen.add(dlg); try { dlg.close(); } catch { dlg.open = false; } }
  hideHoverTip();
  return closed + seen.size;
}
