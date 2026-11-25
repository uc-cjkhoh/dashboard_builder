# CLAUDE.md — working conventions (index)

Index for anyone (human or agent) working on the **Dashboard Builder**. This file is the map: where the
code is, setup commands, directory layout, and the golden rules in one line each. The detail lives in
the [`docs/`](docs/README.md) knowledge base — follow the links.

> **Read first:** [README.md](README.md) · [architecture/overview.md](docs/architecture/overview.md) · [design/index.md](docs/reference/design/index.md),
> then the [`docs/`](docs/README.md) file for whatever you're touching. **Update that doc in the same
> change** — this KB tracks current state, not history ([kb-maintenance.md](docs/development/kb-maintenance.md)).

> **This KB is docs only.** The source is at `/unified/user/cj/web_development/prototype/dashboard_builder/`
> on the build host `10.168.49.20` (same shared filesystem — build it from here). Never scaffold code
> into the KB. The app folder is a local git repo (no remote); this KB is a separate git repo.

## Golden rules

One line each; full text in [coding-standards.md](docs/development/coding-standards.md).
**Rules 1–3 shape every server change.**

1. **Read-only against ClickHouse** — `SELECT`/`SHOW`/`DESCRIBE` only, no DDL/DML endpoint in v1; ClickHouse's own
   `readonly=2` is set on every query as a second guard.
2. **Validate + quote every identifier** against the live catalog, in `ClickHouse/Identifier.cs` only
   (ClickHouse binds values, not identifiers). One exception: a card's **Edit SQL** text, guarded in `ClickHouse/CustomSql.cs` ([D105](docs/decisions/decisions-custom-sql.md#d105--edit-sql-free-text-select-on-a-data-source-card-the-one-exception-to-rules-2-and-3)).
3. **Bind every value; bound every result** — whitelisted aggs/ops, typed values, validated `LIMIT`s;
   every query is time-limited; out-of-range input is rejected (400), never silently clamped. Charts cap at 5000 groups, tables page, CSV ≤ 100k (D24).
4. **Credentials live in the session only** — never returned, logged, or put in a URL.
5. **Relationships are logical declarations**, not database facts.
6. **Toggle visibility with `hidden`**, never `style.display`.
7. **Design tokens only** — no hardcoded hex; red means danger, nothing else.
8. **Fixed shell** — the page never scrolls; panels scroll inside.
9. **Never colour alone** — icon + text + colour; legends; shape-coded cardinality.
10. **Self-hosted, framework-free frontend** — vanilla JS/CSS, no build step, no CDN.
11. **Update the KB after every prompt** — whatever the prompt changed, update its doc in the same turn, before you report done.
12. **No Undo; destructive deletes ask once** — `confirmDestructive` in `Core/ui.js` ([full text: § 13](docs/development/coding-standards.md#13-destructive-deletes-ask-once-there-is-no-undo)).

## What this is in one screen

One ASP.NET Core MVC app (Kestrel) serves **a single page** (`GET /`, composed from feature partials)
plus a **read-only JSON API**. The **browser holds all builder state** — the shared data source
(entities + relationships) and every worksheet and dashboard tab — in vanilla-JS ES modules. The
**server is a thin, session-scoped proxy to ClickHouse**: `ConnectionRegistry` holds the session's
connection; `ClickHouseGateway` runs introspection and bounded, identifier-safe aggregate/join queries
and returns JSON. **There is no application database.** Full picture:
[overview.md](docs/architecture/overview.md).

## Build, run, test, deploy

From the solution root `/unified/user/cj/web_development/prototype/dashboard_builder`:

```bash
dotnet build -c Release
dotnet test                                   # .NET suite; --filter Identifier for one class
~/.nvm/versions/node/v24.20.0/bin/node --test tests/js/*.test.mjs   # JS unit tests
cd src/DashboardBuilder && dotnet run         # http://localhost:5080
dotnet run --no-launch-profile --urls http://localhost:5180   # a spare port
dotnet publish src/DashboardBuilder/DashboardBuilder.csproj -c Release -o publish
```

- **Prereqs:** .NET SDK 10 (on the host's `PATH`); a ClickHouse to point at — details and a throwaway
  container in [quickstart.md](docs/getting-started/quickstart.md).
- **Live:** `webapps-dev.dashboardbuilder.service`, Kestrel `:5105`, Apache `:8443`, path
  `/dashboardbuilder`. Stop → copy → start for server changes — never copy a DLL over the running
  process ([live-service.md](docs/operations/live-service.md)).
- **Never `pkill -f DashboardBuilder.dll`** (matches the live service) — stop dev runs by port.
- **Credentials** (SSH + ClickHouse): git-ignored
  [credentials.local.md](docs/operations/credentials.local.md) — never in shared docs. All never-do rules: [safe-operations.md](docs/operations/safe-operations.md).

## Source layout

```
src/DashboardBuilder/
├── Program.cs              # host, session, PathBase, hashed immutable /features assets (D139)
├── Tools/                  # sql_translate.py + vendored sqlglot: MySQL ⇄ ClickHouse for Edit SQL (D106); needs python3, never served
├── ClickHouse/             # shared server infra: Gateway (all SQL), Identifier, ClickHouseType,
│                           #   RequestValidation (limits, rules, typed filter values),
│                           #   ConnectionRegistry, CsvUtil, CustomSql (Edit SQL guard), SqlTranslator, *Models.cs
└── Features/               # one folder per feature: controller + _View.cshtml + .css + .js
    ├── ApiControllerBase.cs  ApiErrors.cs   # RunAsync / SafeError; the one { error, field? } shape
    ├── Shell/  Core/  Connection/  Schema/  Canvas/  Relations/  Rows/  Tabs/  Board/  Story/  Dashboard/  Calc/  Workbook/
tests/DashboardBuilder.Tests/   # xUnit
tests/js/                       # node --test, for the pure JS modules
```

Feature assets are served at `/features/<Feature>/<file>` (`.css`/`.js` only). Map:
[components.md § Code map](docs/architecture/components.md).

## Design rules

Full text and how they map to tokens: [coding-standards.md § 12](docs/development/coding-standards.md#12-design-rules).

1. **Optical alignment** on every element — align to what the eye reads, not the box edge.
2. **Gaps and spacing** are only 4 / 8 / 16 / 24 px (`--s1` `--s2` `--s4` `--s6`).
3. **One border radius** for inner and outer shapes (`--r`, 8px).
4. **Colour saturation ≈ 70 %** by default (HSL S ≤ 70 %).
5. **Few font sizes:** 14 / 16 px for content, 24 / 32 px for titles.
6. **No unnecessary secondary labels or descriptions** — let the layout do the explaining.

## Tech stack reference

Preferred stack for new projects — **reference only**: this app stays vanilla JS/CSS
([golden rule 10](docs/development/coding-standards.md#10-self-hosted-framework-free-frontend)).
UI: shadcn/ui NOVA · Icons: Lucide · Animation: Motion · Drag and drop: dnd-kit · State: Zustand.

## KB directory map

The one copy of the folder tree; other docs link here.

```
dashboard_builder/          (this KB)
├── README.md               # project introduction and entry point
├── CLAUDE.md               # instructions for AI coding agents (loaded automatically)
├── CHANGELOG.md            # pointer to the generated change log
├── docs/
│   ├── README.md           # KB index and navigation
│   ├── getting-started/    # prerequisites · installation · configuration · quickstart
│   ├── architecture/       # system-context · overview · data-flow · components · frontend-modules
│   ├── concepts/           # core-concepts, then one folder per app area:
│   │   ├── data-source/    #   connection · schema-browser · canvas · query-sources · sql-editor · sql-syntax · relationships (+ relationship-suggestion, relating-tables)
│   │   ├── worksheet/      #   worksheet (+ -query, -table-view) · worksheet-charts · worksheet-encodings (+ -marks, -filters) · calculated-fields (+ -formulas, -groups) · field-settings
│   │   └── workbook/       #   tabs · dashboards · stories · workbook · auto-backup
│   ├── how-to/             # local-development · testing · deployment · troubleshooting
│   ├── reference/          # api (+ -calculated-fields, -custom-sql, -union-unpivot) · clickhouse-integration (+ clickhouse-calculations) · data-model · source-table-guidance · tableau-marks-comparison · glossary
│   │   └── design/         #   index (concept + rules) · tokens · layout · components · motion-accessibility
│   ├── decisions/          # README (D1–D159 lookup, open questions) · decisions-* by topic
│   ├── operations/         # live-service · resource-usage · safe-operations (+ git-ignored credentials.local.md)
│   ├── development/        # coding-standards · sharp-edges · review-guidelines · design-review · git-workflow · kb-maintenance · hooks
│   │   ├── backlog/        #   undone work by topic (incl. custom-sql) · recommended order · design specs
│   │   ├── run-logs/       #   blocked work
│   │   └── updates/        #   generated change log
│   └── archive/            # frozen P0–P20 build plan, old debug log — not maintained
└── .claude/                # hooks (kb-verify, update-log, reap-orphans, design-lint, design-gate), settings, skills
```

## Where things live

| Task | Code | Doc |
|---|---|---|
| Add/adjust a ClickHouse query | `ClickHouse/ClickHouseGateway.cs` | [clickhouse-integration.md](docs/reference/clickhouse-integration.md) |
| Add an API endpoint | `Features/*/…Controller.cs` (subclass `ApiControllerBase`) | [api.md](docs/reference/api.md) (calculation trees: [api-calculated-fields.md](docs/reference/api-calculated-fields.md)) |
| Validate an input / add a limit | `ClickHouse/RequestValidation.cs` + `Features/Core/validate.js` (keep in step) | [api.md § Limits](docs/reference/api.md#limits) |
| Edit SQL on a card (editor, MySQL / ClickHouse syntax, guard, translator) | `Features/Canvas/sql-dialog.js`, `sql-editor.js`, `Core/sql-check.js`, `Core/sql-roundtrip.js`, `ClickHouse/CustomSql.cs`, `SqlTranslator.cs`, `Tools/sql_translate.py` | [sql-editor.md](docs/concepts/data-source/sql-editor.md), [sql-syntax.md](docs/concepts/data-source/sql-syntax.md), [api-custom-sql.md](docs/reference/api-custom-sql.md), [D105–D106](docs/decisions/decisions-custom-sql.md), limits: [backlog/custom-sql.md](docs/development/backlog/custom-sql.md) |
| Connection flow | `ClickHouse/ConnectionRegistry.cs`, `Features/Connection/` | [connection.md](docs/concepts/data-source/connection.md) |
| Drag/drop, entity cards | `Features/Canvas/canvas.js` | [canvas.md](docs/concepts/data-source/canvas.md) |
| Relationships / cardinality | `Features/Relations/relations.js` | [relationships.md](docs/concepts/data-source/relationships.md) |
| Tabs / dashboard data | `Features/Tabs/tabs.js`, `Core/store.js`, `Features/Board/board-model.js` | [tabs.md](docs/concepts/workbook/tabs.md) |
| Worksheet shelves / plan / crosstab | `Features/Dashboard/dashboards.js` | [worksheet.md](docs/concepts/worksheet/worksheet.md) |
| Chart types / rendering / export | `Features/Dashboard/chart.js` | [worksheet-charts.md](docs/concepts/worksheet/worksheet-charts.md) |
| Marks, filters, drill, pages | `Features/Dashboard/dashboards.js` | [worksheet-encodings.md](docs/concepts/worksheet/worksheet-encodings.md) |
| Query caching / latest-wins / truncation notice | `Features/Dashboard/query-runner.js` | [worksheet-query.md § Query lifecycle](docs/concepts/worksheet/worksheet-query.md#query-lifecycle) |
| Story tab (steps, strip, caption, print) | `Features/Story/story.js`, `story-model.js` | [stories.md](docs/concepts/workbook/stories.md) |
| Save / restore / export / import | `Features/Workbook/` | [workbook.md](docs/concepts/workbook/workbook.md) |
| Auto-backup to a folder on disk, the Settings dialog and its sidebar-foot tile | `Features/Workbook/backup.js`, `backup-model.js`, the sidebar foot in `Shell/Index.cshtml` | [auto-backup.md](docs/concepts/workbook/auto-backup.md), [D150](docs/decisions/decisions-workbook-backup.md) |
| Colour / spacing / type | `Features/Core/core.css` `:root` | [tokens.md](docs/reference/design/tokens.md) |
| Motion / transitions | `Features/Core/motion.js` + `core.css` motion tokens | [motion-accessibility.md](docs/reference/design/motion-accessibility.md#motion) |
| Gotchas before editing | — | [sharp-edges.md](docs/development/sharp-edges.md) |
| Definition of done | — | [review-guidelines.md](docs/development/review-guidelines.md) |
