// The code editor inside the Edit SQL dialog (DOM only; the pure checks are in Core/sql-check.js). It is CodeMirror 5, self-hosted in
// Core/vendor/codemirror/ (golden rule 10: no CDN, no build step) and loaded the first time a dialog opens, so the page itself stays light:
//   • syntax highlighting (a ClickHouse flavour of CodeMirror's SQL mode)       • bracket matching, and auto-closing of brackets and quotes
//   • auto-indentation: a new line keeps its indent and adds one after "(" or a clause word; ")" lines up with its "("
//   • syntax checking: problems are underlined with a marker in the margin and a tooltip (the dialog feeds them via setProblems)
//   • auto formatting: Format (Shift+Alt+F) lays the query out with sql-formatter, loaded on first use
//   • code folding: a margin arrow folds a multi-line "( … )" or an indented block.
// If the editor files cannot be loaded, a plain text area with the same interface takes its place (everything but the extras still works).
const vendor = (file) => new URL(`../Core/vendor/codemirror/${file}`, import.meta.url).href;
const loaded = new Map();
function loadScript(file) {
  if (!loaded.has(file)) loaded.set(file, new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = vendor(file);
    s.onload = resolve;
    s.onerror = () => { loaded.delete(file); reject(new Error(`Could not load ${file}.`)); };
    document.head.append(s);
  }));
  return loaded.get(file);
}

const words = (s) => Object.fromEntries(s.split(/\s+/).filter(Boolean).map((w) => [w, true]));
const KEYWORDS = `select from where prewhere group by order having limit offset with as distinct all union intersect except join inner left right full outer cross
  semi anti any asof global array on using and or not in is null like ilike between case when then else end asc desc final sample interval over partition window
  rows range preceding following unbounded current row exists cast extract fetch first next only ties totals rollup cube fill to step grouping sets qualify values lateral if`;
const TYPES = `int8 int16 int32 int64 int128 int256 uint8 uint16 uint32 uint64 uint128 uint256 float32 float64 decimal decimal32 decimal64 decimal128 decimal256 bool boolean
  string fixedstring date date32 datetime datetime64 uuid ipv4 ipv6 array tuple map nested nullable lowcardinality enum enum8 enum16 json object aggregatefunction
  simpleaggregatefunction point ring polygon multipolygon nothing`;

const MODES = { mysql: "text/x-mysql", clickhouse: "text/x-clickhouse" }; // the SQL syntax shown: highlighting follows it, and so does Format

let mimeDone = false;
function defineClickHouseMode(CodeMirror) {
  if (mimeDone) return;
  mimeDone = true;
  // MariaDB's mode already knows backtick names, `-- ` and `#` comments and `{name:Type}` parameters; ClickHouse words replace its word lists.
  CodeMirror.defineMIME("text/x-clickhouse", Object.assign({}, CodeMirror.resolveMode("text/x-mariadb"), { keywords: words(KEYWORDS), builtin: words(TYPES), atoms: words("true false null") }));
  // Fold a "(" whose ")" is on a later line (a subquery, a long argument list); strings and comments are skipped.
  CodeMirror.registerHelper("fold", "sql-paren", (cm, start) => {
    const real = (line, ch) => { const t = cm.getTokenTypeAt(CodeMirror.Pos(line, ch + 1)); return !t || !/string|comment/.test(t); };
    const first = cm.getLine(start.line), opens = [];
    for (let i = 0; i < first.length; i++) {
      if (!real(start.line, i)) continue;
      if (first[i] === "(") opens.push(i); else if (first[i] === ")") opens.pop();
    }
    if (!opens.length) return undefined;
    const from = opens[opens.length - 1];
    let depth = 0;
    for (let l = start.line, last = Math.min(cm.lastLine(), start.line + 2000); l <= last; l++) {
      const text = cm.getLine(l);
      for (let i = l === start.line ? from : 0; i < text.length; i++) {
        if (!real(l, i)) continue;
        if (text[i] === "(") depth++;
        else if (text[i] === ")" && --depth === 0) return l > start.line ? { from: CodeMirror.Pos(start.line, from + 1), to: CodeMirror.Pos(l, i) } : undefined;
      }
    }
    return undefined;
  });
}

/** Load the editor files once; rejects when they can't be fetched. */
export async function loadEditor() {
  await loadScript("codemirror-sql.min.js");
  defineClickHouseMode(window.CodeMirror);
  return window.CodeMirror;
}

async function loadFormatter() { await loadScript("sql-formatter.min.js"); return window.sqlFormatter; }

/** A clause word or an opening bracket at the end of a line: the next line is indented under it. */
export const opensBlock = (before) => /[([]$/.test(before) || /(^|\s)(select|from|where|prewhere|having|with|on|using|(group|order|partition) by|limit)$/i.test(before);

/**
 * Mount an editor in `host`.
 * @param {HTMLElement} host
 * @param {{ value: string, dialect?: "mysql"|"clickhouse", onChange: (text: string) => void, onSubmit: () => void, onNotice: (text: string) => void, label: string }} o
 * @returns {Promise<{ getValue(): string, setValue(text: string): void, setDialect(d: "mysql"|"clickhouse"): void, setReadOnly(on: boolean): void, focus(): void, setProblems(list: {from:{line:number,ch:number},to:{line:number,ch:number},message:string}[]): void,
 *   format(): Promise<void>, rich: boolean, destroy(): void }>}
 */
export async function mountEditor(host, o) {
  let CodeMirror;
  try { CodeMirror = await loadEditor(); } catch { return plainEditor(host, o); }
  let tabMovesFocus = false, problems = [], dialect = o.dialect ?? "clickhouse";
  const cm = CodeMirror(host, {
    value: o.value, mode: MODES[dialect], lineNumbers: true, indentUnit: 2, tabSize: 2, indentWithTabs: false, smartIndent: true,
    matchBrackets: true, autoCloseBrackets: { pairs: "()[]''\"\"``", closeBefore: ")]}'\":;,` \n\t", explode: "()[]" }, styleActiveLine: true,
    foldGutter: { rangeFinder: CodeMirror.fold.combine(CodeMirror.fold["sql-paren"], CodeMirror.fold.indent) },
    gutters: ["CodeMirror-lint-markers", "CodeMirror-linenumbers", "CodeMirror-foldgutter"],
    lint: { getAnnotations: () => problems, async: false, lintOnChange: false, tooltips: true, selfContain: true }, // selfContain: the tooltip stays inside the (modal) dialog
    extraKeys: {
      "Ctrl-Enter": () => o.onSubmit(), "Cmd-Enter": () => o.onSubmit(),
      "Shift-Alt-F": () => { format(); },
      // CodeMirror's own Esc (back to one selection) swallows the key, so the dialog never heard it: with several cursors Esc
      // still does that; otherwise it asks the dialog to close (o.onEscape), as Esc does everywhere else.
      Esc: (c) => { if (c.listSelections().length > 1) c.execCommand("singleSelection"); else o.onEscape?.(); },
      "Ctrl-M": () => { tabMovesFocus = !tabMovesFocus; o.onNotice(tabMovesFocus ? "Tab now moves focus out of the editor. Ctrl+M switches it back." : "Tab indents again."); },
      Tab: (c) => (tabMovesFocus ? CodeMirror.Pass : c.somethingSelected() ? c.indentSelection("add") : c.execCommand("insertSoftTab")),
      "Shift-Tab": (c) => (tabMovesFocus ? CodeMirror.Pass : c.indentSelection("subtract")),
      Enter: (c) => {
        if (c.somethingSelected()) return CodeMirror.Pass;
        const at = c.getCursor(), line = c.getLine(at.line);
        if (/^(\(\)|\[\])$/.test(line.slice(at.ch - 1, at.ch + 1))) return CodeMirror.Pass; // between a pair: closebrackets opens it out
        const before = line.slice(0, at.ch).replace(/\s*(--|#).*$/, "").trimEnd();
        const indentOf = (text) => /^\s*/.exec(text)[0].length;
        c.execCommand("newlineAndIndent"); // CodeMirror's SQL mode already indents inside "(": add one only where it did not
        if (opensBlock(before) && indentOf(c.getLine(c.getCursor().line)) <= indentOf(line)) c.execCommand("indentMore");
        return undefined;
      },
    },
  });
  cm.getInputField().setAttribute("aria-label", o.label);
  cm.getInputField().setAttribute("aria-describedby", "sql-editor-help");
  cm.on("change", () => o.onChange(cm.getValue()));
  // A ")" typed at the start of a line lines up with the line holding its "(".
  cm.on("inputRead", (c, change) => {
    if (change.text[0] !== ")") return;
    const at = c.getCursor(), line = c.getLine(at.line);
    if (line.slice(0, at.ch - 1).trim() !== "") return;
    try {
      const m = c.findMatchingBracket(CodeMirror.Pos(at.line, at.ch), { strict: true }); // { match: true, to: the "(" } when it has one
      const indentOf = (text) => /^\s*/.exec(text)[0].length;
      if (m?.match && m.to) c.indentLine(at.line, indentOf(c.getLine(m.to.line)) - indentOf(line)); // a number is added to the line's own indent
    } catch { /* an odd line just keeps its indent */ }
  });
  const ro = new ResizeObserver(() => cm.refresh());
  ro.observe(host);

  async function format() {
    try {
      const f = await loadFormatter();
      const out = f.format(cm.getValue(), { language: dialect, tabWidth: 2, keywordCase: "preserve", dataTypeCase: "preserve", functionCase: "preserve" }); // case is kept: ClickHouse names are case-sensitive
      if (out.trimEnd() === cm.getValue().trimEnd()) { o.onNotice("Already formatted."); return; }
      const last = cm.lastLine();
      cm.replaceRange(out.trimEnd(), CodeMirror.Pos(0, 0), CodeMirror.Pos(last, cm.getLine(last).length)); // a replace, so Ctrl+Z undoes it
      o.onNotice("Formatted. Ctrl+Z undoes it.");
    } catch (err) {
      const text = String(err?.message ?? err).split("\n")[0].replace(/^Parse error:?\s*/i, "");
      o.onNotice(`Can't format yet: ${text}`);
    }
  }

  return {
    rich: true,
    getValue: () => cm.getValue(),
    setValue: (text) => { cm.setValue(text); cm.clearHistory(); },
    setDialect: (d) => { dialect = d; cm.setOption("mode", MODES[d]); },
    setReadOnly: (on) => cm.setOption("readOnly", on ? "nocursor" : false), // while a conversion is under way, so typing can't be overwritten by its result
    focus: () => { cm.refresh(); cm.focus(); cm.setCursor(CodeMirror.Pos(0, 0)); },
    setProblems(list) { problems = list.map((p) => ({ from: p.from, to: p.to, message: p.message, severity: "error" })); cm.performLint(); },
    format,
    destroy: () => { ro.disconnect(); },
  };
}

/** The same interface over a plain text area: no highlighting, folding, checks or formatting. */
function plainEditor(host, o) {
  const text = document.createElement("textarea");
  text.className = "input sql-editor__plain"; text.value = o.value; text.spellcheck = false;
  text.setAttribute("aria-label", o.label); text.setAttribute("autocapitalize", "off");
  text.addEventListener("input", () => o.onChange(text.value));
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); o.onSubmit(); } });
  host.append(text);
  return {
    rich: false,
    getValue: () => text.value,
    setValue: (v) => { text.value = v; },
    setDialect() {},
    setReadOnly: (on) => { text.readOnly = on; },
    focus: () => { text.focus(); text.setSelectionRange(0, 0); },
    setProblems() {},
    format: async () => { o.onNotice("The code editor could not be loaded, so Format is not available."); },
    destroy() {},
  };
}
