# Dashboard Builder

A web app for exploring a ClickHouse server visually. You connect, browse databases and tables, drag tables onto a shared data source, draw the relationships between them, and build worksheets, dashboards and stories without writing SQL. It is aimed at analysts.

- **Read-only.** Only `SELECT`, `SHOW` and `DESCRIBE` run, and every query is sent with `readonly=2`.
- **No application database.** Workbooks auto-save in the browser (localStorage) and can be exported and imported as files.
- **ClickHouse only.** It talks to the server over HTTP(S).

## Features

- **Connect and browse:** TLS connections, credentials kept in the server session only, a schema browser and an entity canvas.
- **Data source:** 1:1, 1:N, N:1 and N:M relationships (logical only, nothing is changed in ClickHouse), union and unpivot, and a free-text Edit SQL (MySQL or ClickHouse syntax).
- **Worksheets:** shelves, automatic joins, crosstabs, calculated fields, parameters and groups, with 23 chart types and PNG, SVG and CSV export.
- **Dashboards and stories:** a 12-column dashboard grid, stories, workbook export and import, and an auto-backup to a folder you pick.

## Stack

| Part | Choice |
|---|---|
| Server | ASP.NET Core MVC on .NET 10 |
| ClickHouse client | `ClickHouse.Client` 7.x |
| SQL translation | `sqlglot` (vendored, MIT), run as `python3 -I Tools/sql_translate.py` |
| Frontend | Vanilla JS ES modules and hand-written CSS. No build step, no CDN. Vendored ECharts, CodeMirror 5 and sql-formatter |
| Tests | xUnit, `node --test` for JS, and browser (CDP) UI tests |
| Hosting | Kestrel behind Apache httpd, served under the path `/dashboardbuilder` |

## Repository layout

This is a single repo.

```
codebase/                      the application
  DashboardBuilder.slnx        solution
  src/DashboardBuilder/        web app (Program.cs, ClickHouse/, Features/, Tools/)
  tests/DashboardBuilder.Tests/  xUnit tests
  tests/js/                    node --test unit tests
  tests/live/                  browser UI and smoke tests (CDP)
  deploy-live.sh               deploy script for the live service
kb/                            knowledge base: architecture, concepts, decisions, how-tos, operations
```

`archive/` and `publish/` (build output) are git-ignored.

## Getting started

You need the .NET 10 SDK, `python3` on `PATH` (for the SQL translator), and a ClickHouse server to point at. A throwaway container on port 8123 works.

Run from `codebase/`:

```bash
dotnet build -c Release

# run locally: http://localhost:5080
cd src/DashboardBuilder && dotnet run

# on a spare port
dotnet run --no-launch-profile --urls http://localhost:5180

# behind a path prefix, as in production
PathBase=/dashboardbuilder dotnet run --no-launch-profile --urls http://127.0.0.1:5180
```

More detail: [kb/docs/getting-started/quickstart.md](kb/docs/getting-started/quickstart.md) and [prerequisites](kb/docs/getting-started/prerequisites.md).

## Tests

Run from `codebase/`:

```bash
dotnet test                         # xUnit
dotnet test --filter Identifier     # a single class
node --test tests/js/*.test.mjs     # JS unit tests (Node 24)
node tests/live/run-ui-all.mjs      # browser UI suite
```

The UI suite starts the app itself and takes more than 10 minutes. It needs a Chromium: set `CHROME_BIN`, or it falls back to one under `~/.cache/ms-playwright`. Narrow it with `ONLY=calc,rows`. The two smoke scripts (`translate-smoke.mjs`, `calc-smoke.mjs`) need a real ClickHouse, supplied through `CH_HOST`, `CH_PORT`, `CH_USER` and `CH_PASSWORD`. There is no CI. See [kb/docs/how-to/testing.md](kb/docs/how-to/testing.md).

## Configuration

| Setting | Purpose |
|---|---|
| `ASPNETCORE_URLS`, `ASPNETCORE_ENVIRONMENT` | standard ASP.NET Core |
| `PathBase` | URL prefix; required behind Apache |
| `DataProtection:KeyRingPath` | where the key ring lives (default `keys/`, git-ignored) |
| `Display:TimeZone` | display time zone (default `Asia/Kuala_Lumpur` when the host is UTC) |
| `ClickHouse:AllowedHosts` | hosts a user may connect to. Unset means any host, with a startup warning |
| `ClickHouse:ConnectPerMinute` | connection attempts per minute (default 20) |
| `Translate:Python` | Python executable for the translator (default `python3`) |

Sessions are held in memory, so a restart drops every connection.

## Publish and deploy

```bash
# from codebase/
dotnet publish src/DashboardBuilder/DashboardBuilder.csproj -c Release -o ../publish
./deploy-live.sh
```

`deploy-live.sh` stops the service, replaces the live folder (keeping `keys/`), starts it and checks that it answers 200. It makes no backup and has no automatic rollback unless you set `BAK=<folder>`. Manual steps and service details are in [kb/docs/how-to/deployment.md](kb/docs/how-to/deployment.md) and [kb/docs/operations/live-service.md](kb/docs/operations/live-service.md).

## Documentation

Start at [kb/README.md](kb/README.md). Useful entry points:

- [Architecture overview](kb/docs/architecture/overview.md)
- [Decision log](kb/docs/decisions/README.md) (D1 onward)
- [Coding standards](kb/docs/development/coding-standards.md) and [git workflow](kb/docs/development/git-workflow.md)
- [Change log](kb/docs/development/updates/change_log.md), generated from the `codebase/` history. Don't edit it by hand.

## License

No license file is included. The project's license is not documented. Vendored third-party code keeps its own licenses: `sqlglot` (MIT) and ECharts (Apache-2.0).
