#!/usr/bin/env zsh
# deploy-gws.sh — deploy this project via `googleworkspace-cli` (gws).
#
# READ THIS BEFORE RUNNING.
#
# `gws` is a general-purpose Workspace CLI. It does NOT ship with a
# pre-configured OAuth client for Apps Script. It authenticates against
# whatever GCP project the local ~/.config/gws/client_secret.json belongs to.
# If that project's OAuth consent screen does not include Apps Script scopes,
# every `gws script projects ...` call will fail with 403 insufficient_scope
# even though `gws auth login` itself succeeded.
#
# BEFORE using this script you MUST have:
#
#   1. A dedicated GCP project (or one you're willing to modify) — NOT a
#      shared/unrelated project like `orfe-calendars-api`.
#   2. Apps Script API enabled on that project:
#        gcloud services enable script.googleapis.com --project=<PROJECT_ID>
#   3. The scopes .../auth/script.projects and .../auth/script.deployments
#      added to that project's OAuth consent screen. GCP Console →
#      APIs & Services → OAuth consent screen → Scopes → Add or Remove.
#   4. `gws` pointed at that project:
#        gws auth logout
#        gws auth setup --project <PROJECT_ID> --login
#
# If any of the above are unclear, use ./deploy.sh (clasp) instead. clasp
# ships with Google's own OAuth client and needs zero of the above.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
STATE="$ROOT/.gws.json"
TITLE="${GMOVE_TITLE:-Drive Ownership Transfer}"

REQUIRED_SCOPES=(
  "https://www.googleapis.com/auth/script.projects"
  "https://www.googleapis.com/auth/script.deployments"
)

fail() {
  echo ""
  echo "✖ $1" >&2
  if [[ $# -gt 1 ]]; then
    echo "" >&2
    shift
    for line in "$@"; do echo "  $line" >&2; done
  fi
  echo "" >&2
  echo "  If this project setup is more work than you want, use clasp instead:" >&2
  echo "    ./deploy.sh   (see README §2a)" >&2
  echo "" >&2
  exit 1
}

# --- Preflight: gws binary --------------------------------------------------
command -v gws >/dev/null 2>&1 || fail "gws not installed." \
  "Install: brew install googleworkspace-cli"

command -v jq >/dev/null 2>&1 || fail "jq required for JSON parsing." \
  "Install: brew install jq"

# --- Preflight: authenticated? ---------------------------------------------
if ! STATUS_JSON="$(gws auth status 2>/dev/null)"; then
  fail "gws is not authenticated." \
    "Run:  gws auth login" \
    "(But first make sure the local client_secret.json points at a GCP" \
    " project whose OAuth consent screen includes the Apps Script scopes." \
    " See the header of this file for the full prerequisites.)"
fi

# gws auth status prints a "Using keyring backend: …" header line before JSON;
# strip anything before the opening brace.
STATUS_JSON="$(printf '%s' "$STATUS_JSON" | sed -n '/^{/,$p')"

USER_EMAIL="$(printf '%s' "$STATUS_JSON" | jq -r '.user // ""')"
PROJECT_ID="$(printf '%s' "$STATUS_JSON" | jq -r '.project_id // ""')"
TOKEN_VALID="$(printf '%s' "$STATUS_JSON" | jq -r '.token_valid // false')"
SCOPES="$(printf '%s' "$STATUS_JSON" | jq -r '.scopes[]?' 2>/dev/null || true)"

[[ "$TOKEN_VALID" == "true" ]] || fail "gws token is invalid or expired." \
  "Run:  gws auth login"

# --- Preflight: identity sanity check --------------------------------------
# The runtime app calls Session.getActiveUser() to compute ownership — the
# person who deploys does not have to be the person who runs transfers,
# but a shared-mailbox identity is almost never what you want on a personal
# deploy. Warn loudly if we see one.
case "$USER_EMAIL" in
  orfe-calendars@*|*-bot@*|*-service@*|*-svc@*|noreply@*)
    echo ""
    echo "⚠ WARNING: gws is currently logged in as $USER_EMAIL — this looks"
    echo "  like a shared/service mailbox, not an individual user."
    echo "  The deploy will succeed but you may be building on top of the"
    echo "  wrong identity. If that isn't what you intend, Ctrl-C now and:"
    echo "    gws auth logout && gws auth login"
    echo ""
    read -r "reply?Continue anyway? [y/N] "
    [[ "$reply" == "y" || "$reply" == "Y" ]] || exit 1
    ;;
esac

# --- Preflight: required scopes --------------------------------------------
missing_scopes=()
for scope in "${REQUIRED_SCOPES[@]}"; do
  if ! printf '%s\n' "$SCOPES" | grep -qxF "$scope"; then
    missing_scopes+=("$scope")
  fi
done
if (( ${#missing_scopes[@]} > 0 )); then
  fail "Current gws token is missing required scopes." \
    "Missing:" \
    "  ${missing_scopes[*]}" \
    "" \
    "This means the GCP project '$PROJECT_ID' does not have the Apps Script" \
    "scopes on its OAuth consent screen." \
    "" \
    "Fix (one-time):" \
    "  1. gcloud services enable script.googleapis.com --project=$PROJECT_ID" \
    "  2. GCP Console → APIs & Services → OAuth consent screen → Scopes →" \
    "     Add:  https://www.googleapis.com/auth/script.projects" \
    "     Add:  https://www.googleapis.com/auth/script.deployments" \
    "  3. gws auth logout && gws auth login" \
    "" \
    "Or provision a fresh dedicated project:" \
    "  gws auth setup --project <NEW_PROJECT_ID> --login"
fi

echo "gws preflight OK — user=$USER_EMAIL  project=$PROJECT_ID"

# --- 1) Ensure a script project exists -------------------------------------
if [[ -f "$STATE" ]]; then
  SCRIPT_ID="$(jq -r .scriptId "$STATE")"
  echo "Reusing existing script id: $SCRIPT_ID"
else
  echo "Creating new Apps Script project: $TITLE"
  CREATE_JSON="$(gws script projects create --json "{\"title\":\"$TITLE\"}")"
  SCRIPT_ID="$(echo "$CREATE_JSON" | jq -r .scriptId)"
  [[ -n "$SCRIPT_ID" && "$SCRIPT_ID" != "null" ]] || fail \
    "Failed to create project. Response:" "$CREATE_JSON"
  echo "{\"scriptId\":\"$SCRIPT_ID\",\"title\":\"$TITLE\"}" > "$STATE"
  echo "Wrote $STATE"
fi

# --- 2) Upload local files -------------------------------------------------
echo "Pushing files from $ROOT …"
gws script +push --script "$SCRIPT_ID" --dir "$ROOT"

# --- 3) Cut an immutable version ------------------------------------------
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Creating version…"
VERSION_JSON="$(gws script projects versions create \
  --params "{\"scriptId\":\"$SCRIPT_ID\"}" \
  --json   "{\"description\":\"gmove $STAMP\"}")"
VERSION="$(echo "$VERSION_JSON" | jq -r .versionNumber)"
[[ -n "$VERSION" && "$VERSION" != "null" ]] || fail \
  "Version creation failed. Response:" "$VERSION_JSON"
echo "Version $VERSION created."

# --- 4) Deploy that version as a web-app ----------------------------------
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
  echo "No web-app entry point returned. The manifest's 'webapp' block may"
  echo "need updating, or the project has not been authorized yet — open the"
  echo "editor once to trigger consent:"
  echo "  open \"https://script.google.com/d/$SCRIPT_ID/edit\""
fi
