# Symphony

Symphony is a long-running orchestration service that polls an issue tracker,
manages per-issue workspaces, and runs coding-agent sessions with deterministic
retry and reconciliation behavior.

This repository is driven by SPEC and PRD artifacts. The current implementation
includes workflow loading/validation, orchestrator runtime logic, local worker
execution, and a local observability API with an embedded dashboard. Symphony
implements the base contract in `SPEC.md` plus documented local extensions in
`SPEC.ext.md`.

## Current Status

- Core implementation and parity hardening phases are merged on `main`; Codex
  remains the default agent runtime and the local Claude CLI runtime is opt-in.
- Canonical requirements and governance evidence live in `SPEC.md`, `SPEC.ext.md`,
  and `docs/prd/`.

## Quick Start

1. Install dependencies:

	```bash
	npm install
	```

2. Build:

	```bash
	npm run build
	```

3. Run tests:

	```bash
	npm test
	```

	Run `npm run test:integration` when changing git, worktree, or
	process-heavy behavior.

	Use `npm run test:full` for release or Agent Review evidence.

## Workflow Learning Path

Start here for a practical end-to-end workflow:

1. Todo app tutorial (issue backlog -> Codex execution -> verification):
	`docs/tutorials/todo-app-end-to-end.md`
2. Linear workflow playbook:
	`docs/playbooks/linear-workflow-playbook.md`
3. GitHub workflow playbook:
	`docs/playbooks/github-workflow-playbook.md`
4. Integrate with your own application:
	`docs/playbooks/integrate-your-application.md`
5. Monitoring and recovery runbook:
	`docs/playbooks/operations-runbook.md`

Workflow preset examples for prompt and tracker configuration:

- `docs/examples/workflow-presets/linear-todo-workflow.md`
- `docs/examples/workflow-presets/github-todo-workflow.md`

Tracker seed examples for bootstrapping issue backlogs:

- `tests/fixtures/tracker-seeds/linear-todo-issues.json`
- `tests/fixtures/tracker-seeds/github-todo-issues.json`

Generate import-ready payloads from seed files:

```bash
npm run bootstrap:tracker-seeds:linear
npm run bootstrap:tracker-seeds:github
```

Automatically create Linear issues from seed data:

```bash
export LINEAR_PROJECT_SLUG=SYMPHONY
npm run seed:linear
npm run seed:linear:apply
```

## Run Dashboard and API

The dashboard and API are served by the same local process.

### Standard Start

```bash
npm run start:dashboard -- --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

Default bind:

- Host: `127.0.0.1`
- Port: `3000`

Open:

- Dashboard: `http://127.0.0.1:3000/`

### Dynamic Port

```bash
npm run start:dashboard -- --port=0 --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

or

```bash
SYMPHONY_PORT=5050 npm run start:dashboard -- --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

### Local Adoption Doctor

Run the local doctor before starting a linked dashboard from a project checkout:

```bash
symphony doctor
symphony doctor --json
symphony doctor --ci
```

`symphony doctor` checks the PATH-linked `symphony` shim, the referenced
checkout and built CLI entrypoint, local workflow resolution, effective workflow
configuration, the `.env` path that would be loaded, host/port readiness,
high-trust setup consent, and dashboard supervisor prerequisites. It reports
paths and status only; it does not print `.env` values or consent-store
contents.

For generated workflows, doctor also reports project-local portable skill
provenance, selected skill installation, catalog helper scripts, relevant tool
or Linear credential prerequisites, and Codex app-server visibility when it can
be checked. Init copies portable skills into `.codex/skills/`, where Codex can
load project-local skills; `.symphony/skills/` and `.symphony/prompts/` remain
reserved, git-visible paths and are not active runtime skill-loading locations.

Provider-readiness checks report only whether a credential is present and which
source supplied it; they never print credential values.

Exit codes are stable for automation:

- `0`: clean, no findings.
- `1`: warning-only findings.
- `2`: blocker findings.

Use `--fix` for bounded local-adoption remediation. It can invoke local link
refresh for link-related findings and can record setup consent only when paired
with explicit approval (`--fix --yes`). It does not silently change project
runtime policy.

For the full local command workflow, including linking, PATH setup, high-trust
consent, update/unlink behavior, bounded `profile`/`init` surfaces, and the
cross-project smoke command, see
[`docs/playbooks/local-command-runbook.md`](docs/playbooks/local-command-runbook.md).

### Project Wrapper (Recommended for Multi-Project)

Use the wrapper to run Symphony against another repository's `WORKFLOW.md`
without remembering full startup flags:

```bash
npm run start:project-dashboard -- ../symphony-todo-app
```

Optional flags:

```bash
npm run start:project-dashboard -- ../symphony-todo-app --port 3001
npm run start:project-dashboard -- ../symphony-todo-app --offline
```

Behavior:

- Defaults to `--workflow=<app-repo>/WORKFLOW.md`
- Uses `--port=0` by default to avoid port collisions
- Always includes the required guardrail acknowledgment flag

### Script Aliases

These aliases intentionally launch the same local API/dashboard surface:

- `npm run start:api`
- `npm run start:web`

## Run Desktop App (macOS)

`start:desktop` launches a Tauri host that starts the same runtime-backed
dashboard backend and opens it in a native desktop window.

```bash
npm run start:desktop
```

Desktop packaging status:

```bash
npm run build:desktop
```

`build:desktop` now bundles a platform sidecar backend executable
(`symphony-backend`) into the Tauri app resources so packaged desktop artifacts
do not depend on a local repository checkout or Node installation.

Native desktop smoke automation:

```bash
npm run test:desktop:native-smoke
```

Desktop QA checklist:

- `docs/DESKTOP-QA.md`

Notes:

- The backend startup/shutdown is managed natively by the Tauri Rust host.
- Packaged desktop apps launch a bundled backend sidecar executable.
- Dev mode (`npm run start:desktop`) can still fall back to repo launcher behavior.
- The desktop shell targets local runtime URL `http://127.0.0.1:3000/`.
- Default workflow path is repository root `WORKFLOW.md`.
- Set `SYMPHONY_WORKFLOW_PATH` to point at a non-default workflow file if needed.
- Set `SYMPHONY_DESKTOP_PORT` (or `SYMPHONY_PORT`) to override desktop backend port.
- Export `LINEAR_API_KEY` before startup so tracker validation passes.
- For local UI-only startup without Linear credentials, set `SYMPHONY_OFFLINE=1`.
- Codex runtime can be customized via env without editing `WORKFLOW.md`:
  - `SYMPHONY_CODEX_HOME` (switch local Codex account/home directory)
  - `SYMPHONY_CODEX_MODEL` (override model)
  - `SYMPHONY_CODEX_REASONING` (override reasoning effort)
  - `SYMPHONY_CODEX_FLAGS` (append extra Codex CLI flags as a JSON string array, for example `["--config","shell_environment_policy.inherit=all"]`)
- `.env` is loaded automatically for startup scripts (or `SYMPHONY_ENV_FILE` for a custom file path).
- An opt-in local Claude CLI runtime can be selected entirely from the project `.env`:

  ```dotenv
  SYMPHONY_AGENT_RUNTIME=claude-cli
  ANTHROPIC_MODEL=claude-sonnet-4-6
  # SYMPHONY_CLAUDE_COMMAND=/opt/homebrew/bin/claude
  ```

  Codex remains the default. Claude support is pinned to CLI `2.1.224`, local
  macOS/Linux workers, and Team/Enterprise subscription authentication unless
  `SYMPHONY_CLAUDE_ALLOW_NON_SUBSCRIPTION_AUTH=true` is explicitly set. Run
  `symphony doctor` before opting in. Runtime selection is fixed at process
  startup, so `.env` changes require a restart. Claude receives prompts over
  stdin, has no Symphony turn or dollar cap inside one invocation, and inherits
  the process environment; use only in trusted workspaces where the inherited
  credential boundary is accepted.
- If backend startup fails, the desktop window now stays open and displays an actionable boot error instead of exiting hard.

## API Endpoints

### GET `/api/v1/state`

Returns current runtime summary:

- running, retrying, and blocked counts
- running session telemetry
- aggregate token and runtime totals
- latest rate-limit snapshot
- health banner fields (`dispatch_validation`, `last_error`)
- workspace provisioning integrity (`workspace_provisioned`, `workspace_is_git_worktree`)
- phase progress for running issues (`current_phase`, `current_phase_at`,
  `phase_elapsed_ms`, `phase_detail`)
- last known phase context for retrying/blocked issues (`last_phase`,
  `last_phase_at`, `last_phase_detail`)

Control-plane responsiveness can be stress-tested while synthetic Codex
transcripts are being written:

```bash
npm run stress:control-plane -- --api-url http://127.0.0.1:61026/api/v1/state --codex-home /path/to/codex-home
```

Use the same `SYMPHONY_CODEX_HOME` value as the running Symphony process when
validating transcript-scanner changes.

### GET `/api/v1/:issue_identifier`

Returns issue-specific runtime diagnostics:

- running or retrying status
- session fields and recent events
- retry metadata
- blocked-input metadata when status is `blocked`
- bounded execution timeline (`phase_timeline`) with per-attempt phase markers
- last known error

Unknown issue identifiers return `404` with typed error envelope.

### POST `/api/v1/refresh`

Queues manual poll and reconciliation trigger. Burst requests are coalesced.

### GET `/api/v1/events`

Server-Sent Events stream for realtime state snapshots and runtime health changes.

### GET `/api/v1/diagnostics`

Runtime diagnostics including logging, persistence health, runtime resolution, and workspace provisioner state.

Includes phase marker diagnostics:

- `phase_markers.enabled`
- `phase_markers.timeline_limit`
- `phase_markers.last_emit_error_code`

### POST `/api/v1/issues/:issue_identifier/resume`

Resumes an issue in blocked-input state and returns it to dispatch lifecycle.

## Project Structure

- `src/workflow/`: workflow loading, config resolution, validation, watching.
- `src/tracker/`: tracker adapter contracts and Linear implementation.
- `src/orchestrator/`: dispatch/retry/reconcile runtime state machine.
- `src/workspace/`: workspace creation, hooks, cleanup safety invariants.
- `src/codex/`: coding-agent app-server protocol client.
- `src/api/`: local HTTP server, snapshot projection, refresh coalescing.
- `src/observability/`: structured logging and sink failover behavior.
- `tests/`: deterministic coverage for all implemented subsystems.
- `docs/prd/`: PRD package, status tracker, traceability matrix.

## Development Commands

```bash
npm run build
npm test
npm run test:integration
npm run test:full
npm run test:verbose
npm run test:profile:slow
npm run test:runtime-guardrail
npm run test:e2e:web
npm run check:meta
git --no-pager diff --check
```

`npm test` is the fast deterministic unit gate. It keeps Vitest test identity,
pass/fail counts, and timing visible while suppressing routine operational
noise from helper Git commands, child-process stderr, and structured runtime
logs during passing runs. The fast gate excludes the slowest
git/worktree/process-heavy simulations identified by `npm run
test:profile:slow`; run `npm run test:integration` for those simulations, or
`npm run test:full` for the complete Vitest surface.

Use these commands by validation scope:

- Fast/local iteration: `npm test`
- Targeted proof: `npm test -- <file-or-filter>` for fast-path files, or `npm
  run test:full -- <file-or-filter>` when the target is intentionally outside
  the fast path.
- Integration simulations: `npm run test:integration`
- Agent Review, release handoff, broad runtime changes, or CI-equivalent local
  proof: `npm run build && npm run test:full`
- Runtime regression guardrail: `npm run test:runtime-guardrail -- --profile
  fast` for live fast-suite proof, or `npm run test:runtime-guardrail --
  --input <profile.json> --command <fast|integration|full>` for a lightweight
  comparison against a captured profile.

Use `npm run test:verbose` when debugging and you need the live runtime logs
plus helper command stderr for the full suite. The equivalent environment path
is `SYMPHONY_TEST_LOGS=1 SYMPHONY_TEST_OPERATIONAL_OUTPUT=1 npm run test:full`.
Captured Symphony runtime logs still print on failing tests by default; set
`SYMPHONY_TEST_LOG_CAPTURE=0` only when that failure buffer is intentionally not
needed.

The files moved out of the fast path remain covered by `npm run
test:integration` and `npm run test:full`:

- `tests/cli/local-multi-project-trial.test.ts`: process-heavy local
  multi-project simulation; slowest profiled file at 87.39s.
- `tests/runtime/bootstrap.test.ts`: runtime bootstrap and git-backed startup
  simulation; profiled at 53.21s.
- `tests/cli/meta-check-scripts.test.ts`: git/worktree PR metadata simulation;
  profiled at 24.28s.
- `tests/runtime/update-manager.test.ts`: git/worktree update-manager
  simulation; profiled at 18.93s.
- `tests/cli/local-command-router.test.ts`: real CLI, temp git repositories,
  and generated worktree materialization; profiled at 14.64s.
- `tests/api/server-state.test.ts`: server control-plane state simulation with
  worktree/process-heavy cases; profiled at 5.96s.
- `tests/cli/doctor-mvp-scenario-matrix.test.ts`: real CLI scenario matrix over
  blocker/pass/warning worktree states; profiled at 5.29s.
- `tests/cli/workspace-before-remove.test.ts`: workspace cleanup hook and
  git/worktree safety simulation; profiled at 2.44s.
- `tests/cli/worktree-bootstrap.test.ts`: worktree bootstrap command
  simulation; profiled at 2.01s.

The fast path still covers workspace preflight behavior in
`tests/workspace/workspace-manager.test.ts`. Most dirty-state, staged artifact,
sentinel, and residue classifications use per-test fake Git output so they do
not pay repeated repository setup cost or share mutable branch/index state. The
same file retains a real Git contract test for unmerged index detection, and
`npm run test:full` runs that contract alongside the integration simulations
above.

### Slow Test Profiling

Use the slow-test profile when planning test-speed work or when a handoff needs
a pasteable timing baseline:

```bash
npm run test:profile:slow -- --limit=10
```

The command runs Vitest from the nearest local `node_modules/.bin` directory
with the JSON reporter, then prints the command, environment, wall-clock
duration, slowest files, and slowest individual test patterns. Files and test
names that match git, worktree, workspace, subprocess, desktop, or process-heavy
patterns are grouped as `git/worktree/process-heavy`; the rest are grouped as
`routine unit`.

Pass Vitest filters after the script options to profile a subset:

```bash
npm run test:profile:slow -- --limit=5 tests/workspace
```

### Test Runtime Guardrail

`npm run test:runtime-guardrail` compares a current slow-test profile against
the rough budgets in `docs/test-runtime-baseline.json`. The baseline records
the expected command scope for:

- `fast`: `npm test`
- `integration`: `npm run test:integration`
- `full`: `npm run test:full`

The guardrail is intentionally not a strict benchmark. Use it to catch obvious
slow-test regressions and to make budget changes reviewable without making
local development brittle. Current command budgets are calibrated to the
post-split optimization evidence with review headroom: roughly 30s for the fast
suite, 240s for integration simulations, and 300s for the full suite. For a
live current-suite check, run:

```bash
npm run test:runtime-guardrail -- --profile fast
```

For cheaper review evidence from an existing profile:

```bash
npm run test:profile:slow -- --json > /tmp/symphony-profile.json
npm run test:runtime-guardrail -- --input /tmp/symphony-profile.json --command full
```

When the guardrail fails, its diagnostics name the command or file that exceeded
budget and include the profiling command to rerun. Fix avoidable setup,
subprocess, or git/worktree regressions before Agent Review. A runtime increase
is acceptable only when it is tied to intentional production-path coverage or a
documented environment anomaly; in that case, update
`docs/test-runtime-baseline.json` in the same change and explain the rationale
in the PR verification notes.

### UI Evidence Gate (`check:meta`)

`npm run check:meta` now enforces a UI evidence rule when dashboard UI surfaces
change (`src/api/dashboard-assets.ts`, `desktop-static/`, or `src-tauri/src/`).

Profile selection:

- Default: `validation.ui_evidence_profile: baseline`
- Optional strict mode: `validation.ui_evidence_profile: strict`
- Override via env: `SYMPHONY_UI_EVIDENCE_PROFILE=baseline|strict`

When UI paths change, provide one of:

1. Playwright pass marker environment variable:

```bash
SYMPHONY_UI_E2E_PLAYWRIGHT_PASS=1 npm run test:e2e:web
npm run check:meta
```

2. Explicit evidence artifact marker file:

```bash
mkdir -p output/playwright
printf 'UI_E2E_EVIDENCE=PASS\n' > output/playwright/ui-e2e-evidence.txt
npm run check:meta
```

If evidence is missing, `check:meta` fails with a deterministic list of changed
UI paths and remediation commands.

In `strict` profile, the explicit artifact marker file is required and env-only
markers are not sufficient.

In `strict` profile, UI-affecting diffs must provide manifest-backed artifacts:

```bash
mkdir -p output/playwright
# add at least one captured artifact under output/playwright/
# for example: output/playwright/dashboard-home.png or output/playwright/demo.webm
cat > output/playwright/ui-evidence.json <<'JSON'
{
  "artifacts": [
    { "path": "output/playwright/dashboard-home.png", "type": "image" }
  ],
  "ui_paths": [
    "src/api/dashboard-assets.ts"
  ],
  "captured_at": "2026-05-01T00:00:00.000Z",
  "summary": "Dashboard launch and task list render validated.",
  "publish_reference": "https://github.com/<owner>/<repo>/pull/<number>#issuecomment-<id>"
}
JSON
npm run check:meta
```

After publishing evidence to PR/Linear review surfaces, keep `output/playwright/*`
untracked before commit. `check:meta` fails deterministically when evidence files
are staged or committed unless `SYMPHONY_UI_EVIDENCE_ALLOW_TRACKED=1` is set
intentionally.

Strict mode contract:

- `output/playwright/ui-evidence.json` exists and is valid JSON.
- `artifacts[]` includes at least one artifact under `output/playwright/`.
- Artifact types: `image` (`.png`) or `video` (`.mp4`/`.webm`).
- Every listed artifact file exists.
- `ui_paths[]` includes changed UI path(s).
- `captured_at` is a valid datetime string and `summary` is non-empty.
- `publish_reference` is a non-empty reference to where artifacts were published for review.
- `output/playwright/*` evidence artifacts must remain untracked in normal flows.

## Observability Notes

- Logs use stable `key=value` rendering with context fields.
- Log sink failures emit warning events and do not crash orchestration flow.
- Dashboard health reflects runtime validation/error semantics from orchestrator
  state, not direct mutation from UI actions.
- Dashboard project history reports `workflow_outcome` and `process_status` as
  separate fields per attempt. `workflow_outcome` describes the ticket result
  (for example `handoff_reached` when a handoff state is reached), while
  `process_status` describes how the worker process exited (for example
  `cancelled`). A successful handoff therefore reports
  `workflow_outcome=handoff_reached` with `process_status=cancelled`.
- Claude provider usage is telemetry only. Reported `input_tokens`,
  `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`,
  `provider_turn_count`, and `estimated_cost_usd` values exist for observability
  and never enforce token, turn, or dollar limits: budget stops read Codex token
  totals, turn limits read the Symphony worker turn count, and no dollar limit
  exists. The `claude-cli` runtime reports `enforcement_usage: false`.

## Contribution Notes

- Follow `AGENTS.md` repository rules for atomic commits and PRD-linked scope.
- Keep changes mapped to SPEC/PRD acceptance criteria.
- Update `docs/prd/STATUS.md` and `docs/prd/TRACEABILITY-MATRIX.md` when
  completing gated phase work.
