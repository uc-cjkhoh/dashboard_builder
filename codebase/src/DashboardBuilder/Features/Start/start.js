import { loadWorkbooks, saveWorkbooks } from "./start-store.js";
import { forgetWorkbook, workbookKey, ago, describe } from "./start-model.js";
import { icon } from "../Core/icons.js";

// The start screen sits over the Data Source view while no server is connected. It lists the workbooks this
// browser has autosaved (metadata only — see start-model.js). Picking one refills the connection form with that
// server; once the user connects, Workbook/workbook.js restores the saved workbook as usual.
export function initStart() {
  const root = document.getElementById("start-screen");
  if (!root) return;
  const list = document.getElementById("start-recent"), block = document.getElementById("start-recent-block");

  function render() {
    const items = loadWorkbooks();
    block.hidden = items.length === 0;
    list.replaceChildren(...items.map((e) => {
      const li = document.createElement("li"); li.className = "start__item";
      const pick = document.createElement("button"); pick.type = "button"; pick.className = "start__pick";
      pick.title = `${e.host} · ${e.user} · :${e.port}`;
      const host = document.createElement("span"); host.className = "start__host"; host.textContent = `${e.host} · ${e.user}`;
      const meta = document.createElement("span"); meta.className = "start__meta"; meta.textContent = `${describe(e)} · ${ago(e.savedAt, Date.now())}`;
      pick.append(host, meta);
      pick.addEventListener("click", () => document.dispatchEvent(new CustomEvent("connection:prefill", { detail: e })));
      const rm = document.createElement("button"); rm.type = "button"; rm.className = "iconbtn start__remove";
      rm.setAttribute("aria-label", `Remove ${e.host} from recent workbooks`); rm.title = "Remove from recent";
      rm.append(icon("close"));
      rm.addEventListener("click", () => { saveWorkbooks(forgetWorkbook(items, workbookKey(e))); render(); });
      li.append(pick, rm);
      return li;
    }));
  }

  document.getElementById("start-connect")?.addEventListener("click", () => document.getElementById("conn-host")?.focus());
  document.addEventListener("connection:changed", (ev) => {
    const connected = Boolean(ev.detail?.connected);
    root.hidden = connected;
    if (!connected) render();
  });
  render();
}
