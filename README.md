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
├── deploy.sh               macOS zsh: clasp login/create/push/deploy
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
- **CLI to deploy** — `clasp`. It uses Google's shared OAuth
  client, which already includes the Apps Script scopes, so no GCP
  project setup is required. Run: `npm install -g @google/clasp` then `clasp login`.

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

### 2a. Iterating

```sh
./update.sh                # tests → push → update the current deployment IN PLACE
./update.sh --fresh        # tests → teardown all → deploy a new version (new URL)
./update.sh --skip-tests   # skip the Docker test step (for tight iteration)
```

Default `./update.sh` keeps the deployment URL stable — it detects the
existing highest-numbered deployment (via `clasp deployments`) and calls
`clasp deploy --deploymentId <id>` to update it in place. Anyone you have
already shared the URL with keeps working after each update.

`--fresh` is the "start over" mode: it runs `./teardown.sh --yes` (which
undeploys everything) and then `./deploy.sh` (which creates a brand-new
versioned deployment with a new URL). Use it after a manifest change that
you want to be certain shipped, or when cleaning up an experiment.

### 2b. Undeploying

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
- **Where the transferred items land.** Every transfer goes through Drive
  REST v3 (`POST /files/{id}/permissions` with `transferOwnership=true`)
  via `UrlFetchApp` — not `DriveApp.setOwner`. That gives us
  `moveToNewOwnersRoot=true`, which is applied only to items the user
  picked directly (recursive-folder roots + explicit items — the
  `moveToRoot` flag on each plan entry, computed by `mergeSelection`).
  Descendants pulled in by the walk keep their existing parent, so the
  subtree structure survives the transfer intact — a `Project-X/` folder
  moves as one thing to the new owner's My Drive, with all its files still
  inside it.
- **Per-item notifications are unavoidable + one summary email to the new
  owner.** Drive's REST API rejects the combination
  `transferOwnership=true` + `sendNotificationEmail=false` with the exact
  error *"sendNotificationEmail parameter is only applicable for
  permissions of type 'user' or 'group', and must not be disabled for
  ownership transfers"*. There is no override; suppressing the mail is
  simply not allowed for ownership transfers. So every item's transfer
  fires a "you have been added as an owner" notification to the new
  owner, and a large batch to a single recipient will hit Drive's
  per-recipient rate limit (empirically ~100 in a short window) —
  producing HTTP 400s with *"Sorry, the items were successfully shared
  but emails could not be sent..."*. `isDriveNotificationOnlyFailure()`
  in Logic.gs matches that message; those items are reclassified as
  SUCCESS in the report because the ownership change actually went
  through (only the notification mail was throttled).

  As a partial mitigation, `sendNewOwnerReport_` sends ONE consolidated
  summary to the new owner once the whole job finishes: a
  Paper-Tiger-styled HTML body with counts and My Drive root items,
  plus a CSV attachment listing every transferred item with a direct
  `drive.google.com/open?id=<id>` link. Even if the new owner filters
  or ignores the barrage of per-item notifications, this single summary
  gives them the complete list and a fallback locator per item.
  Best-effort — a MailApp failure here is `console.error`'d but does
  not block job cleanup.
- **Old owner loses their folder view.** Because top-level items move to
  the new owner's My Drive root, they disappear from the initiator's
  folder tree. The initiator retains editor access (Drive adds them as a
  writer when ownership transfers away), so they can still open the items
  via "Shared with me" or a direct link — they just are not in the
  original folder anymore. The client confirmation dialog spells this out
  before commit.
- **Job queue is visible to everyone allowlisted.** The `0 · Job queue`
  card at the top of the page shows every job currently running or
  queued, initiator → new owner, folder, progress bar, and a status pill.
  All allowlisted users see all jobs. The client polls `listJobs()`
  every 8 s while the registry is non-empty, respects the tab's
  visibility state (no polling when backgrounded), and refreshes
  immediately when the tab returns to visible. The RPC is cached at the
  server for 2 s via `CacheService` so N pollers do not translate to N
  ScriptProperties reads.
- **Jobs run one at a time.** ScriptProperties holds a small
  `gmove.jobs.registry.v1` list of active jobs; each job's plan + log
  live under `gmove.jobs.state.<jobId>`. Only one is ever in
  `status: 'running'` — new commits during an active run land as
  `queued` and get promoted by the resume-trigger cycle when the current
  job finishes. All registry mutations and trigger creations sit inside a
  `LockService.getScriptLock()` critical section so two overlapping
  commits cannot corrupt each other. This was a real bug in the previous
  single-key state design.
- **No history — email is the record.** A completed job is dropped from
  the registry (and its per-job state key deleted) the instant its report
  email sends. If MailApp throws (daily quota trip, malformed body,
  etc.), the job stays in the registry as `report_pending` and the state
  key survives; the next resume trigger retries the send. The queue view
  never lies about "the job is gone" when the record was never sent.
- **Failure diagnostics.** Every non-2xx Drive API response is logged to
  Stackdriver via `console.error` with the item id/name/path, the HTTP
  status, the flag values sent, and the full Drive JSON response body.
  When a transfer fails, `clasp open-logs` gives you the exact reason
  Drive rejected it rather than a wrapped Apps Script exception.
- **Notification-throttle detector is retained as a safety net.** Even
  though `sendNotificationEmail=false` is now the default and the
  throttle should never fire, `isDriveNotificationOnlyFailure()` still
  matches Drive's *"Sorry, the items were successfully shared but emails
  could not be sent..."* response. If Drive ever changes behavior and
  starts firing notifications despite the flag, the transfer will still
  be recorded as SUCCESS rather than a spurious FAILED. Logged as
  `console.info`, not `console.error`, so the signal stays clean.
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

The access list and support contact are configured via environment variables inside `.env` (locally) and GitHub repository secrets (in CI).

At deployment time, the deployment scripts (`./deploy.sh` or `./update.sh`) read these environment variables and compile them into a `Config.gs` file, which is pushed to script.google.com but ignored by Git:

```javascript
function initializeConfigProperties() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('gmove.allowed_users', '...');
  props.setProperty('gmove.support_contact', '...');
}
```

This configures them directly into Google Apps Script's `ScriptProperties` service.

To update membership:
1. **Local deploy**: Add or update `GMOVE_ALLOWED_USERS` or `GMOVE_SUPPORT_CONTACT` inside `.env`, then run `./update.sh`.
2. **CI / CD (GitHub Actions)**: Update your repository's environment secrets and let CI handle the deploy.
3. **Manual Override**: You can also set/override `gmove.allowed_users` and `gmove.support_contact` directly inside the Apps Script editor under **Project Settings → Script Properties**.

Matching is case-insensitive and whitespace-trimmed. Rejections are logged
to Stackdriver (`clasp open-logs`) with the attempted email — you'll want
this trail if someone reports being unable to get in.

The allowlist is enforced in three places: `doGet` (page load), and both
RPCs (`browseFolder`, `commitTransfer`). A user who was authorized at page
load and removed mid-session cannot use the RPC surface. `resumeTransfer`
— the time-driven trigger handler — is NOT gated, because triggers run
with no active user.

## 5. OAuth scopes

Declared explicitly in `appsscript.json` — do NOT let a linter strip
this block. If the manifest lacks `oauthScopes`, Apps Script auto-
infers them from code usage on a per-user basis at consent time. That
sounds fine but breaks stale returning users: a user who consented to
an earlier version of the code never gets prompted to grant scopes the
newer code needs. Explicit `oauthScopes` fixes this — Apps Script
detects the scope-set change on deploy and prompts every user through
a fresh consent flow on their next visit.

Declared scopes:

- `.../auth/drive` — read metadata, walk folders, call the
  `permissions.create` REST endpoint via UrlFetchApp.
- `.../auth/script.external_request` — `UrlFetchApp.fetch` to
  `https://www.googleapis.com/drive/v3/files/…/permissions`. This is
  the scope that was silently added when we moved off `DriveApp.setOwner`;
  users who consented before that change hit
  `"You do not have permission to call UrlFetchApp.fetch. Required
   permissions: …/script.external_request"` at transfer time.
- `.../auth/script.send_mail` — completion report + new-owner summary
  via `MailApp`.
- `.../auth/script.scriptapp` — `ScriptApp.newTrigger` for the resume-
  batch time-driven trigger fallback.
- `.../auth/userinfo.email` — `Session.getActiveUser().getEmail()`
  identifies the caller for the allowlist check and the report.

The web-app is configured `executeAs: USER_ACCESSING` and
`access: DOMAIN` so that (a) each caller acts as themselves (transferring
ownership only works when the caller owns the file) and (b) only members
of your Workspace org can reach the URL.

### Recovering a stale user

If a returning user hits *"You do not have permission to call ..."* on
any action, their OAuth grant is missing a scope the current code
needs. Fastest recovery:

1. Visit <https://myaccount.google.com/permissions>
2. Find the app entry — usually labelled by the Apps Script project
   title (e.g. **Drive Ownership Transfer**) or the linked GCP project
   name.
3. Click through → **Remove Access**.
4. Return to the web-app URL. Google prompts for consent freshly,
   including every scope declared in the current manifest.
5. Approve → retry the failing action.

Note: after a deploy that changes the manifest's `oauthScopes` list,
Apps Script generally prompts existing users through a re-consent
automatically on next visit. Manual revoke is only needed when the
inferred-scopes path was used previously and the user's grant is
frozen in an old state.

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

**Diagnostic surface.** `clasp open-logs` requires a properly-linked GCP
project (see §2 verification checklist); if you never linked one, that
command errors and you should ignore it. The primary surfaces are:

- **Editor Executions tab.** `clasp open-script` → the clock icon in the
  left sidebar. Every recent function invocation (including trigger-fired
  `resumeTransfer` runs) shows here with its start time, duration, and
  Completed/Failed/Running status. If you see `resumeTransfer` runs
  ticking every ~5 minutes with Completed status, your batch is churning.
- **Editor Triggers tab.** Same sidebar, next icon down. Shows every
  scheduled trigger. During a run there should be exactly one
  `resumeTransfer` trigger listed.
- **In-editor logs.** Open `Code.gs`, click **Run** on any function, then
  **View → Logs** to see recent `console.info`/`error` output. Diagnostic
  functions below all log via `console`.

**Diagnostic functions to run from the Apps Script editor** (Function
dropdown → pick, then Run). All are also visible in the Function menu.

- `debugState()` — dumps the jobs registry, per-job state key presence,
  orphan state keys, resume-trigger count, and whether the legacy
  `gmove.state.v1` key is lingering. Read-only. First thing to run if
  the queue looks wrong.
- `nudgeResume()` — synchronously invokes `runBatch_()`. Use when
  `debugState()` shows a running job but no `resumeTransfer` trigger, or
  when a trigger has died. Safe to call any time — no-op if nothing is
  pending.
- `debugClearAllJobs()` — nuclear option. Deletes the jobs registry, all
  per-job state keys, and every `resumeTransfer` trigger. Does NOT undo
  Drive changes; only clears tracking state. Use only if `debugState`
  shows a fundamentally corrupted run that will not clear otherwise.

**Common paths to look up:**

- **Job stuck at 0/N** — the queue only updated `processed` at the 4.5-min
  checkpoint until r16; from r16 forward it updates every 10 items.
  On older code, `nudgeResume()` and watch the Executions view.
- **"You do not have permission to call setOwner"** — the item is not
  actually owned by the caller. The UI should have flagged it as
  non-transferable; if it did not, re-scan (owner can change between
  scans).
- **"Service invoked too many times in a short time"** — Drive quotas hit.
  Wait 60 seconds; the resume trigger will pick up automatically.
- **Timeout at exactly 6:00** — you're hitting the hard Apps Script quota
  before `shouldCheckpoint()` fires. Lower `TIME_BUDGET_MS` in `Logic.gs`
  (e.g. from 4.5 → 3.5 minutes) and re-deploy.
- **No email arrived** — check the trigger list at `clasp open-script` →
  **Triggers**. If a `resumeTransfer` trigger is queued, run is still in
  progress. Otherwise run `debugState()`; if any job has status
  `report_pending`, `nudgeResume()` will retry the mail send.
