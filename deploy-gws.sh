#!/usr/bin/env zsh
# deploy-gws.sh — deploy this project via `googleworkspace-cli` (gws).
#
# Runs entirely on the individual user's OAuth token — NO Workspace-admin
# privileges are required. First run creates the standalone script project
# and writes .gws.json; subsequent runs push and re-deploy against the same
# script id.
#
# Prereqs: `brew install googleworkspace-cli` and `gws auth login`.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
STATE="$ROOT/.gws.json"
TITLE="${GMOVE_TITLE:-Drive Ownership Transfer}"

if ! command -v gws >/dev/null 2>&1; then
  echo "gws not installed. Run: brew install googleworkspace-cli"
  exit 1
fi

if ! gws auth status >/dev/null 2>&1; then
  echo "gws not authenticated. Run: gws auth login"
  exit 1
fi

if command -v jq >/dev/null 2>&1; then :; else
  echo "jq required. Run: brew install jq"
  exit 1
fi

# --- 1) Ensure a script project exists ----------------------------------------
if [[ -f "$STATE" ]]; then
  SCRIPT_ID="$(jq -r .scriptId "$STATE")"
  echo "Reusing existing script id: $SCRIPT_ID"
else
  echo "Creating new Apps Script project: $TITLE"
  CREATE_JSON="$(gws script projects create --json "{\"title\":\"$TITLE\"}")"
  SCRIPT_ID="$(echo "$CREATE_JSON" | jq -r .scriptId)"
  if [[ -z "$SCRIPT_ID" || "$SCRIPT_ID" == "null" ]]; then
    echo "Failed to create project. Response:"
    echo "$CREATE_JSON"
    exit 1
  fi
  echo "{\"scriptId\":\"$SCRIPT_ID\",\"title\":\"$TITLE\"}" > "$STATE"
  echo "Wrote $STATE"
fi

# --- 2) Upload local files ----------------------------------------------------
echo "Pushing files from $ROOT …"
gws script +push --script "$SCRIPT_ID" --dir "$ROOT"

# --- 3) Cut an immutable version ---------------------------------------------
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Creating version…"
VERSION_JSON="$(gws script projects versions create \
  --params "{\"scriptId\":\"$SCRIPT_ID\"}" \
  --json   "{\"description\":\"gmove $STAMP\"}")"
VERSION="$(echo "$VERSION_JSON" | jq -r .versionNumber)"
if [[ -z "$VERSION" || "$VERSION" == "null" ]]; then
  echo "Version creation failed. Response:"
  echo "$VERSION_JSON"
  exit 1
fi
echo "Version $VERSION created."

# --- 4) Deploy that version as a web-app --------------------------------------
echo "Deploying version $VERSION…"
DEPLOY_JSON="$(gws script projects deployments create \
  --params "{\"scriptId\":\"$SCRIPT_ID\"}" \
  --json   "{\"versionNumber\":$VERSION,\"description\":\"gmove $STAMP\",\"manifestFileName\":\"appsscript\"}")"
DEPLOY_ID="$(echo "$DEPLOY_JSON" | jq -r .deploymentId)"
URL="$(echo "$DEPLOY_JSON" | jq -r '.entryPoints[]? | select(.entryPointType=="WEB_APP") | .webApp.url // empty')"

echo ""
echo "Deployment: $DEPLOY_ID"
if [[ -n "$URL" && "$URL" != "null" ]]; then
  echo "Web-app URL: $URL"
else
  echo "No web-app entry point returned. The manifest's 'webapp' block may need to be updated,"
  echo "or the project has not been authorized yet — open the editor once to trigger consent:"
  echo "  open \"https://script.google.com/d/$SCRIPT_ID/edit\""
fi
