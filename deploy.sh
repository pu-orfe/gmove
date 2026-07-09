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
  echo "  clasp login && clasp create --title 'Drive Ownership Transfer' --type webapp --rootDir ."
  echo "  # or for an existing project:"
  echo "  clasp login && clasp clone <SCRIPT_ID> --rootDir ."
  exit 1
fi

echo "Pushing project files…"
clasp push -f

echo "Deploying new web-app version…"
clasp deploy --description "gmove deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "Open in editor with: clasp open"
