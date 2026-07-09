#!/usr/bin/env zsh
# teardown.sh — undeploy web-app versions of the Apps Script project.

set -euo pipefail

if [[ ! -f .clasp.json ]]; then
  echo "No .clasp.json in current directory."
  exit 1
fi

echo "Current deployments:"
clasp deployments

echo ""
echo "To remove a specific deployment: clasp undeploy <deploymentId>"
echo "To remove ALL deployments (dangerous):"
echo "  clasp deployments | awk 'NR>1 && \$2 != \"@HEAD\" {print \$2}' | xargs -n1 clasp undeploy"
