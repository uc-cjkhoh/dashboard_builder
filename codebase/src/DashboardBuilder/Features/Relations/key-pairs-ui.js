import { makeButton } from "../Core/ui.js";
import { icon } from "../Core/icons.js";
import { suggestPairs, addPair, pairText, MAX_EXTRA_PAIRS } from "./key-pairs.js";
import { kindLabel } from "./relation-rules.js";

// The relationship dialog's "Also match on" section: a compound key's extra column pairs. Native selects and buttons, so it is
// fully keyboard-operable (Tab, arrows in a select, Enter on Add). Rules and suggestions live in key-pairs.js (pure).
// All text via textContent; state shown with `hidden`.

/**
 * @param {{ fromTable:string, toTable:string, fromCols:Array, toCols:Array, first:{from:string,to:string}, pairs:Array,
 *           used:{from:string[],to:string[]}, onChange:(pairs:Array)=>void }} o
 *  `used` = columns of the two tables that other relationships hold; `first` is this relationship's first pair.
 */
export function buildKeyPairs({ fromTable, toTable, fromCols, toCols, first, pairs, used, onChange }) {
  let list = pairs.map((p) => ({ ...p }));
  const root = document.createElement("fieldset");
  root.className = "key-pairs";
  const legend = document.createElement("legend");
  legend.textContent = "Also match on";
  const chips = document.createElement("ul");
  chips.className = "key-pairs__list";
  const suggest = document.createElement("div");
  suggest.className = "key-pairs__suggest";
  const add = document.createElement("div");
  add.className = "key-pairs__add";
  const pickFrom = document.createElement("select"), pickTo = document.createElement("select");
  pickFrom.className = pickTo.className = "select key-pairs__select";
  pickFrom.setAttribute("aria-label", `Column of ${fromTable}`);
  pickTo.setAttribute("aria-label", `Column of ${toTable}`);
  const addBtn = makeButton("Add pair", "btn");
  addBtn.type = "button";
  add.append(pickFrom, pickTo, addBtn);
  const problem = document.createElement("p");
  problem.className = "key-pairs__problem";
  problem.setAttribute("role", "status");
  root.append(legend, chips, suggest, add, problem);

  const usedSides = () => ({ from: [...used.from, first.from, ...list.map((p) => p.from)], to: [...used.to, first.to, ...list.map((p) => p.to)] });
  const fill = (select, cols, taken) => {
    const keep = select.value;
    select.replaceChildren(new Option("Pick a column", ""));
    for (const c of cols.filter((x) => !taken.includes(x.name))) select.append(new Option(`${c.name} (${kindLabel(c.category)})`, c.name));
    select.value = [...select.options].some((o) => o.value === keep) ? keep : "";
  };
  function render(say = "") {
    const u = usedSides();
    chips.replaceChildren(...list.map((p, i) => {
      const li = document.createElement("li");
      li.className = "key-pairs__item";
      const t = document.createElement("span");
      t.textContent = pairText(p);
      const rm = makeButton("", "btn");
      rm.type = "button"; rm.append(icon("close", { size: 14 }));
      rm.setAttribute("aria-label", `Remove ${pairText(p)}`);
      rm.addEventListener("click", () => { list.splice(i, 1); onChange(list.map((x) => ({ ...x }))); render(); });
      li.append(t, rm);
      return li;
    }));
    chips.hidden = list.length === 0;
    const room = MAX_EXTRA_PAIRS - list.length;
    const sug = room > 0 ? suggestPairs(fromCols, toCols, u, room) : [];
    suggest.replaceChildren(...sug.map((p) => {
      const b = makeButton("", "btn key-pairs__suggestion");
      b.type = "button";
      b.append(icon("plus", { size: 14 }), document.createTextNode(` Add ${pairText(p)}`));
      b.addEventListener("click", () => commit(p.from, p.to));
      return b;
    }));
    suggest.hidden = sug.length === 0;
    fill(pickFrom, fromCols, u.from); fill(pickTo, toCols, u.to);
    add.hidden = room <= 0;
    problem.replaceChildren(...(say ? [icon("warning", { size: 14 }), document.createTextNode(` ${say}`)] : []));
    problem.hidden = !say;
  }
  function commit(from, to) {
    const r = addPair(list, from, to, { fromCols, toCols, used: { from: [...used.from, first.from], to: [...used.to, first.to] } });
    if (!r.ok) { render(r.problem); return; }
    list = r.pairs;
    onChange(list.map((x) => ({ ...x })));
    render();
  }
  addBtn.addEventListener("click", () => commit(pickFrom.value, pickTo.value));
  render();
  return root;
}
