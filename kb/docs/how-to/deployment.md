---
components: [src/DashboardBuilder/DashboardBuilder.csproj]
---
# Deploy a release

Build, copy and verify a release on the live host. The service itself (unit, proxy, runtime) is described in [live-service.md](../operations/live-service.md).

From the solution root (`/unified/user/cj/web_project/dashboard_builder/codebase`):

1. **Build and test:** `dotnet test`, then
   `dotnet publish src/DashboardBuilder/DashboardBuilder.csproj -c Release -o /unified/user/cj/web_project/dashboard_builder/publish`.
2. **Server code changed (any `.cs`, `.cshtml`, csproj):** stop, copy, start. Never copy a DLL over
   the running process; the mmap'd image corrupts (`BadImageFormatException`) and systemd crash-restarts.

   ```bash
   sudo systemctl stop webapps-dev.dashboardbuilder
   cp -r /unified/user/cj/web_project/dashboard_builder/publish/. /var/www/webapps-dev/dashboardbuilder/      # contents, not the folder; leaves keys/ intact
   sudo systemctl start webapps-dev.dashboardbuilder
   ```

   Copy as `unified`, never `sudo cp`; root-owned files in the deploy dir break the next deploy.
   `cp -r /unified/user/cj/web_project/dashboard_builder/publish /var/www/…/` (no `/.`) nests a `dashboard_builder/` folder and the old DLL keeps running.

3. **Only `Features/**/*.css|js` changed** (and the deployed bundle already has `Features/`): copy the
   assets alone, with no restart and no session loss:

   ```bash
   cp -r /unified/user/cj/web_project/dashboard_builder/publish/Features/* /var/www/webapps-dev/dashboardbuilder/Features/
   ```

4. **Verify:** `curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1:8443/dashboardbuilder/`
   → `200`, **and** a feature asset (`…/features/Core/api.js`) → `200`. Check both, because the page
   alone also answers 200 on a stale build. The browser picks up the new build by itself: every asset URL carries a content hash ([D139](../decisions/decisions-performance.md)).

## One-step deploy

`deploy-live.sh` (app repo root) does step 2 and 4 in one go: stop, replace (keeps `keys/`), start, then the page and asset check. It makes **no snapshot and has no automatic rollback**: on a failed check it exits 1 with the new build still live, so fix, re-publish and run it again. `BAK=<folder> ./deploy-live.sh` opts in to a backup of the live folder and a rollback to it.
