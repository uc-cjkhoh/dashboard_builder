---
components: [src/DashboardBuilder/ClickHouse/SqlTranslator.cs, src/DashboardBuilder/Features/Rows/SqlController.cs, src/DashboardBuilder/Tools/sql_translate.py, src/DashboardBuilder/Features/Canvas/sql-dialog.js]
---
# MySQL and ClickHouse syntax in Edit SQL

The Edit SQL dialog ([sql-editor.md](sql-editor.md)) can be written in **MySQL** or **ClickHouse** syntax. A switch in the footer picks one; **MySQL is the default**, because
many users know it, while ClickHouse is what the database speaks and what always runs ([D106](../../decisions/decisions-custom-sql.md#d106--mysql-syntax-in-edit-sql-translated-to-clickhouse)).

**Code:**

- `Canvas/sql-dialog.js` — the switch, the conversions, the panel
- `Canvas/sql-editor.js` — highlighting and Format follow the syntax
- `Features/Rows/SqlController.cs` — `POST /api/sql/translate` ([api-custom-sql.md](../../reference/api-custom-sql.md#translate))
- `ClickHouse/SqlTranslator.cs` — runs the script as a child process
- `Tools/sql_translate.py` + `Tools/vendor/sqlglot/` — the translator (sqlglot 30.31.0, MIT, pure Python)

## What you see

- **Footer switch** `MySQL | ClickHouse` (a radio group, left of Reset and Format). The chosen segment is solid ink and bold.
- **Opening a card:** the default `SELECT` reads the same in both and opens in MySQL. A saved query opens as the MySQL text it was written as; a query written in ClickHouse is translated for display, and opens in **ClickHouse** syntax with a warning when the translation would not mean the same (below), or when it can't be translated.
- **Switching** converts the text in place (the editor is read-only meanwhile). If it can't be converted the switch is undone and the reason shown ("Can't convert to MySQL syntax: …"). Highlighting (`text/x-mysql` / `text/x-clickhouse`) and Format follow the syntax.
- **ClickHouse SQL that will run** — in MySQL syntax, a read-only panel under the status line shows the translation of the current text (hidden while it is being worked out; it opens by itself when ClickHouse refuses the translation).
- **Status line:** in MySQL syntax the message is "Translating and checking with ClickHouse…", then "Valid query · N columns", or the problem. A translator parse error is underlined **in the MySQL text** at the place it names. A refusal from ClickHouse is about the *translated* query, so it is shown in words only ("ClickHouse refused the translated query: …"; its line and column belong to the other text).

## What is saved

The card **always runs ClickHouse SQL** (`customSql`, [query-sources.md](query-sources.md#custom-sql-on-a-card)). When the query was written in MySQL, that text is kept beside it as `customSqlMysql` so reopening shows exactly what was typed (workbook file, [data-model.md](../../reference/data-model.md)); a query saved in ClickHouse syntax drops it. MySQL text that is only our translation of a ClickHouse query is never recorded as written.

A round trip never rewrites a query by guesswork: the dialog remembers which MySQL and ClickHouse texts it paired, so switching back and forth, and **Save without editing**, give back exactly the original text. Only text you *edit* in MySQL is translated again.

## The round-trip check

Turning ClickHouse into MySQL and back can change a query without a trace: `toDate(ts)` becomes `TODATE(ts)` (ClickHouse function names are case-sensitive), a case-sensitive `x = 'abc'` comes back ignoring case, `count()` comes back as `COUNT()` (a different column name). So for a query written in ClickHouse the dialog translates it to MySQL and back, and **opens it in MySQL syntax only when all three checks pass** (`meaningKept()` in `Core/sql-roundtrip.js`, unit-tested):

1. **The translator reports no repair that changes meaning** on the way back: its answer carries `changes` — `ilike` (LIKE ignores case), `case-fold` (`=`, `!=`, `IN` against text ignore case), `div-null` (division by zero gives NULL), `nulls-first` (ORDER BY keeps MySQL's NULL order). A future repair added to the script is covered the moment it reports itself; form-only repairs (`DATEDIFF`, `DATE_ADD`, …) are not listed.
2. **ClickHouse accepts the round trip and returns the same columns** (names and types): a mangled function name fails here.
3. **ClickHouse reads both texts the same way:** `EXPLAIN SYNTAX` of the original and of the way back are equal after `canonSyntax()` (layout, the case of function names and `coalesce`/`ifNull` are ignored — only once ClickHouse has accepted both, which is what proves every case-sensitive name was right). This catches what 1 and 2 cannot see, such as a changed `WHERE`. If `EXPLAIN` is unavailable, 1 and 2 decide.

A false alarm only opens the query in ClickHouse syntax with "This query uses ClickHouse features MySQL doesn't have…"; a missed change would silently alter which rows it returns, so every doubt says "changed". Switching to MySQL anyway shows an approximation with "Converted as far as MySQL allows…", and unchanged text is never re-translated.

**How often that happens** (`tests/live/translate-smoke.mjs`, Part 2, 19 typical queries on system tables, ClickHouse 26.8): **8 open in MySQL syntax, 11 in ClickHouse syntax.** Of the 11, 8 are for `changes` — 7 are genuine (a string comparison, `IN`, `LIKE` or a division, which really would behave differently once re-read as MySQL) and **1 is a known false alarm: a plain ascending `ORDER BY`** (going to MySQL, ClickHouse's NULLs-last order is kept with a `CASE WHEN … IS NULL` key, so the `NULLS FIRST` added on the way back changes nothing); 1 is for a different column name (`count()` → `COUNT()`, genuine: a worksheet field would lose its name), 1 for a refused function (`toDate`, genuine), 1 for `currentDatabase()` → `CURRENT_DATABASE()` (a **known false alarm**). The default `SELECT` of a card and any query written in MySQL syntax are not affected: they open in MySQL. Most saved ClickHouse queries that filter on text therefore open in ClickHouse syntax; whether that trade-off is right is the product's call (the alternative — opening them in MySQL and accepting that an edit would make the comparison ignore case — is a one-line change in `keepsMeaning`).

## Translator

`SqlTranslator` starts `python3 -I Tools/sql_translate.py` per request and writes the JSON request on stdin (`{ sql, from, to }`), reads one JSON answer (`{ ok, sql }` or `{ ok:false, kind, error, errors:[{ line, col, start, message }] }`) — no shell, no network, 10 s time limit, at most 4 at once, ≤ 64 KB of answer. sqlglot runs with `ErrorLevel.RAISE`, so a construct it knows it can't convert is refused instead of passed on. Its messages name its own classes, so the script rewrites the common ones into plain sentences. `-I` ignores `PYTHON*` variables and the user's site-packages, so only the vendored copy is used.

- **Repairs and refusals** (the rows above marked refused or rewritten) live in `mysql_to_clickhouse()` in `Tools/sql_translate.py`, applied only in the MySQL → ClickHouse direction: the text is tokenised (to find `||`), parsed, repaired on the syntax tree, then generated. Each has an exact-output test in `SqlTranslatorTests`.
- **Checked on a real ClickHouse** (the test server, 26.8.36.3, 2026-11-12): `DESCRIBE TABLE (subquery)` and `EXPLAIN SYNTAX` under the app's guards; `tests/live/translate-smoke.mjs` runs 31 MySQL → ClickHouse cases (`DATEDIFF`, every `TIMESTAMPDIFF` family with both signs and month/year edges, `DATE_ADD` / `DATE_SUB`, `LIKE` incl. non-ASCII, `=` / `<>` / `IN` / `NOT IN` on text, Enum and non-text columns, division by zero, NULL order) and compares each result with MySQL's documented one (no MySQL server exists here); all 31 match. The same script re-runs on another ClickHouse (see [testing.md](../../how-to/testing.md)), because a different version could behave differently — it already showed `age('hour')` is wrong on this one.
- **Needs** Python 3 on the server (3.9 is installed on the build host). Without it, `POST /api/sql/translate` answers 503, the dialog switches MySQL off (the option is struck out with the reason as its tooltip) and carries on in ClickHouse syntax; nothing else changes.
- `Translate:Python` in configuration names another interpreter (default `python3`).
- The vendored library is published with the app (`Tools/**` is a `Content` item) and is never served over HTTP.
- **To upgrade sqlglot:** `pip install --target <scratch> sqlglot`, replace `Tools/vendor/sqlglot/` and its licence file, run `dotnet test --filter SqlTranslator` and `tests/live/edit-sql-ui.mjs`.

## Warnings

The translator answers `{ sql, warnings: [text], changes: [name] }`. A warning is a difference the translation cannot remove, in a plain sentence (today: text comparisons now ignore case, can be slower on very large tables because the primary key cannot be used, and accents still count as different letters; shown once). It shows under the status line with a warning icon, only in MySQL syntax, only for the text it was made for (typing hides it until the new text is known), and **never blocks Save**. `changes` is for the browser (the round-trip check above), not shown.

## Limitations

The translator is a best effort, not a guarantee. **Always check the "ClickHouse SQL that will run" panel for anything beyond a plain SELECT.** Measured on the vendored version:

**MySQL → ClickHouse** (what runs):

| Case | What happens |
|---|---|
| Plain `SELECT`, `WHERE`, `JOIN`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT a, b`, `UNION`, CTEs, window functions, `IFNULL`, `IF`, `CASE`, `COUNT(DISTINCT …)`, `REGEXP`, `LIKE`, `DATE_FORMAT` | converted correctly (`LIMIT 5, 10` → `LIMIT 10 OFFSET 5`, `IFNULL` → `COALESCE`, `IF` → `CASE`, `REGEXP` → `match`, `UNION` → `UNION DISTINCT`, `DATE_FORMAT` → `formatDateTime` with its specifiers mapped) |
| `a \|\| b` | **refused**: it is `OR` in MySQL's default mode and text concatenation in ClickHouse, and either guess would be a silent wrong answer. Write `OR`, or `CONCAT(a, b)`. The refusal is underlined at the `\|\|` |
| `DATEDIFF(a, b)` | `dateDiff('day', b, a)` — a minus b in days, in the order ClickHouse takes (start, end) |
| `TIMESTAMPDIFF(unit, a, b)` | whole units, as MySQL counts them: `age('day' \| 'week' \| 'month' \| 'quarter' \| 'year', a, b)`; for hours, minutes and seconds the **elapsed seconds**: `intDiv(dateDiff('second', a, b), 3600)` (`… , 60)` for minutes, `dateDiff('second', a, b)` for seconds). `age('hour', …)` is **wrong on the test server** (ClickHouse 26.8: 10:00 → 12:30 gave 3, 10:59 → 11:01 gave -1), so it is not used. MICROSECOND and other units are refused |
| `DATE_ADD` / `DATE_SUB(d, INTERVAL n unit)`, `d ± INTERVAL n unit` | `d + INTERVAL n unit` / `d - INTERVAL n unit` with `n` a number (a quoted `'1'` is turned into `1`). Compound units (`YEAR_MONTH`, …) and an amount that is not a plain integer (`INTERVAL col DAY`) are **refused** |
| `LIKE` / `NOT LIKE` | `ILIKE` / `NOT ILIKE`: MySQL's default collation ignores case, ClickHouse's `LIKE` does not (an `ESCAPE` clause is kept, which ClickHouse does not accept) |
| `=`, `!=`, `IN` against text with letters (`name = 'abc'`, `name IN ('a', 'b')`) | `lowerUTF8(toString(name)) = lowerUTF8('abc')`: MySQL ignores case, ClickHouse does not. `toString` makes it work for every column type (text, Enum, FixedString, LowCardinality, Nullable, numbers) and `lowerUTF8` for non-ASCII letters; NULL stays NULL. **Not rewritten** (left exactly as typed, case-sensitive in ClickHouse): a comparison between **two columns** (`a.name = b.name`, so a join on text — the commonest case difference still open), a number- or date-like literal (`'123'`, `'1e5'`, `'2024-01-01T10:00:00'`), `''`, a list that is not all text, `'a' = 'B'`, a subquery, `LOWER(x) = …`, `<`, `>`, `BETWEEN`. A note says it can be slower on very large tables (the primary key cannot be used there) and accents still differ. To keep ClickHouse's exact comparison, switch to ClickHouse syntax |
| `ORDER BY a` | gets `NULLS FIRST` to keep MySQL's NULL order |
| `a / b`, `a % b`, `a DIV b` | the divisor is wrapped in `nullIf(b, 0)`: division by zero is NULL, as in MySQL (ClickHouse gives `inf`, or an error for constants). Casts become `Nullable(…)` types |
| `SQL_CALC_FOUND_ROWS`, `@var := …`, `STRAIGHT_JOIN`, `JSON_UNQUOTE`, `UNIX_TIMESTAMP`, `LAST_DAY`, `STR_TO_DATE`, `WITH RECURSIVE`, other MySQL-only features | passed through **unchanged**; ClickHouse may refuse them or read them differently (some have a ClickHouse alias of the same name, some do not) |
| `FOR UPDATE` / `FOR SHARE` | refused by the translator |
| `USE INDEX (…)` hints | dropped silently |
| Double-quoted `"text"` | read as a string, as in MySQL (in ClickHouse it would be a name) |
| Backtick names | come out as `"name"` (valid in ClickHouse) |
| A MySQL stored routine, `INSERT`, `UPDATE`, DDL | not a `SELECT`: refused by the same guard as any custom SQL |
| Grouping, sorting and `DISTINCT` on text (MySQL treats `'A'` and `'a'` as one value, ClickHouse as two), accent-insensitivity, binary collations, implicit conversions (`'1' = 1`), `<` / `>` / `BETWEEN` on text, `ENGINE` details, MySQL's SQL modes | **not modelled**: there are no column types here to decide on, so these stay ClickHouse's behaviour, silently |

**ClickHouse → MySQL** (display only; never run on MySQL):

- Plain SQL converts (`LIMIT n OFFSET m` is kept — MySQL accepts it; `ifNull` → `IFNULL`, `ILIKE` → `LOWER(…) LIKE LOWER(…)`, `uniq` is not recognised as a MySQL function).
- **ClickHouse-only functions have no MySQL form**: they are kept but changed — upper-cased (`toDate` → `TODATE`, `uniqExact` → `UNIQEXACT`, `multiIf` → `MULTIIF`) or mapped to another database's name (`arrayJoin` → `EXPLODE`, `uniq` → `APPROX_DISTINCT`). The text is not valid MySQL, and converted back it would not run in ClickHouse.
- A query using `PREWHERE`, `FINAL` and `SAMPLE` was refused as a parse error; `WITH TOTALS` comes out garbled (`GROUP BY a, WITH TOTALS`); `LIMIT n BY` gets an unrelated `ORDER BY` rewrite; `ARRAY JOIN` and `GLOBAL IN` pass through as ClickHouse syntax; lambdas map to `TRANSFORM(arr, x -> …)`; `{name:Type}` parameters become `:name`; array indexes shift (`arr[1]` → `arr[0]`).
- Hence the round-trip check above, and the rule that unchanged text is never re-translated.

**The feature itself:**

- Translation covers **one query** of at most 10,000 characters; two statements are refused.
- The checks run on **ClickHouse's description of the translated query**, not on MySQL: a query MySQL would reject can pass here, and one MySQL accepts can fail here. Nothing is ever run against MySQL; there is no MySQL server.
- Syntax errors inside MySQL text are found by the translator (position shown) or by ClickHouse (words only, no position).
- The instant checks (brackets, quotes, `SETTINGS`, blocked functions) apply to the text as typed in either syntax.
- Auto-format uses sql-formatter's MySQL or ClickHouse dialect; the dialects it knows differ slightly from sqlglot's.
- Needs Python 3 on the server (see above); each conversion starts a short process (about 0.1–0.4 s), so MySQL syntax adds a little delay while typing; many people editing at once queue behind four slots.
- A query written in MySQL keeps its MySQL text in the workbook; if the translator is later upgraded the stored ClickHouse query does **not** change until the card is saved again.
- A different MySQL version's dialect (5.7, 8.4, MariaDB) is not distinguished.
