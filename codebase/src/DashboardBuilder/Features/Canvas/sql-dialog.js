// The "Edit SQL" dialog of a Data Source card (DOM only; rules in Core/source-model.js, instant checks in Core/sql-check.js, the editor in
// sql-editor.js, server checks in ClickHouse/CustomSql.cs, the translator in ClickHouse/SqlTranslator.cs).
// Two syntaxes, chosen in the footer: MySQL (the default, for people who know it) and ClickHouse (what the database speaks). The card always runs
// ClickHouse SQL: in MySQL mode the text is translated on the way (D106), and a read-only "ClickHouse SQL that will run" panel shows the result.
// While you type, the instant checks underline mistakes; once those are clean, the server describes the query (debounced) and says whether
// ClickHouse accepts it and how many columns it returns. Save applies the change; until it works nothing on the card changes.
import { icon } from "../Core/icons.js";
import { sqlProblem } from "../Core/source-model.js";
import { checkSql, posOf, serverErrorPos } from "../Core/sql-check.js";
import { meaningKept } from "../Core/sql-roundtrip.js";
import { makeButton, openDialog, closeDialog, confirmDestructive } from "../Core/ui.js";
import { mountEditor } from "./sql-editor.js";

let seq = 0;
let opening = false; // set until the dialog is in the page (the saved query may be decided first), then the dialog itself says one is open
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const CHECK_DELAY_MS = 800; // after the last keystroke, before the server is asked (a query that has just opened is asked at once)
const OPENING = "Opening your query…";
/** What a saved ClickHouse query opened as (D106), kept for the page's life: deciding takes two translations and four ClickHouse calls, and the answer for the
 *  same text does not change. Only a decided answer is kept, never a failure. Key: table name + ClickHouse text. */
const openedAs = new Map();
const columnsText = (n) => `Valid query · ${n} column${n === 1 ? "" : "s"}`;
const DIALECTS = [["mysql", "MySQL"], ["clickhouse", "ClickHouse"]];
const LOSSY_OPEN = "This query uses ClickHouse features MySQL doesn't have, so it opens in ClickHouse syntax. You can still switch to MySQL for an approximation.";
const LOSSY_SWITCH = "Converted as far as MySQL allows: ClickHouse-only functions may be changed. Keep editing in ClickHouse syntax to keep them exact.";
const TRANSLATOR_DOWN = "MySQL syntax isn't available on this server (it needs Python 3), so the query is shown in ClickHouse syntax.";

/** A translation failure → a marker in the text that was sent (when the translator said where), else null. */
export function translateMarker(err) {
  if (err?.line == null) return null;
  const line = err.line - 1;
  const to = err.col ?? (err.start ?? 0) + 1, from = Math.max(0, Math.min(err.start ?? to - 1, to - 1));
  return { from: { line, ch: from }, to: { line, ch: Math.max(to, from + 1) }, message: err.message };
}

/**
 * @param {{ table: string, sql: string, mysql: string|null, getDefault: () => Promise<string>,
 *   apply: (sql: string, mysql: string|null) => Promise<void>,
 *   validate: (sql: string, signal: AbortSignal) => Promise<{ columns: unknown[] }>,
 *   explain: (sql: string, signal: AbortSignal) => Promise<{ syntax: string }>,
 *   translate: (sql: string, from: string, to: string, signal?: AbortSignal) => Promise<{ sql: string, warnings?: string[], changes?: string[] }> }} o
 *   `sql` is the card's ClickHouse query; `mysql` the MySQL text it was written as (shown as is), or null to translate `sql` for display.
 *   `apply` checks the ClickHouse query and applies it (the MySQL text, if it was written, is kept with it); it throws an Error to keep the dialog open.
 *   `validate` asks the server to describe a ClickHouse query (no rows read); `explain` asks how ClickHouse reads it (EXPLAIN SYNTAX). `translate` converts between the two syntaxes (status 503: no translator here).
 * @returns {Promise<HTMLDialogElement>} resolves once the editor is in the dialog
 */
export async function openSqlDialog({ table, sql, mysql, getDefault, apply, validate, explain, translate }) {
  // One Edit SQL at a time: a second request (a double click, a key repeat) while one is opening or on screen brings that one forward instead of opening another.
  const live = document.querySelector("dialog.sql-dialog");
  if (live || opening) { live?.querySelector(".CodeMirror textarea, textarea, [tabindex]")?.focus?.(); return live ?? null; }
  opening = true;
  const n = ++seq;
  const dlg = el("dialog", "dialog sql-dialog");
  dlg.setAttribute("aria-labelledby", `sql-title-${n}`);
  const title = el("h2", "dialog__title", `Edit SQL · ${table}`); title.id = `sql-title-${n}`;
  const body = el("div", "dialog__body sql-dialog__body");
  const frame = el("div", "sql-dialog__frame"); // one code-editor frame: toolbar above the text, verdict, warnings and the translated query below it
  const bar = el("div", "sql-dialog__bar");
  const host = el("div", "sql-dialog__editor");
  const readout = el("div", "sql-dialog__readout"); // the verdict at the left; at the right, the way to see the ClickHouse query that will run (MySQL syntax only)
  const status = el("p", "sql-dialog__status"); status.setAttribute("role", "status");
  const notes = el("ul", "sql-dialog__notes"); notes.hidden = true; // differences the translation can't hide: a warning each, never a blocker
  const previewText = el("pre", "sql-dialog__sql"); previewText.hidden = true; previewText.id = `sql-out-${n}`;
  previewText.tabIndex = 0; previewText.setAttribute("role", "region"); previewText.setAttribute("aria-label", "ClickHouse SQL that will run"); // focusable, so a long query can be scrolled by keyboard
  const peek = el("button", "sql-dialog__peek"); peek.type = "button"; peek.hidden = true; peek.setAttribute("aria-controls", previewText.id);
  const chev = el("span", "sql-dialog__chev"); chev.setAttribute("aria-hidden", "true"); chev.append(icon("chevron-right", { size: 14 }));
  peek.append(chev, document.createTextNode("ClickHouse SQL"));
  readout.append(status, peek);
  const help = el("p", "sql-dialog__help", "Ctrl+Enter saves. Shift+Alt+F formats. Tab indents; Ctrl+M makes Tab move focus instead."); help.id = "sql-editor-help";
  frame.append(bar, host, readout, notes, previewText);
  body.append(frame, help);

  const foot = el("div", "dialog__foot sql-dialog__foot");
  const seg = el("div", "seg"); seg.setAttribute("role", "radiogroup"); seg.setAttribute("aria-label", "SQL syntax");
  const radios = {};
  for (const [value, text] of DIALECTS) {
    const lab = el("label"); const r = el("input"); r.type = "radio"; r.name = `sql-dialect-${n}`; r.value = value;
    r.addEventListener("change", () => syncSeg());
    lab.append(r, el("span", null, text)); seg.append(lab); radios[value] = r;
  }
  // The selected / unavailable look follows these classes (set from the radios' state, whoever changed it).
  function syncSeg() { for (const r of Object.values(radios)) { r.parentElement.classList.toggle("is-on", r.checked); r.parentElement.classList.toggle("is-off", r.disabled); } }
  const reset = makeButton("Reset to default", "btn btn--ghost"); // ghost: outlined like the switch beside it, readable on the grey toolbar
  const format = makeButton("Format", "btn btn--ghost"); format.title = "Lay the query out (Shift+Alt+F)";
  const acts = el("div", "sql-dialog__acts"); acts.append(reset, format); // what to do with the text; wraps as one group when the bar is narrow
  bar.append(seg, acts); // the editor's own controls: the syntax it is written in, and what to do with its text
  const cancel = makeButton("Cancel", "btn");
  const save = makeButton("Save", "btn btn--primary");
  foot.append(cancel, save); // the dialog's decision: nothing else shares this row
  dlg.append(title, body, foot);
  document.body.append(dlg);

  // --- the status line: one problem, a notice, or the verdict; an icon and words, never colour alone ---
  const say = (kind, message) => {
    status.className = `sql-dialog__status${kind ? ` sql-dialog__status--${kind}` : ""}`;
    status.replaceChildren();
    if (!message) return;
    if (kind) { const g = el("span", "sql-dialog__glyph"); g.setAttribute("aria-hidden", "true"); g.append(icon(kind === "ok" ? "check" : kind === "busy" ? "refresh" : "warning", { size: 14 })); status.append(g); }
    status.append(document.createTextNode(message));
  };
  const showNotes = (list) => {
    notes.replaceChildren(...(list ?? []).map((t) => { const li = el("li"); const g = el("span", "sql-dialog__glyph"); g.setAttribute("aria-hidden", "true"); g.append(icon("warning", { size: 14 })); li.append(g, document.createTextNode(t)); return li; }));
    notes.hidden = !list?.length || dialect !== "mysql";
  };
  let peekOpen = false; // kept while the button is hidden, so the panel comes back as it was
  const syncPeek = () => { const on = !peek.hidden && peekOpen; previewText.hidden = !on; peek.setAttribute("aria-expanded", String(on)); peek.title = on ? "Hide the ClickHouse SQL" : "Show the ClickHouse SQL that will run"; };
  const showPreview = (ch) => { peek.hidden = !ch || dialect !== "mysql"; previewText.textContent = ch ?? ""; syncPeek(); };
  const openPreview = () => { peekOpen = true; syncPeek(); };
  peek.addEventListener("click", () => { peekOpen = !peekOpen; syncPeek(); });

  let editor = null, dialect = "mysql", checkTimer = 0, ctl = null, ticket = 0, lastOk = null, closed = false, busy = false;
  const pairs = []; // { mysql, ch } texts known to mean the same, so a round trip gives back exactly what was there (MySQL text is never turned back into ClickHouse by guesswork)
  // `derived`: the MySQL text was made from the ClickHouse text (not written by the user), so saving it unchanged must not record it as written.
  const remember = (my, ch, derived = false, warnings = []) => { if (!pairs.some((p) => p.mysql === my && p.ch === ch)) pairs.push({ mysql: my, ch, derived, warnings }); };
  const listProblems = (text) => checkSql(text).map((p) => ({ from: posOf(text, p.from), to: posOf(text, p.to), message: p.message }));
  const describeLocal = (list) => `Line ${list[0].from.line + 1}: ${list[0].message}${list.length > 1 ? ` (${list.length - 1} more)` : ""}`;

  /** `text` in the other syntax: a remembered pair, else the translator. Throws the translator's Error (it may carry line / col / start). */
  async function convert(text, from, to, signal) {
    const side = (d) => (d === "mysql" ? "mysql" : "ch");
    const known = pairs.find((p) => p[side(from)] === text);
    if (known) return known[side(to)];
    const r = await translate(text, from, to, signal);
    if (from === "mysql") remember(text, r.sql, false, r.warnings ?? []); else remember(r.sql, text, true);
    return r.sql;
  }
  const translatorDown = (err) => err?.status === 503;
  /** Did turning ClickHouse text `ch` into MySQL text `my` and back keep its meaning? Three checks, any failing means no:
   *  1. the translator reports no repair that changes meaning on the way back (`changes`: ilike, case-fold, div-null, nulls-first — every future one too);
   *  2. ClickHouse accepts the round trip and returns the same columns (a mangled function name fails here);
   *  3. ClickHouse reads both texts the same way (EXPLAIN SYNTAX, compared by canonSyntax) — the judge of anything the first two cannot see, such as a changed WHERE.
   *  A false alarm only opens the query in ClickHouse syntax; a missed change would silently alter which rows it returns. If EXPLAIN is unavailable, 1 and 2 decide. */
  async function keepsMeaning(ch, my) {
    try {
      const r = await translate(my, "mysql", "clickhouse"); // asked for real: a remembered pair would only echo `ch` back
      if (r.sql === ch) return true;
      const signal = new AbortController().signal;
      const ask = (fn, text) => fn(text, signal).catch(() => null); // a refusal is an answer: it is what "not kept" looks like
      const [a, b] = await Promise.all([ask(validate, ch), ask(validate, r.sql)]);
      const [sa, sb] = a && b ? await Promise.all([ask(explain, ch), ask(explain, r.sql)]) : [null, null];
      return meaningKept({ ch, back: r.sql, changes: r.changes, columnsBefore: a?.columns, columnsAfter: b?.columns, syntaxBefore: sa?.syntax, syntaxAfter: sb?.syntax }).kept;
    } catch { return false; }
  }
  function markTranslatorDown() {
    radios.mysql.disabled = true; radios.mysql.parentElement.title = TRANSLATOR_DOWN;
    if (dialect === "mysql") { dialect = "clickhouse"; radios.clickhouse.checked = true; editor.setDialect("clickhouse"); showPreview(null); }
    syncSeg();
    say("error", TRANSLATOR_DOWN);
  }

  // On every change: instant checks first; only a clean text goes further (after a pause while typing, at once when `delay` is 0), and only the latest answer counts.
  const check = (text, delay) => {
    clearTimeout(checkTimer); ctl?.abort(); ticket++;
    if (!(lastOk && text === lastOk.text && dialect === lastOk.dialect)) { showPreview(null); showNotes(null); } // the panel and notes say what the text means now: hidden until it is known again
    const local = listProblems(text);
    editor.setProblems(local);
    if (local.length) { say("error", describeLocal(local)); if (dialect === "mysql") showPreview(null); return; }
    if (!text.trim()) { say("", ""); showPreview(null); return; }
    if (lastOk && text === lastOk.text && dialect === lastOk.dialect) { say("ok", columnsText(lastOk.count)); showPreview(lastOk.ch); showNotes(lastOk.notes); return; }
    say("busy", dialect === "mysql" ? "Translating and checking with ClickHouse…" : "Checking with ClickHouse…");
    if (delay) checkTimer = setTimeout(() => deepCheck(text), delay); else deepCheck(text);
  };
  const onChange = (text) => check(text, CHECK_DELAY_MS);
  async function deepCheck(text) {
    const mine = ++ticket;
    ctl = new AbortController();
    try {
      let ch = text;
      if (dialect === "mysql") {
        ch = await convert(text, "mysql", "clickhouse", ctl.signal);
        if (mine !== ticket || closed) return;
        lastTranslated = ch;
        const back = listProblems(ch);
        if (back.length) { showPreview(ch); openPreview(); say("error", `The translated ClickHouse query is refused: ${back[0].message}`); return; }
      }
      const { columns } = await validate(ch, ctl.signal);
      if (mine !== ticket || closed) return;
      const notes = dialect === "mysql" ? pairs.find((p) => p.mysql === text && p.ch === ch)?.warnings ?? [] : [];
      lastOk = { text, dialect, count: columns.length, ch, notes };
      editor.setProblems([]);
      say("ok", columnsText(columns.length));
      showPreview(ch); showNotes(notes);
    } catch (err) {
      if (mine !== ticket || closed || err?.name === "AbortError") return;
      reportFailure(text, err);
    }
  }
  /** Show why `text` failed: the translator's own position (in the MySQL text), ClickHouse's position (ClickHouse text only), or just the words. */
  function reportFailure(text, err) {
    if (translatorDown(err)) { markTranslatorDown(); return; }
    const mark = translateMarker(err);
    if (mark) { editor.setProblems([mark]); say("error", `Line ${mark.from.line + 1}: ${err.message}`); showPreview(null); return; }
    if (dialect === "clickhouse") {
      const at = serverErrorPos(err.message, text);
      editor.setProblems(at ? [{ from: at, to: { line: at.line, ch: at.ch + 1 }, message: err.message }] : []);
      say("error", at ? `Line ${at.line + 1}: ${err.message}` : err.message);
      return;
    }
    editor.setProblems([]); // ClickHouse refused the translated query: its positions belong to the other text, so the words only
    const refused = err.field === "source.sql"; // from ClickHouse (a translator or key-column message has no such field): it is about the translated query
    say("error", refused ? `ClickHouse refused the translated query: ${err.message}` : err.message);
    if (refused && lastTranslated) { showPreview(lastTranslated); openPreview(); }
  }
  let lastTranslated = null;

  const close = () => { closed = true; clearTimeout(checkTimer); ctl?.abort(); editor?.destroy(); closeDialog(dlg); };
  // Esc asks first when the query was edited, so a stray key never throws typed SQL away; Cancel is a deliberate click and closes at once.
  let opened = null; // the text as the editor first showed it
  let asking = false;
  const requestClose = async () => {
    if (closed || asking) return;
    if (editor && opened !== null && editor.getValue() !== opened) {
      asking = true;
      const ok = await confirmDestructive("Discard your changes to this query?", { confirmText: "Discard" });
      asking = false;
      if (!ok) { editor.focus(); return; }
    }
    close();
  };
  cancel.addEventListener("click", close);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); requestClose(); });
  reset.addEventListener("click", async () => {
    reset.disabled = true;
    try { editor.replaceValue(await getDefault()); onChange(editor.getValue()); editor.focus(); say("", "Reset to the table's query. Ctrl+Z undoes it."); } finally { reset.disabled = false; } // a replace, not a setValue: the old text stays one Ctrl+Z away
  });
  format.addEventListener("click", async () => { format.disabled = true; try { await editor.format(); } finally { format.disabled = false; editor.focus(); } });

  // Switching syntax converts the text in place; if it can't be converted the switch is undone and the reason shown.
  const setBusy = (on) => { busy = on; editor.setReadOnly(on); for (const r of Object.values(radios)) r.disabled = on || (r === radios.mysql && radios.mysql.parentElement.title === TRANSLATOR_DOWN); save.disabled = reset.disabled = format.disabled = on; syncSeg(); };
  for (const [value, radio] of Object.entries(radios)) radio.addEventListener("change", async () => {
    if (!radio.checked || value === dialect || busy) return;
    const from = dialect, text = editor.getValue();
    clearTimeout(checkTimer); ctl?.abort(); ticket++;
    setBusy(true); say("busy", `Converting to ${value === "mysql" ? "MySQL" : "ClickHouse"} syntax…`);
    try {
      const out = text.trim() ? await convert(text, from, value) : text;
      if (closed) return;
      if (editor.getValue() !== text) throw Object.assign(new Error("The text changed while it was being converted. Choose the syntax again."), { stale: true });
      const writtenAsMysql = pairs.some((p) => p.ch === text && !p.derived); // this ClickHouse text came from MySQL the user wrote: it comes back as that text, no guessing
      const lossy = text.trim() && from === "clickhouse" && value === "mysql" && !writtenAsMysql && !(await keepsMeaning(text, out)); // an approximation: say so
      if (closed) return;
      dialect = value; editor.setDialect(value); editor.setValue(out);
      setBusy(false);
      onChange(out);
      if (lossy) say("warn", LOSSY_SWITCH);
    } catch (err) {
      radios[from].checked = true; setBusy(false);
      if (err.stale) { say("error", err.message); return; }
      if (translatorDown(err)) { markTranslatorDown(); return; }
      const mark = from === "mysql" ? translateMarker(err) : null;
      if (mark) editor.setProblems([mark]);
      say("error", `Can't convert to ${value === "mysql" ? "MySQL" : "ClickHouse"} syntax: ${err.message}`);
    } finally { editor.focus(); }
  });

  let saving = false;
  const submit = async () => {
    if (saving || busy) return;
    const text = editor.getValue();
    const local = listProblems(text);
    const problem = sqlProblem(text) ?? (local.length ? describeLocal(local) : null);
    if (problem) { say("error", problem); editor.focus(); return; }
    clearTimeout(checkTimer); ctl?.abort(); ticket++;
    saving = true; save.disabled = reset.disabled = format.disabled = true; save.textContent = "Saving…";
    try {
      let ch = text;
      if (dialect === "mysql") {
        ch = await convert(text, "mysql", "clickhouse");
        const back = listProblems(ch);
        if (back.length) { showPreview(ch); openPreview(); throw new Error(`The translated ClickHouse query is refused: ${back[0].message}`); }
        lastTranslated = ch;
      }
      const made = pairs.find((p) => p.mysql === text && p.derived); // MySQL text that is only our translation of the ClickHouse query: nothing was written in MySQL
      await apply(ch, dialect === "mysql" && !made ? text : null);
      close();
    } catch (err) { reportFailure(text, err); editor.focus(); }
    finally { saving = false; save.disabled = reset.disabled = format.disabled = false; save.textContent = "Save"; }
  };
  save.addEventListener("click", submit);

  // --- open: the card's query in MySQL (what was written, else translated); in ClickHouse syntax when that can't be done ---
  /** What to show: { shown, shownDialect, openNote }. Known at once when the MySQL text was kept or this query has opened before; else it takes a translation and
   *  some ClickHouse calls (the dialog is already on screen by then). */
  async function decideOpen() {
    if (mysql != null) { remember(mysql, sql); return { shown: mysql, shownDialect: "mysql", openNote: null }; }
    const key = `${table}\u0000${sql}`;
    const known = openedAs.get(key);
    if (known) { if (known.shownDialect === "mysql") remember(known.shown, sql, true); return known; }
    try {
      const my = await convert(sql, "clickhouse", "mysql");
      if (!(await keepsMeaning(sql, my))) { pairs.length = 0; const d = { shown: sql, shownDialect: "clickhouse", openNote: LOSSY_OPEN }; openedAs.set(key, d); return d; } // the guess would not mean the same: show the real thing
      const d = { shown: my, shownDialect: "mysql", openNote: null }; openedAs.set(key, d); return d;
    } catch (err) {
      if (translatorDown(err)) { radios.mysql.disabled = true; radios.mysql.parentElement.title = TRANSLATOR_DOWN; }
      return { shown: sql, shownDialect: "clickhouse", openNote: translatorDown(err) ? TRANSLATOR_DOWN : `Shown in ClickHouse syntax: ${err.message}` };
    }
  }
  const hold = (on) => { busy = on; save.disabled = reset.disabled = format.disabled = on; }; // nothing to save, reset or format until the text is there
  const instant = mysql != null || openedAs.has(`${table}\u0000${sql}`);
  const deciding = instant ? null : decideOpen(); // started now, so it runs while the dialog opens and the editor files load
  let first;
  try { first = instant ? await decideOpen() : { shown: "", shownDialect: "mysql", openNote: null }; } finally { opening = false; } // openDialog follows with no await between, so no gap
  hold(true);
  if (deciding) say("busy", OPENING);
  dialect = first.shownDialect; radios[dialect].checked = true; syncSeg();
  openDialog(dlg);
  editor = await mountEditor(host, {
    value: first.shown, dialect, onChange, onSubmit: submit, onEscape: requestClose, label: "SQL query",
    onNotice: (t) => say(/^Can't|could not/.test(t) ? "error" : "", t), // a notice sits in the status line until the next change
  });
  if (closed) { editor.destroy(); return dlg; } // closed while the editor files were loading
  if (deciding) {
    editor.setReadOnly(true);
    first = await deciding;
    if (closed) return dlg;
    dialect = first.shownDialect; radios[dialect].checked = true; editor.setDialect(dialect); editor.setValue(first.shown); syncSeg();
    editor.setReadOnly(false);
  }
  hold(false);
  opened = editor.getValue();
  if (!editor.rich) format.hidden = true; // the plain fallback can't format
  editor.focus();
  // A saved query is checked as soon as it opens, with no typing pause; when a note explains how it opened, the old pause keeps that note readable first.
  check(editor.getValue(), first.openNote ? CHECK_DELAY_MS : 0);
  if (first.openNote) say(first.openNote === LOSSY_OPEN ? "warn" : "error", first.openNote);
  return dlg;
}
