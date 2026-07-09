#!/usr/bin/env zsh
# update.sh — run tests, then re-deploy.
# Uses deploy.sh (clasp) by default. Set GMOVE_CLI=gws to use deploy-gws.sh
# — only do that if you have already met the prerequisites in README §2b
# (dedicated GCP project with Apps Script API + scopes).

set -euo pipefail

echo "[1/2] Running tests in Docker…"
docker-compose build tests
docker-compose run --rm tests

CLI="${GMOVE_CLI:-clasp}"
if [[ "$CLI" == "gws" ]]; then
  echo "[2/2] Deploying via gws…"
  ./deploy-gws.sh
else
  echo "[2/2] Deploying via clasp…"
  clasp push -f
  clasp deploy --description "gmove update $(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

echo "Done."
