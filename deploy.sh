#!/usr/bin/env zsh
# deploy.sh — macOS zsh deploy script for the Apps Script project.
# Uses clasp (Google's official Apps Script CLI) to push local files.

set -euo pipefail

if ! command -v clasp >/dev/null 2>&1; then
  echo "Installing @google/clasp globally (requires npm)…"
  npm install -g @google/clasp
fi

if [[ ! -f .clasp.json ]]; then
  echo "No .clasp.json found. Run one of:"
  echo "  clasp login && clasp create --title 'Drive Ownership Transfer' --rootDir ."
  echo "  # or, for an existing project:"
  echo "  clasp login && clasp clone <SCRIPT_ID> --rootDir ."
  echo ""
  echo "Note: don't pass '--type webapp' — that isn't a valid clasp project"
  echo "type. Web-app entry points are defined by the manifest's 'webapp'"
  echo "block (already present in appsscript.json) and by 'clasp deploy'."
  exit 1
fi

# Load local .env variables if present
if [[ -f .env ]]; then
  export $(grep -v '^#' .env | xargs)
fi

echo "Generating Config.gs from environment configuration…"
cat << EOF > Config.gs
// Config.gs — Auto-generated config loader from .env at deployment time.
// DO NOT COMMIT this file. It is ignored by git.

function initializeConfigProperties() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('gmove.allowed_users', '${GMOVE_ALLOWED_USERS:-}');
  props.setProperty('gmove.support_contact', '${GMOVE_SUPPORT_CONTACT:-}');
}
EOF

echo "Pushing project files…"
clasp push -f

echo "Deploying new web-app version…"
DEPLOY_OUT="$(clasp deploy --description "gmove deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>&1 | tee /dev/stderr)"

# Extract deployment id (line looks like: "Deployed AKfy... @N")
DEPLOY_ID="$(printf '%s\n' "$DEPLOY_OUT" | awk '/^Deployed /{print $2; exit}')"

# clasp v3 split `clasp open` into subcommands.
CLASP_MAJOR="$(clasp --version 2>/dev/null | awk -F. '{print $1}')"
if [[ "${CLASP_MAJOR:-0}" -ge 3 ]]; then
  echo ""
  echo "Editor:  clasp open-script"
  echo "Logs:    clasp open-logs"
  if [[ -n "$DEPLOY_ID" ]]; then
    echo "Web app: clasp open-web-app $DEPLOY_ID"
    echo "Direct:  https://script.google.com/macros/s/$DEPLOY_ID/exec"
  fi
else
  echo "Open in editor with: clasp open"
fi
