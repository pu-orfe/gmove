#!/usr/bin/env zsh
# update.sh — the "push my latest changes live" button.
#
# Default flow (safe, keeps the deployment URL stable across iterations):
#
#   1. Run tests in Docker.
#   2. clasp push -f  (upload local source).
#   3. If a versioned deployment already exists, UPDATE IT IN PLACE with
#      `clasp deploy --deploymentId <id>` — the URL you already shared
#      stays valid.
#   4. If no versioned deployment exists yet, create a new one via
#      ./deploy.sh.
#
# Modes:
#   ./update.sh              default in-place update (as above)
#   ./update.sh --fresh      tear down ALL deployments then deploy a new one
#                            (URL changes; use for "start over")
#   ./update.sh --skip-tests skip the Docker test step
#   GMOVE_CLI=gws ./update.sh  use gws instead of clasp (requires §2b setup)

set -euo pipefail

FRESH=0
SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --fresh)      FRESH=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$SKIP_TESTS" -ne 1 ]]; then
  echo "[1/3] Running tests in Docker…"
  docker-compose build tests
  docker-compose run --rm tests
else
  echo "[1/3] Skipping tests (--skip-tests)."
fi

CLI="${GMOVE_CLI:-clasp}"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ---- gws path (advanced; see README §2b) -----------------------------------
if [[ "$CLI" == "gws" ]]; then
  echo "[2/3] Deploying via gws…"
  ./deploy-gws.sh
  echo "[3/3] Done."
  exit 0
fi

# ---- clasp path ------------------------------------------------------------
command -v clasp >/dev/null 2>&1 || { echo "clasp not on PATH." >&2; exit 1; }
[[ -f .clasp.json ]] || { echo "No .clasp.json. Run: clasp create --title 'Drive Ownership Transfer' --rootDir ." >&2; exit 1; }

# --- fresh mode: teardown everything, then a plain deploy -------------------
if [[ "$FRESH" -eq 1 ]]; then
  echo "[2/3] Fresh mode — tearing down all existing deployments…"
  ./teardown.sh --yes
  echo "[3/3] Deploying anew…"
  ./deploy.sh
  exit 0
fi

# --- default: in-place update -----------------------------------------------
echo "[2/3] Pushing source via clasp…"
clasp push -f

# Extract the most recent non-@HEAD deployment id from `clasp deployments`.
# Format (v3): "- AKfycb… @N - description"
DEPLOY_ID="$(clasp deployments 2>/dev/null \
  | awk '/^- /{ for (i=1;i<=NF;i++) if ($i ~ /^@[0-9]+$/) { print $2, substr($i,2); } }' \
  | sort -k2 -n \
  | tail -n1 \
  | awk '{print $1}')"

if [[ -z "$DEPLOY_ID" ]]; then
  echo "[3/3] No existing versioned deployment found — creating a new one…"
  DEPLOY_OUT="$(clasp deploy --description "gmove update $STAMP" 2>&1 | tee /dev/stderr)"
  DEPLOY_ID="$(printf '%s\n' "$DEPLOY_OUT" | awk '/^Deployed /{print $2; exit}')"
else
  echo "[3/3] Updating existing deployment $DEPLOY_ID in place…"
  clasp deploy --deploymentId "$DEPLOY_ID" --description "gmove update $STAMP"
fi

if [[ -n "$DEPLOY_ID" ]]; then
  echo ""
  echo "Web app: https://script.google.com/macros/s/$DEPLOY_ID/exec"
  echo "Editor:  clasp open-script"
  echo "Logs:    clasp open-logs"
fi
