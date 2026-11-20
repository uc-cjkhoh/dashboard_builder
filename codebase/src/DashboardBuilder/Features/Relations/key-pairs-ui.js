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
  pickFrom.className = pickTo.className = "select select--menu key-pairs__select"; // select--menu: the open list is drawn like the app's menus (core.css)
  pickTo.classList.add("key-pairs__select--to"); // its open list lines up with the select's right edge, so it grows leftwards, never over the suggestion panel
  // Customizable select (`.select--menu`): an explicit button holding the selected option's content, which is what lets a long name end in an
  // ellipsis. A browser without it ignores the button and draws its own select.
  const face = () => { const b = document.createElement("button"); b.type = "button"; b.append(document.createElement("selectedcontent")); return b; };
  pickFrom._face = face(); pickTo._face = face();
  pickFrom.setAttribute("aria-label", `Column of ${fromTable}`);
  pickTo.setAttribute("aria-label", `Column of ${toTable}`);
  const addBtn = makeButton("Add pair", "btn key-pairs__go");
  addBtn.type = "button";
  const eq = document.createElement("span");
  eq.className = "key-pairs__eq"; eq.setAttribute("aria-hidden", "true"); eq.textContent = "="; // the same sign the pair rows above use
  add.append(pickFrom, eq, pickTo, addBtn);
  const problem = document.createElement("p");
  problem.className = "key-pairs__problem";
  problem.setAttribute("role", "status");
  const full = document.createElement("p");
  full.className = "key-pairs__full";
  full.textContent = `A relationship matches on at most ${MAX_EXTRA_PAIRS + 1} pairs of columns.`; // the first pair and the extras
  full.hidden = true;
  root.append(legend, chips, suggest, add, problem, full);

  const glyph = (name) => { const g = document.createElement("span"); g.className = "key-pairs__glyph"; g.setAttribute("aria-hidden", "true"); g.append(icon(name, { size: 14 })); return g; };
  const text = (t) => { const x = document.createElement("span"); x.textContent = t; return x; };
  const usedSides = () => ({ from: [...used.from, first.from, ...list.map((p) => p.from)], to: [...used.to, first.to, ...list.map((p) => p.to)] });
  // One option = the name and, apart from it, the kind. A browser with customizable selects keeps the two apart: only the name can end in an
  // ellipsis, the kind stays whole at the right (in the closed control and in the open list). Others read it as "name (kind)". `title` gives the full text.
  const option = (value, name, kind) => {
    const o = document.createElement("option");
    o.value = value;
    const n = document.createElement("span");
    n.className = "key-pairs__col"; n.textContent = name;
    o.append(n);
    if (kind) { const k = document.createElement("span"); k.className = "key-pairs__kind"; k.textContent = `(${kind})`; o.append(" ", k); }
    o.title = kind ? `${name} (${kind})` : name;
    return o;
  };
  const fill = (select, cols, taken) => {
    const keep = select.value;
    const prompt = option("", select === pickFrom ? fromTable : toTable); // just the table's name: short, and it says which side this is (the accessible name is "Column of orders")
    prompt.hidden = true; // the closed control shows it; the open list offers columns only
    select.replaceChildren(select._face, prompt);
    for (const c of cols.filter((x) => !taken.includes(x.name))) select.append(option(c.name, c.name, kindLabel(c.category)));
    select.value = [...select.options].some((o) => o.value === keep) ? keep : "";
  };
  function render(say = "") {
    const u = usedSides();
    chips.replaceChildren(...list.map((p, i) => {
      const li = document.createElement("li");
      li.className = "key-pairs__item";
      const t = document.createElement("span");
      t.textContent = pairText(p);
      const rm = makeButton("", "iconbtn key-pairs__rm");
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
    full.hidden = room > 0; // the form and the suggestions are gone: say why, not just stop offering them
    problem.replaceChildren(...(say ? [glyph("warning"), text(say)] : []));
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
