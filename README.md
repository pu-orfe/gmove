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
├── deploy.sh               macOS zsh: clasp login/create/push/deploy  ← default
├── deploy-gws.sh           macOS zsh: googleworkspace-cli (gws) — alternative, see §2b
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
- **CLI to deploy** — `clasp` is the default. It uses Google's shared OAuth
  client, which already includes the Apps Script scopes, so no GCP
  project setup is required.
    - `clasp` (default): `npm install -g @google/clasp` then `clasp login`.
      See §2a.
    - `googleworkspace-cli` (advanced, only if you're already running a
      dedicated GCP project with the Apps Script API + scopes configured):
      `brew install googleworkspace-cli jq` then `gws auth login`. See §2b
      — there are real prerequisites; **do not use this path if your `gws`
      auth is currently pointed at a project that doesn't cover Apps
      Script**.

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

### 2a. Deploy with `clasp` (default and recommended)

`clasp` is Google's official Apps Script CLI. It authenticates against
Google's own OAuth client, which already includes the Apps Script scopes,
so no GCP project setup is needed and there's no consent-screen work.

```sh
# One-time setup
npm install -g @google/clasp
clasp login                  # opens browser; log in as YOU (not a shared/service mailbox)
open "https://script.google.com/home/usersettings"   # toggle Apps Script API → ON (per-user, once)
clasp create --title "Drive Ownership Transfer" --type webapp --rootDir .

# Push and deploy
./deploy.sh
```

`deploy.sh` runs `clasp push -f` then `clasp deploy --description "…"`.
Grab the resulting web-app URL from `clasp open` → **Deploy** →
**Manage deployments** (or `clasp deployments`).

**Consent gate.** The first invocation of the web-app URL triggers
Google's OAuth consent screen because the manifest requests Drive/Mail
scopes. This is *user* consent, not admin consent — each caller sees the
dialog once.

**Advanced Drive Service.** The manifest already enables Drive v3 as an
Advanced Service. `clasp push` uploads the manifest verbatim, so this is
handled — you do not need to open the Apps Script editor unless you want
to.

### 2b. Deploy with `googleworkspace-cli` (advanced — see prerequisites first)

**Read this whole section before running `./deploy-gws.sh`.**

`gws` is a general-purpose Workspace CLI and does **not** ship with a
pre-configured OAuth client for Apps Script. It authenticates against
whatever GCP project the local `client_secret.json` belongs to. If that
project's OAuth consent screen doesn't include the Apps Script scopes,
every `gws script projects …` call returns `403 insufficient_scope` after
you log in — even though the login itself succeeds.

**Common failure mode.** Running `gws auth login` when your local `gws`
config points at an unrelated GCP project (a common example inside ORFE:
`orfe-calendars-api`) will:

- prompt you to sign in as the **shared/service mailbox** that owns the
  project (`orfe-calendars@princeton.edu`, not you), and
- issue a token that is missing `https://www.googleapis.com/auth/script.projects`
  and `.../auth/script.deployments`.

Both of those are unrecoverable with a second login. If you see the URL
starting with `client_id=584162953183-…` when you run `gws auth login`,
that is the `orfe-calendars-api` client — **Ctrl-C**. Do not proceed.

**What you must provision before using this path:**

1. A dedicated GCP project (or an existing one you're willing to modify).
2. Apps Script API enabled on it:
   ```sh
   gcloud services enable script.googleapis.com --project=<PROJECT_ID>
   ```
3. `script.projects` and `script.deployments` scopes added to the OAuth
   consent screen: GCP Console → APIs & Services → OAuth consent screen →
   **Scopes** → **Add or Remove Scopes** → add both.
4. `gws` pointed at *that* project, not a leftover one. The cleanest way:
   ```sh
   gws auth logout
   gws auth setup --project <PROJECT_ID> --login
   ```
   `--login` runs `gws auth login` at the end.

Once the project is set up, run:

```sh
brew install googleworkspace-cli jq
./deploy-gws.sh
```

`deploy-gws.sh` runs a preflight check that verifies (a) `gws` is
installed, (b) you're logged in, (c) the current token carries the
`script.projects` and `script.deployments` scopes, and (d) `.gws.json`
either exists or can be created. It refuses to touch the API if any of
those fail, and prints exactly which of the steps above to run.

The mechanics under the hood, after preflight:

1. `gws script projects create --json '{"title":"Drive Ownership Transfer"}'`
   — creates a standalone script project, writes the resulting `scriptId`
   to `.gws.json` (git-ignored). Reused on subsequent runs.
2. `gws script +push --script "$SCRIPT_ID" --dir .` — uploads every
   `*.gs`, `*.html`, and `appsscript.json` in this directory.
3. `gws script projects versions create` — cuts an immutable version.
4. `gws script projects deployments create` — publishes the version as
   a web-app. The response includes the `webApp.url`.

To tear down a deployment:

```sh
SCRIPT_ID="$(jq -r .scriptId .gws.json)"
gws script projects deployments list \
  --params "{\"scriptId\":\"$SCRIPT_ID\"}" --format table
gws script projects deployments delete \
  --params "{\"scriptId\":\"$SCRIPT_ID\",\"deploymentId\":\"<id>\"}"
```

### 2c. Iterating

```sh
./update.sh
```

Rebuilds the Docker test image, runs the tests, then re-pushes and
re-deploys via `deploy.sh` (clasp) by default. Set `GMOVE_CLI=gws` to use
the gws path — only do so once §2b has been fully satisfied.

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
