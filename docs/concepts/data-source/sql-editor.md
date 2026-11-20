---
components: [src/DashboardBuilder/Features/Canvas/sql-dialog.js, src/DashboardBuilder/Features/Canvas/sql-editor.js, src/DashboardBuilder/Features/Core/sql-check.js, src/DashboardBuilder/Features/Core/vendor/codemirror/]
---
# The Edit SQL editor

The code editor inside the Edit SQL dialog of a Data Source card ([query-sources.md § Custom SQL on a card](query-sources.md#custom-sql-on-a-card), [D105](../../decisions/decisions-custom-sql.md)).
It is CodeMirror 5, self-hosted, with sql-formatter for the Format button.

**Code:**

- `Canvas/sql-dialog.js` — the dialog: toolbar, status line, buttons, the live check
- `Canvas/sql-editor.js` — mounts the editor, loads its files, key bindings, folding, formatting; a plain text area if the files can't load
- `Core/sql-check.js` — pure instant checks (mirror of `ClickHouse/CustomSql.cs`)
- `Core/vendor/codemirror/` — the vendored files
- `Canvas/canvas.css` — the theme, from the design tokens

A switch in the editor toolbar chooses **MySQL** (the default) or **ClickHouse** syntax; the card always runs ClickHouse SQL, translated on the way: [sql-syntax.md](sql-syntax.md).

## At a glance

| Feature | How it works |
|---|---|
| **Layout** | One frame (`.sql-dialog__frame`) holds the whole editor: a **toolbar** on top (the syntax switch at the left, **Reset to default** and **Format** at the right; they wrap as a group when the dialog is narrow), the text in the middle, then one **readout row** (the verdict at the left; in MySQL syntax a **ClickHouse SQL** toggle at the right), the **warnings**, and, while the toggle is open, the translated query. The chrome rows are `--surface-2` like the line-number gutter; the text area is `--surface`. The footer holds only **Cancel** and **Save**. The first line of code sits directly under the toolbar and the last line directly above the readout row (no top or bottom padding in the text area), and the frame's border does not change on focus, like every other input ([tokens.md](../../reference/design/tokens.md)). |
| **Opening** | The dialog appears at once. When the card's MySQL text is known, or this query already opened in this page, the text is there with it. A query saved in ClickHouse syntax has to be worked out first (a translation, then four ClickHouse calls): the editor is empty and read-only with "Opening your query…" meanwhile, Reset, Format and Save are disabled, Cancel and Esc work, and the text and syntax appear when the answer is ready. The answer is kept for the life of the page, so reopening that card is instant ([D144](../../decisions/decisions-performance.md)). **One at a time:** asking for Edit SQL again while one is opening or on screen (a double click on the menu item) focuses that dialog instead of opening another (`opening` flag and the open `dialog.sql-dialog` in `sql-dialog.js`). |
| **Reset to default** | Replaces the text as one edit (`replaceValue` in `sql-editor.js`), so **Ctrl+Z** brings the previous query back, and the readout says so ("Reset to the table's query. Ctrl+Z undoes it."). Nothing is saved until Save. |
| **Height** | The frame is `min(62vh, 640px)` tall (at least 320px) and the dialog 840px wide. The height is fixed, so a verdict, a warning or the translated query opening never moves the dialog; the text area gives up the room. Drag the frame's bottom-right corner to resize it; the dialog scrolls inside the window if it must. |
| **Syntax highlighting** | A ClickHouse flavour of CodeMirror's SQL mode (`text/x-clickhouse`): its keywords and types, backtick names, `--`, `#` and `/* */` comments, `{name:Type}` parameters. Keywords are bold, comments italic, so no word is told apart by colour alone. Three hues only (keywords purple, types teal, literals blue); names stay plain ink. Green, amber and red are the verdict's colours and are never used for code ([D145](../../decisions/decisions-design.md)). |
| **Syntax checking** | Instant (below), then ClickHouse itself (below). A problem is a wavy underline in the text, a `!` in the margin, a tooltip, and a sentence in the status line. |
| **Auto-indentation** | A new line keeps the line's indent; the SQL mode adds one inside `(`, and Enter adds one after a clause word (`SELECT`, `FROM`, `WHERE`, `GROUP BY`, `ORDER BY`, `LIMIT`, `ON`, `USING`, …). A `)` typed at the start of a line lines up with its `(`. Enter between `()` opens the pair out. |
| **Bracket matching** | The bracket next to the cursor and its partner get a wash and an outline; a bracket with no partner is underlined. Brackets and quotes also close themselves. |
| **Syntax** | The toolbar switch `MySQL \| ClickHouse`: highlighting, Format and the checks follow it — [sql-syntax.md](sql-syntax.md). |
| **Auto formatting** | **Format** (or Shift+Alt+F) lays the whole query out with sql-formatter's ClickHouse dialect. Letter case is kept — ClickHouse names are case-sensitive, and the formatter would otherwise turn an alias `n` into `N`. One undo step (Ctrl+Z). A query it can't parse says so and stays as typed. |
| **Code folding** | A margin arrow folds a `(`…`)` that spans lines (a subquery, an argument list) or an indented block. Strings and comments are skipped when pairing brackets. |

## Checks while you type

1. **Instant** (`checkSql`): on every change. The same rules as the server's guard — one `SELECT` / `WITH`, no extra `;`, balanced brackets, no `SETTINGS`, no outside-reading table function, closed quotes and comments, ≤ 10,000 characters — each pinned to the offending token. A parity test (`sql-check.test.mjs`) compares the blocked-function list with `CustomSql.cs`.
2. **ClickHouse** (`/api/source/columns`, the same call Save makes): only when the instant checks are clean, 800 ms after the last keystroke, latest answer wins (earlier calls are aborted). A query that has just opened is checked at once; when a note explains how it opened (it opened in ClickHouse syntax, or MySQL syntax is unavailable), the 800 ms pause stays so the note can be read first. It reads no rows. The status line says **Valid query · N columns**, or ClickHouse's own words. When the message names a line and column (`(line 3, col 8)`), the underline goes there (`serverErrorPos`; the server's line 1 is its `DESCRIBE` wrapper; a text with a `/* */` comment can't be placed and shows the message only).
3. **Save** repeats the checks and applies the query. It is refused when a column used as a relationship key would become a kind its partner can't be related to (a number key that turns into text): the message names the column and its partner, and says to change the query or remove the relationship first. A key missing from the query is the existing refusal. Once saved, the [data preview](canvas.md#data-preview) under the canvas shows the card's first rows from the new query (D128).

The status line is a live region: a problem, a notice (Formatted, Tab now moves focus), "Checking with ClickHouse…", or the verdict. Each has an icon and words.

## Keys

| Key | Does |
|---|---|
| Ctrl/Cmd+Enter | Save |
| Shift+Alt+F | Format |
| Tab / Shift+Tab | Indent / outdent |
| Ctrl+M | Tab moves focus out of the editor instead (and back), so the keyboard is never trapped |
| Esc | Closes the dialog, from inside the editor too (CodeMirror's own Esc only acts with several cursors). Once the text differs from what the dialog opened with, Esc first asks twice (`confirmDeleteTwice`, button **Discard**: "Discard your changes to this query?", then "Really discard your changes? This can't be undone." with **Discard for good**; Cancel or Esc on either keeps the dialog open); **Cancel** (a deliberate click) closes at once |
| Ctrl+Z / Ctrl+Y | Undo / redo of typing in the editor (Format is one step) |

These are also read to screen readers (`aria-describedby`).

## Vendored files

Self-hosted like ECharts ([golden rule 10](../../development/coding-standards.md#10-self-hosted-framework-free-frontend): no CDN, no build step). Loaded on demand — the editor script (240 KB) when a dialog first opens, the formatter (320 KB) on the first Format; the CSS is linked from `Shell/Index.cshtml`.

| File in `Features/Core/vendor/codemirror/` | What |
|---|---|
| `codemirror-sql.min.js` | CodeMirror 5.65.21: core + `matchbrackets`, `closebrackets`, `foldcode`, `foldgutter`, `indent-fold`, `lint`, `active-line`, the `sql` mode, minified with terser |
| `sql-formatter.min.js` | sql-formatter 15.9.0 (UMD build, global `sqlFormatter`) |
| `codemirror-sql.css` | CodeMirror's structural CSS with **every colour declaration removed** (`tokens.test.mjs` forbids a hex outside `:root`); colours come from `Canvas/canvas.css` |

Both libraries are MIT-licensed; the licence line is the first line of each file. **To upgrade:** `npm i codemirror@5 sql-formatter` in a scratch folder, concatenate the same addon files in the order above, minify, drop colour declarations from the two CSS files, replace the files, and run `tests/live/edit-sql-ui.mjs`. The lint addon's own CSS (coloured icons) is not used; markers and tooltips are styled in `canvas.css`.

## Failure

If the editor script can't be fetched, the dialog opens with a plain monospace text area: no highlighting, folding or checks, the Format button hidden, but Save and the server's answer work as before.

Tests: `tests/js/sql-check.test.mjs`, browser `tests/live/edit-sql-ui.mjs`.
