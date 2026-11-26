---
components: [tests/DashboardBuilder.Tests/]
---
# Installation

Where the code lives and how to build and publish it.

## Where the code lives

| What | Path |
|---|---|
| Solution root (run `dotnet` here) | `/unified/user/cj/web_project/dashboard_builder/codebase/` (`DashboardBuilder.slnx`) |
| App project | `…/src/DashboardBuilder/` |
| Tests | `…/tests/DashboardBuilder.Tests/` (xUnit) |
| Publish output (`dotnet publish -o`, deployed by `deploy-live.sh`) | `/unified/user/cj/web_project/dashboard_builder/publish/`, git-ignored |
| Archive: `mirror/` is a copy of the repo refreshed on every commit; `live-<date>/` is a snapshot of the live build, including the key ring | `/unified/user/cj/web_project/dashboard_builder/archive/` |
| This KB (docs only) | `/unified/user/cj/web_project/dashboard_builder/kb/` |

- The build host is **`10.168.49.20`** (`dataweb`). The KB and the app share its filesystem, so a KB
  session can build and test the app directly, with no SSH needed (decision
  [D9](../decisions/decisions-platform.md#d9--app-source-lives-outside-the-kb-on-the-build-host)).
- Each project has one folder, `/unified/user/cj/web_project/<project>/` (snake_case names), holding `kb/`,
  `codebase/`, `publish/` and `archive/`. Shared, project-agnostic knowledge lives in `/unified/user/cj/general_kb/`.
- The project folder is **one git repo** holding `codebase/` and `kb/` (`publish/` and `archive/` are git-ignored; keep
  `keys/` ignored too), with remote `origin` on GitHub, so changes can be reviewed as diffs. Never scaffold code into the KB.
- SSH and ClickHouse credentials are in the git-ignored [credentials.local.md](../operations/credentials.local.md).

## Build & publish

```bash
cd /unified/user/cj/web_project/dashboard_builder/codebase
dotnet build -c Release
dotnet publish src/DashboardBuilder/DashboardBuilder.csproj -c Release -o /unified/user/cj/web_project/dashboard_builder/publish
```

Publish is framework-dependent. `Features/**/*.css|js` are copied as content alongside the DLL. Keep
ClickHouse credentials out of source, config and logs.
