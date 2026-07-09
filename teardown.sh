#!/usr/bin/env zsh
# teardown.sh — undeploy web-app versions of this Apps Script project.
#
# Usage:
#   ./teardown.sh                    # list, confirm, undeploy ALL versioned deployments
#   ./teardown.sh <deploymentId>     # undeploy just that one (no prompt)
#   ./teardown.sh --yes              # undeploy ALL, skip the confirmation prompt
#
# The script project itself (source on script.google.com, .clasp.json on
# disk) is NOT deleted — only the versioned deployments that serve URLs are
# torn down. @HEAD (the always-live editor deployment) cannot be undeployed
# and is left alone.

set -euo pipefail

if [[ ! -f .clasp.json ]]; then
  echo "No .clasp.json in current directory — nothing to tear down." >&2
  exit 1
fi

if ! command -v clasp >/dev/null 2>&1; then
  echo "clasp not on PATH. Install: npm install -g @google/clasp" >&2
  exit 1
fi

case "${1:-}" in
  --yes|-y)
    SKIP_CONFIRM=1
    TARGET="all"
    ;;
  "")
    SKIP_CONFIRM=0
    TARGET="all"
    ;;
  *)
    # Specific deployment id passed
    TARGET="$1"
    ;;
esac

echo "Current deployments:"
clasp deployments
echo ""

if [[ "$TARGET" != "all" ]]; then
  echo "Undeploying $TARGET…"
  clasp undeploy "$TARGET"
  echo "Done."
  exit 0
fi

if [[ "$SKIP_CONFIRM" -ne 1 ]]; then
  read -r "reply?Undeploy ALL versioned deployments above? [y/N] "
  [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Aborted."; exit 1; }
fi

echo "Undeploying all…"
clasp undeploy --all
echo "Done. The script project itself is intact; re-run ./deploy.sh to publish a new version."
