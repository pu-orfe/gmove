#!/usr/bin/env zsh
# update.sh — run tests, then re-deploy.
# Uses deploy-gws.sh (googleworkspace-cli) by default; set GMOVE_CLI=clasp
# to switch to the clasp path.

set -euo pipefail

echo "[1/2] Running tests in Docker…"
docker-compose build tests
docker-compose run --rm tests

CLI="${GMOVE_CLI:-gws}"
if [[ "$CLI" == "clasp" ]]; then
  echo "[2/2] Deploying via clasp…"
  clasp push -f
  clasp deploy --description "gmove update $(date -u +%Y-%m-%dT%H:%M:%SZ)"
else
  echo "[2/2] Deploying via gws…"
  ./deploy-gws.sh
fi

echo "Done."
