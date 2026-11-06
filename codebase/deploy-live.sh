#!/usr/bin/env bash
# Full deploy of publish/ to the live dev service:
#   back up live -> stop -> replace (keeps keys/) -> start -> verify.
# Rolls back to the backup if the new build does not answer 200.
#
# The backup is made by this script, outside the repo, next to it:
#   /unified/user/cj/web_development/prototype/dashboard-builder-<YYYYMMDD-HHMMSS>-pre-deploy
# Override with BAK=/some/dir ./deploy-live.sh. An existing BAK that holds keys/ is reused as is.
set -euo pipefail
UNIT=webapps-dev.dashboardbuilder
LIVE=/var/www/webapps-dev/dashboardbuilder
SRC=/unified/user/cj/web_development/prototype/dashboard_builder/publish
STAMP=$(date +%Y%m%d-%H%M%S)
BAK=${BAK:-/unified/user/cj/web_development/prototype/dashboard-builder-$STAMP-pre-deploy}
BASE=https://127.0.0.1:8443/dashboardbuilder

[ -f "$SRC/DashboardBuilder.dll" ] && [ -d "$SRC/Features" ] || { echo "publish/ incomplete"; exit 1; }
[ -d "$LIVE/keys" ] || { echo "live keys/ missing: $LIVE/keys"; exit 1; }

# Back up what is live now (service still running: copying is read-only). This is the rollback target.
if [ -d "$BAK/keys" ]; then
  echo "Using existing backup: $BAK"
elif [ -e "$BAK" ]; then
  echo "backup path exists but has no keys/ (partial?): $BAK"; exit 1
else
  cp -a "$LIVE" "$BAK"
  [ -d "$BAK/keys" ] && [ -f "$BAK/DashboardBuilder.dll" ] || { echo "backup incomplete: $BAK"; exit 1; }
  echo "Backed up live build to: $BAK"
fi

replace() {  # $1 = source dir; wipes LIVE except keys/, then copies
  find "$LIVE" -mindepth 1 -maxdepth 1 ! -name keys -exec rm -rf {} +
  (cd "$1" && find . -mindepth 1 -maxdepth 1 ! -name keys -exec cp -a {} "$LIVE"/ \;)
}
check() {  # the page AND a feature asset must answer 200 (the page alone answers 200 on a stale build)
  for _ in $(seq 1 20); do
    page=$(curl -sk -o /dev/null -w '%{http_code}' "$BASE/" || true)
    asset=$(curl -sk -o /dev/null -w '%{http_code}' "$BASE/features/Core/api.js" || true)
    [ "$page" = 200 ] && [ "$asset" = 200 ] && return 0; sleep 1
  done; return 1
}

sudo systemctl stop "$UNIT"
replace "$SRC"
sudo systemctl start "$UNIT"
if check; then
  echo "DEPLOYED OK — https://10.168.49.20:8443/dashboardbuilder answers 200"
  echo "Backup kept at: $BAK"
else
  echo "New build did not answer 200 — rolling back to $BAK"
  sudo systemctl stop "$UNIT"; replace "$BAK"; sudo systemctl start "$UNIT"
  check && echo "ROLLED BACK — old build is live again" || echo "ROLLBACK ALSO FAILED — check journalctl -u $UNIT"
  exit 1
fi
