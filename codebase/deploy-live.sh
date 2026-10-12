#!/usr/bin/env bash
# Full deploy of publish/ to the live dev service: stop -> replace (keeps keys/) -> start -> verify.
# Rolls back to the backup if the new build does not answer 200.
set -euo pipefail
UNIT=webapps-dev.dashboardbuilder
LIVE=/var/www/webapps-dev/dashboardbuilder
SRC=/unified/user/cj/web_development/prototype/dashboard_builder/publish
BAK=$HOME/backups/dashboardbuilder-20261012-pre-deploy

[ -f "$SRC/DashboardBuilder.dll" ] && [ -d "$SRC/Features" ] || { echo "publish/ incomplete"; exit 1; }
[ -d "$BAK/keys" ] || { echo "backup missing: $BAK"; exit 1; }

replace() {  # $1 = source dir; wipes LIVE except keys/, then copies
  find "$LIVE" -mindepth 1 -maxdepth 1 ! -name keys -exec rm -rf {} +
  (cd "$1" && find . -mindepth 1 -maxdepth 1 ! -name keys -exec cp -a {} "$LIVE"/ \;)
}
check() {
  for _ in $(seq 1 20); do
    code=$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/dashboardbuilder/ || true)
    [ "$code" = 200 ] && return 0; sleep 1
  done; return 1
}

sudo systemctl stop "$UNIT"
replace "$SRC"
sudo systemctl start "$UNIT"
if check; then
  echo "DEPLOYED OK — https://10.168.49.20:8443/dashboardbuilder answers 200"
else
  echo "New build did not answer 200 — rolling back"
  sudo systemctl stop "$UNIT"; replace "$BAK"; sudo systemctl start "$UNIT"
  check && echo "ROLLED BACK — old build is live again" || echo "ROLLBACK ALSO FAILED — check journalctl -u $UNIT"
  exit 1
fi
