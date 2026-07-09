# gmove — Google Drive ownership transfer

A container-bound Google Apps Script web app that recursively transfers
ownership of Drive folders and files within a single Workspace org. It runs
in two phases:

1. **Scan** — a read-only inventory that builds a tree of everything under the
   target folder and pre-marks each item as *transferable* (the active user
   owns it) or *not owned* (someone else does).
2. **Confirm & Transfer** — a scoped production run against the boxes the
   user actually checked, with `PropertiesService`-based checkpointing so
   large jobs survive the six-minute Apps Script quota, and an emailed HTML +
   CSV report at the end.

Themed to [pu-orfe/paper-tiger](https://github.com/pu-orfe/paper-tiger)
(Princeton ORFE, `fontset2` / `flavor1` / `btn-v1`). All theme rules live in
`Styles.html`; swap that one file to re-theme.

## Repository layout

```
gmove/
├── appsscript.json         Manifest — OAuth scopes, web-app settings, Advanced Drive v3
├── Code.gs                 Server entrypoints: doGet, scanDirectory, commitTransfer, resumeTransfer
├── Logic.gs                Framework-free helpers (isTransferable, batching, HTML report, CSV)
├── Index.html              Web UI shell
├── Styles.html             Paper Tiger tokens + pt-* components (single theme swap point)
├── JavaScript.html         Client-side tree rendering, cascading toggles, RPC calls
├── tests/
│   ├── logic.test.js       Node --test suite over Logic.gs
│   ├── load-logic.js       Loads Logic.gs into a Node module for testing
│   └── package.json
├── Dockerfile              Alpine + Node 20 for containerized test runs
├── docker-compose.yml
├── deploy-gws.sh           macOS zsh: googleworkspace-cli (gws) create/push/version/deploy
├── deploy.sh               macOS zsh: clasp login/create/push/deploy (alternative)
├── update.sh               tests → push → deploy
└── teardown.sh             list / undeploy web-app versions
```

## Prerequisites

- macOS (primary), Linux, or WSL. Native zsh on macOS is the default target.
- Node 20+ for local tests (`node --test` is used, no dependencies).
- Docker Desktop or Colima for containerized tests. Docker Compose is invoked
  as `docker-compose` per project convention.
- A Google Workspace account. Ownership transfer only works between accounts
  in the same organization.
- **CLI to deploy** — pick one; both work at the individual-user level, no
  Workspace-admin rights required:
    - `googleworkspace-cli` (recommended): `brew install googleworkspace-cli`
      then `gws auth login`. Ships as `gws`. All deploy steps in section 2a
      are user-scoped OAuth calls to the Apps Script API — no admin console
      access needed.
    - `clasp` (Google's official Apps Script CLI): `npm install -g @google/clasp`
      then `clasp login`. See section 2b.
- `jq` on PATH (for the gws script's JSON parsing): `brew install jq`.

## 1. Testing

### 1a. Run tests locally (fastest)

```sh
cd tests
node --test
```

Expected: `11 pass, 0 fail`. All tests are pure-JS assertions over
`Logic.gs`; no Google APIs are involved.

### 1b. Run tests inside Docker (CI parity)

```sh
docker-compose build tests
docker-compose run --rm tests
```

Same 11 tests, same output, executed inside a clean `node:20-alpine` image.
This is what CI should run.

### 1c. Manual UI smoke test

Apps Script cannot be run outside the platform, so UI verification is manual
after deploy. Open the deployed web-app URL and confirm:

1. The header bar renders with a dark background and a Princeton-orange
   underline under the H1.
2. Entering a bogus folder ID and clicking **Scan Directory** produces a
   red error message via `pt-status--error`.
3. Entering a valid ID renders a tree with checkboxes, and items owned by
   someone else show a `pt-badge` reading `Owned by … — will skip`.
4. Toggling a parent folder cascades to its children (checkbox state
   propagates recursively).
5. The counter row above the tree updates as you toggle.

Type checking and unit tests verify code correctness, not feature
correctness — you must run this UI smoke pass before treating a deploy as
done.

## 2. Deploy to Apps Script (production)

### 2a. Deploy with `googleworkspace-cli` (recommended, no admin needed)

Every step below is a user-scoped OAuth call — no Workspace-admin console
access is required. This is the shortest path from a fresh repo to a live
web-app URL.

```sh
# One-time: install and log in
brew install googleworkspace-cli jq
gws auth login              # opens browser; log in as the user who will run transfers
gws auth status             # sanity check

# Enable the Apps Script API for your user (required exactly once per Google
# account, done through the personal user-settings page, not the admin console):
open "https://script.google.com/home/usersettings"
# Toggle "Google Apps Script API" → ON.

# One-shot: create the project, push files, cut a version, deploy the web app
./deploy-gws.sh
```

What `deploy-gws.sh` does under the hood:

1. `gws script projects create --json '{"title":"Drive Ownership Transfer"}'`
   — creates a standalone script project, writes the resulting `scriptId`
   to `.gws.json` (git-ignored). If `.gws.json` already exists the step is
   skipped and the existing project is reused.
2. `gws script +push --script "$SCRIPT_ID" --dir .` — uploads every
   `*.gs`, `*.html`, and `appsscript.json` in this directory.
3. `gws script projects versions create --params '{"scriptId":"…"}'`
   — cuts an immutable version off the current code.
4. `gws script projects deployments create --params '{"scriptId":"…"}' \
   --json '{"versionNumber":N,"description":"…","manifestFileName":"appsscript"}'`
   — publishes the version as a web-app. The response includes the
   `webApp.url` you hand to end users.

Rerun `./deploy-gws.sh` any time — steps 2-4 re-run and produce a fresh
deployment against the same script id.

**Consent gate.** The very first invocation of the web-app URL triggers
Google's OAuth consent screen because the manifest requests Drive/Mail
scopes. This is *user* consent, not admin consent — each caller sees the
dialog once. Add screenshots to your rollout docs if you're onboarding a
team.

**Advanced Drive Service.** The manifest already enables Drive v3 as an
Advanced Service. `gws +push` uploads the manifest verbatim, so this is
already handled — you do NOT need to visit the Apps Script editor unless
you want to.

To tear down a deployment:

```sh
SCRIPT_ID="$(jq -r .scriptId .gws.json)"
gws script projects deployments list --params "{\"scriptId\":\"$SCRIPT_ID\"}" --format table
gws script projects deployments delete --params "{\"scriptId\":\"$SCRIPT_ID\",\"deploymentId\":\"<id>\"}"
```

### 2b. Deploy with `clasp` (alternative)

```sh
# One-time setup
npm install -g @google/clasp
clasp login
open "https://script.google.com/home/usersettings"   # enable Apps Script API
clasp create --title "Drive Ownership Transfer" --type webapp --rootDir .

# Push and deploy
./deploy.sh
```

`deploy.sh` runs `clasp push -f` then `clasp deploy --description "…"`;
inspect the resulting `/exec` URL with `clasp open` → **Deploy** →
**Manage deployments**.

### 2c. Iterating

```sh
./update.sh
```

Rebuilds the Docker test image, runs the tests, then re-pushes and
re-deploys using whichever CLI you set up. Edit the script to point at
`deploy-gws.sh` if you prefer the gws path (default is clasp for
historical reasons).

### 2d. Undeploying (clasp path)

```sh
./teardown.sh
```

Lists current deployments and prints the exact `clasp undeploy` command
to tear a specific one down.

## 3. Runtime behavior

- **Scan** is fully read-only. It calls `DriveApp.getFolderById()` and walks
  `getFolders()` / `getFiles()`. Shared-drive items whose `getOwner()`
  throws are captured with `owner: ""` and marked non-transferable rather
  than failing the walk.
- **Transfer order.** Inside a run, folders are transferred *before* their
  contained files. That way, if the run has to hand off to a resume trigger
  mid-batch, no orphaned file sits inside a still-old-owner folder for
  longer than necessary.
- **Batching.** Every ~4.5 minutes (see `TIME_BUDGET_MS` in `Logic.gs`) the
  server checkpoints the current state to `ScriptProperties` under key
  `gmove.state.v1` and schedules a one-shot time-driven trigger that calls
  `resumeTransfer()` 60 seconds later. On completion the state is cleared,
  the trigger is deleted, and the email report goes out. The user only
  needs to launch the run.
- **Failure handling.** Every `file.setOwner()` call is wrapped in a
  per-item `try/catch`; a locked item generates a `FAILED` row in the log
  but does not stop the batch.
- **Email report.** HTML body (Paper Tiger styling) with dashboard metrics
  and a failure-manifest table, plus the full log as a CSV attachment.
  Sent to the initiator's email — read from `Session.getActiveUser()`.

## 4. OAuth scopes

Declared in `appsscript.json`:

- `.../auth/drive` — read metadata, call `setOwner`.
- `.../auth/script.send_mail` — send the completion report via `MailApp`.
- `.../auth/script.scriptapp` — create and delete resume triggers.
- `.../auth/userinfo.email` — identify the initiator for the report.
- `.../auth/script.container.ui` — HTML Service.

The web-app is configured `executeAs: USER_ACCESSING` and
`access: DOMAIN` so that (a) each caller acts as themselves (`setOwner`
only works when the active user owns the file) and (b) only members of
your Workspace org can reach the URL.

## 5. Theming

Paper Tiger tokens live at the top of `Styles.html`:

```
Theme Profile:              Paper Tiger — Princeton ORFE (fontset2, flavor1, btn-v1)
Style Repository / Assets:  https://github.com/pu-orfe/paper-tiger
```

To re-theme, replace the `:root { … }` token block and the `.pt-*`
component rules in `Styles.html`. The tree-view and status styles at the
bottom of the file consume tokens only and do not need to change.

## 6. Troubleshooting

- **"You do not have permission to call setOwner"** — the item is not
  actually owned by the caller. The UI should already have flagged it as
  non-transferable; if it did not, re-scan (owner can change between
  scans).
- **"Service invoked too many times in a short time"** — Drive quotas hit.
  Wait 60 seconds; the resume trigger will pick up automatically.
- **Timeout at exactly 6:00** — you're hitting the hard Apps Script quota
  before `shouldCheckpoint()` fires. Lower `TIME_BUDGET_MS` in `Logic.gs`
  (e.g. from 4.5 → 3.5 minutes) and re-deploy.
- **No email arrived** — check the trigger list at `clasp open` →
  **Triggers**. If a `resumeTransfer` trigger is still queued, the run is
  still in progress. Stackdriver logs (Executions view) will show any
  `MailApp.sendEmail` failure.

## 7. Notes

- `MEMORY.md`, `.claude/`, and `.env*` are git-ignored. Do not commit
  agent-authored planning artifacts alongside the code.
- The repo is public at [pu-orfe/gmove](https://github.com/pu-orfe/gmove);
  the web-app is `access: DOMAIN` so publishing the source does not
  expose the runtime.
