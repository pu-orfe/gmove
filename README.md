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
clasp create --title "Drive Ownership Transfer" --rootDir .

# Push and deploy
./deploy.sh
```

> `clasp create` has no `webapp` project type — valid `--type` values are
> `standalone` (default), `docs`, `sheets`, `slides`, `forms`, `api`.
> "Web app" is an *entry point*, defined by the manifest's `webapp` block
> (already present in `appsscript.json`) and published by `clasp deploy`.
> If you pass `--type webapp` clasp errors with `Invalid container file type`.

`deploy.sh` runs `clasp push -f` then `clasp deploy --description "…"`,
parses the resulting deployment ID out of the output, and prints the
direct web-app URL (`https://script.google.com/macros/s/<id>/exec`).

> **clasp v3 note.** `clasp open` was removed in v3 — commands were split
> into `clasp open-script`, `clasp open-web-app <deploymentId>`,
> `clasp open-logs`, `clasp open-container`, `clasp open-api-console`,
> and `clasp open-credentials-setup`. `clasp deployments` still lists
> deployments.

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
./update.sh                # tests → push → update the current deployment IN PLACE
./update.sh --fresh        # tests → teardown all → deploy a new version (new URL)
./update.sh --skip-tests   # skip the Docker test step (for tight iteration)
GMOVE_CLI=gws ./update.sh  # use gws instead of clasp (requires §2b setup)
```

Default `./update.sh` keeps the deployment URL stable — it detects the
existing highest-numbered deployment (via `clasp deployments`) and calls
`clasp deploy --deploymentId <id>` to update it in place. Anyone you have
already shared the URL with keeps working after each update.

`--fresh` is the "start over" mode: it runs `./teardown.sh --yes` (which
undeploys everything) and then `./deploy.sh` (which creates a brand-new
versioned deployment with a new URL). Use it after a manifest change that
you want to be certain shipped, or when cleaning up an experiment.

### 2d. Undeploying (clasp path)

```sh
./teardown.sh
```

Lists current deployments and prints the exact `clasp undeploy` command
to tear a specific one down.

## 3. Runtime behavior

- **Browse (Phase 1)** is fully read-only. The client calls `browseFolder`
  once per expansion, and each call lists only the immediate children of
  that folder. There is no upfront full-tree scan. Shared-drive items whose
  `getOwner()` throws are captured with `owner: ""` and marked
  non-transferable rather than failing the walk. Each `browseFolder`
  response is capped at 500 children; larger folders return `truncated:
  true` and the UI surfaces a note.
- **My Drive shortcut.** For users who do not know how to fetch a folder
  ID out of a Drive URL, a **Browse My Drive** button calls
  `getMyDriveRoot()` (which is just `DriveApp.getRootFolder()` on the
  server), populates the target-folder-ID field with the returned id, and
  loads the tree from there. Shared drives are NOT reachable this way —
  a shared-drive folder ID still has to be pasted in manually.
- **Preview / dry run.** After selecting anything, the **Preview transfer
  (dry run)** button hits a read-only server RPC (`previewTransfer`) that
  runs the exact same subtree walk and merge as the real commit would, but
  persists nothing. The preview card shows how many items will transfer
  (folders + files), how many will be skipped as not-owned, the serialized
  state size (with a red warning if it exceeds the 400 KB ceiling that
  would cause the real commit to reject), and two collapsible lists of the
  actual items. Any selection change invalidates and hides the preview so
  a stale plan can never be confused for the current one. Preview is
  optional — you can still commit directly — but it's the explicit
  Phase-1-dry-run affordance the original spec called for.
- **Dry-run report emailed.** Every preview also emails a report to the
  initiator: the same summary metrics, the full would-transfer and
  would-skip tables (not truncated at 500 like the browser card is), and
  a CSV audit attached. Subject line is prefixed `[DRY RUN]` so filters
  can sort it away from the production-run report. If MailApp bounces
  (typically a daily-quota trip), the client status line calls out the
  error but the preview card still renders — the RPC's real product is
  the summary, the email is a persistent copy.
- **"Folder → everything inside" invariant.** Picking a folder in the tree
  transfers every transferable file and subfolder inside it. Descendants
  visibly lock (checkbox forced on and disabled) so you cannot deselect a
  single file inside a selected folder — Drive requires per-item
  ownership transfers, and a folder selection that skipped a contained file
  would leave the file orphaned under the new owner's folder. The
  invariant is enforced twice: client-side by the lock, and server-side by
  the fact that `commitTransfer` has no "deselect" vocabulary at all — it
  walks each `recursiveIds` subtree in full via DriveApp regardless of what
  the client sends.
- **Transfer order.** Inside a run, folders are transferred *before* their
  contained files. That way, if the run has to hand off to a resume trigger
  mid-batch, no orphaned file sits inside a still-old-owner folder for
  longer than necessary.
- **Silent transfers, on by default.** `DriveApp.setOwner()` sends a
  "You have been added as an owner" notification per item with no way to
  opt out — a batch of hundreds of items carpets the new owner's inbox.
  `attemptTransfer_` instead calls Drive REST API v3
  (`POST /files/{id}/permissions` with `transferOwnership=true`) through
  `UrlFetchApp` using the OAuth token Apps Script already holds. A
  **Notify new owner by email** checkbox in the Configure section
  controls the `sendNotificationEmail` query parameter — unchecked (the
  default) means no mail per item; checked means one mail per item.
  The flag is threaded through `state.notifyNewOwner` so a checkpointed
  run's resume respects the choice you made when you clicked Confirm.
  This uses the `script.external_request` scope — expect a one-time
  re-authorization prompt on first commit.
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

## 4. Access allowlist

Manifest access is `webapp.access: DOMAIN` — only `princeton.edu` accounts
can hit the URL. On top of that, an in-code allowlist restricts the app
further to a named list of users; anyone else in the domain sees a
"not authorized" page instead of the app.

The list lives at the top of `Code.gs`:

```javascript
var SETTINGS = {
  ALLOWED_USERS: [
    'bino@princeton.edu',
    'orfe-files@princeton.edu',
    'cdreyer@princeton.edu'
  ],
  SUPPORT_CONTACT: 'bino@princeton.edu'
};
```

Two ways to change membership:

1. **Code + deploy.** Edit `SETTINGS.ALLOWED_USERS`, run `./update.sh`. This
   is the version-controlled option and the one an audit trail can point
   to.
2. **ScriptProperty override.** Set a ScriptProperty named
   `gmove.allowed_users` to a comma-separated list of emails (in the
   Apps Script editor: **Project Settings → Script Properties**). When
   set, this overrides the in-code list and takes effect immediately —
   no deploy needed. Deleting the property reverts to the in-code list.

Matching is case-insensitive and whitespace-trimmed. Rejections are logged
to Stackdriver (`clasp open-logs`) with the attempted email — you'll want
this trail if someone reports being unable to get in.

The allowlist is enforced in three places: `doGet` (page load), and both
RPCs (`browseFolder`, `commitTransfer`). A user who was authorized at page
load and removed mid-session cannot use the RPC surface. `resumeTransfer`
— the time-driven trigger handler — is NOT gated, because triggers run
with no active user.

## 5. OAuth scopes

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

## 6. Theming

Paper Tiger tokens live at the top of `Styles.html`:

```
Theme Profile:              Paper Tiger — Princeton ORFE (fontset2, flavor1, btn-v1)
Style Repository / Assets:  https://github.com/pu-orfe/paper-tiger
```

To re-theme, replace the `:root { … }` token block and the `.pt-*`
component rules in `Styles.html`. The tree-view and status styles at the
bottom of the file consume tokens only and do not need to change.

## 7. Troubleshooting

- **"You do not have permission to call setOwner"** — the item is not
  actually owned by the caller. The UI should already have flagged it as
  non-transferable; if it did not, re-scan (owner can change between
  scans).
- **"Service invoked too many times in a short time"** — Drive quotas hit.
  Wait 60 seconds; the resume trigger will pick up automatically.
- **Timeout at exactly 6:00** — you're hitting the hard Apps Script quota
  before `shouldCheckpoint()` fires. Lower `TIME_BUDGET_MS` in `Logic.gs`
  (e.g. from 4.5 → 3.5 minutes) and re-deploy.
- **No email arrived** — check the trigger list at `clasp open-script` →
  **Triggers** (in clasp v3), or the editor's Triggers tab directly. If a
  `resumeTransfer` trigger is still queued, the run is still in progress.
  Stackdriver logs — `clasp open-logs` — will show any `MailApp.sendEmail`
  failure.

## 8. Notes

- `MEMORY.md`, `.claude/`, and `.env*` are git-ignored. Do not commit
  agent-authored planning artifacts alongside the code.
- The repo is public at [pu-orfe/gmove](https://github.com/pu-orfe/gmove);
  the web-app is `access: DOMAIN` so publishing the source does not
  expose the runtime.
