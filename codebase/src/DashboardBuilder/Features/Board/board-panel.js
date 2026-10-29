import { icon } from "../Core/icons.js";

// The board's side panel: the workbook's worksheets, each with an Add button, and Add text. It re-renders only when
// the list of worksheets (ids + names) changes, so a button never loses focus when a widget is added.
/** The drag payload's MIME type: a worksheet row dragged onto the canvas carries its worksheet id. */
export const SHEET_MIME = "application/x-dashboardbuilder-worksheet";
const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

function addButton(label, text, onClick, cls = "btn board-panel__add") {
  const b = h("button", cls);
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.append(icon("plus", { size: 14 }), h("span", null, text));
  b.addEventListener("click", onClick);
  return b;
}

/** `handlers` = { onAddSheet(sheetId), onAddText(), onAddImage(file), onAddSpacer(), onDragStart(sheetId), onDragEnd() }. Returns { render(worksheets) }. */
export function createPanel(root, handlers) {
  let shown = null;
  return {
    render(worksheets) {
      const sig = worksheets.map((w) => `${w.id}\u0000${w.name}`).join("\u0001");
      if (sig === shown) return;
      shown = sig;
      root.replaceChildren();
      root.append(h("h3", "board-panel__title", "Worksheets"));
      if (worksheets.length) root.append(h("p", "board-panel__hint", "Drag a worksheet onto the canvas, or press Add."));
      if (!worksheets.length) {
        root.append(h("p", "board-panel__empty", "No worksheets yet — create one with + in the tab strip, then add it here."));
      } else {
        const list = h("ul", "board-panel__list");
        for (const w of worksheets) {
          const li = h("li", "board-panel__item");
          li.dataset.sheetId = w.id;
          li.draggable = true; // drag onto the canvas to drop it at that cell; the Add button is the keyboard path
          li.addEventListener("dragstart", (ev) => {
            ev.dataTransfer?.setData(SHEET_MIME, w.id);
            if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
            handlers.onDragStart(w.id);
          });
          li.addEventListener("dragend", () => handlers.onDragEnd());
          const name = h("span", "board-panel__name", w.name);
          name.title = w.name;
          li.append(icon("chart-bar", { size: 14 }), name, addButton(`Add the worksheet “${w.name}” to the dashboard`, "Add", () => handlers.onAddSheet(w.id)));
          list.append(li);
        }
        root.append(list);
      }
      root.append(h("h3", "board-panel__title", "Text"), addButton("Add a text block to the dashboard", "Add text", () => handlers.onAddText(), "btn board-panel__add board-panel__add-text"));
      const picker = h("input"); // the file picker behind Add image; PNG, JPEG, GIF or WebP, checked in board.js
      picker.type = "file";
      picker.accept = "image/png,image/jpeg,image/gif,image/webp";
      picker.hidden = true;
      picker.setAttribute("aria-label", "Choose an image file");
      picker.addEventListener("change", () => { const f = picker.files?.[0]; picker.value = ""; if (f) handlers.onAddImage(f); });
      root.append(h("h3", "board-panel__title", "Image"), addButton("Add an image to the dashboard", "Add image", () => picker.click(), "btn board-panel__add board-panel__add-image"), picker);
      root.append(h("h3", "board-panel__title", "Spacer"), addButton("Add a blank spacer to the dashboard", "Add spacer", () => handlers.onAddSpacer(), "btn board-panel__add board-panel__add-spacer"));
    },
  };
}
