// A tiny DOM for the render tests (no jsdom in this repo): elements with a class list, inline style, attributes, children and text, plus a
// serialiser (`html`) so two renders compare as strings. Install with `installFakeDom()` BEFORE importing a render module.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export class FakeEl {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attrs = {}; this.style = {}; this.dataset = {}; this._text = ""; this.listeners = {};
    const self = this;
    this.classList = {
      add(...c) { const s = new Set(self.classes()); for (const x of c) s.add(x); self.className = [...s].join(" "); },
      remove(...c) { self.className = self.classes().filter((x) => !c.includes(x)).join(" "); },
      contains: (c) => self.classes().includes(c),
      toggle(c, on) { const has = self.classes().includes(c); if (on ?? !has) this.add(c); else this.remove(c); },
    };
    this.className = "";
  }
  classes() { return String(this.className || "").split(/\s+/).filter(Boolean); }
  get textContent() { return this._text + this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  set textContent(t) { this._text = String(t); this.children = []; }
  append(...c) { for (const x of c) this.children.push(x); }
  replaceChildren(...c) { this.children = c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(e, fn) { (this.listeners[e] ??= []).push(fn); }
  focus() {}
  getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0 }; }
  /** Every descendant element, depth first. */
  all() { const out = []; for (const c of this.children) if (typeof c !== "string") { out.push(c, ...c.all()); } return out; }
  find(pred) { return this.all().filter(pred); }
  html() {
    const attrs = [["class", this.className], ...Object.entries(this.attrs), ...(this.colSpan ? [["colspan", this.colSpan]] : []), ...(this.rowSpan ? [["rowspan", this.rowSpan]] : []),
      ...(this.title ? [["title", this.title]] : []), ...(Object.keys(this.style).length ? [["style", Object.entries(this.style).map(([k, v]) => `${k}:${v}`).join(";")]] : [])]
      .filter(([, v]) => v !== "" && v != null).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
    return `<${this.tag}${attrs}>${esc(this._text)}${this.children.map((c) => (typeof c === "string" ? esc(c) : c.html())).join("")}</${this.tag}>`;
  }
}

export function installFakeDom({ vars = {} } = {}) {
  globalThis.document = {
    createElement: (t) => new FakeEl(t), createElementNS: (_, t) => new FakeEl(t), documentElement: {},
  };
  globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => vars[n] ?? "" });
  globalThis.requestAnimationFrame = () => 0;
  globalThis.window ??= globalThis;
}
