# Symphony Extension Specification

Status: v1 reference extension

Purpose: Define Symphony-local extensions to the base service contract in
`SPEC.md`.

## 1. Scope and Authority

This repository implements the base Symphony service specification in
`SPEC.md` plus the local extensions documented in this file.

`SPEC.md` remains the upstream/reference contract. This file is normative only
for behavior that is intentionally local to this repository and intentionally
outside the base contract.

Conflict rules:

- If `SPEC.md` defines a base behavior and this file does not mention it, the
  base behavior applies unchanged.
- If this file extends a base concept, the extension applies only to the named
  Symphony-local field, invariant, or lifecycle rule.
- If this file and `SPEC.md` appear to conflict, implementations must preserve
  the `SPEC.md` base behavior unless this file explicitly names the override.
- Extension fields must not silently change runtime behavior outside the
  lifecycle semantics documented here.

This extension defines workflow-config metadata and runtime semantics for
role-aware handoff states, fresh-dispatch states, local guided runtime update
policy, and Symphony-local project layout boundaries. The v1 reference
implementation covers typed config resolution, validation, local-worker
state-refresh handling, orchestrator retry/dispatch behavior, terminal cleanup
separation, explicit runtime-update GitHub eligibility decisions, and the
ignored-runtime-state boundary for project-owned customization paths.

## 2. Domain Model Extensions

### 2.1 Handoff State

A `Handoff State` is a tracker state where responsibility leaves the current
automation role without treating the issue as complete.

Normative meaning:

- A handoff state is a role boundary.
- A handoff state is not a terminal state.
- A handoff state is not a cleanup state.
- A successful run may intentionally end by moving an issue into a handoff
  state.
- The issue, branch, pull request, workpad, and workspace remain available for
  the next role unless another base-spec rule independently removes them.

Examples include states such as `Agent Review` or `Human Review`, where the
next actor must inspect the prior work before the issue can proceed.

### 2.2 Fresh Dispatch State

A `Fresh Dispatch State` is a handoff state where the next automation role must
start as a new run boundary rather than continuing the previous agent context.

Normative meaning:

- A fresh-dispatch state is always a handoff state.
- A fresh-dispatch state is always an active dispatch candidate state.
- Fresh dispatch preserves repository and tracker artifacts, but the next
  automation role must not inherit the previous agent conversation as its own
  execution context.
- Fresh dispatch is intended for independent role transitions, especially
  implementation-to-review boundaries.

Fresh dispatch does not imply workspace deletion. Workspace cleanup remains
controlled by terminal-state cleanup in the base spec.

## 3. Workflow Config Fields

The workflow front matter accepts the extension fields below under `tracker`.
The Config Layer must parse them into typed effective workflow config values so
runtime components can consume them without re-reading raw YAML.

### 3.1 `tracker.handoff_states`

Type: list of strings.

Default: `[]`.

`tracker.handoff_states` names tracker states that are handoff states for this
workflow.

Validation:

- The field is optional.
- When provided, the value must be a list.
- Each list entry must be a non-empty string.
- A state listed in `tracker.handoff_states` must not also be listed in
  `tracker.terminal_states`.
- Invalid shapes or unsafe overlaps must fail config validation before runtime
  dispatch uses the config.

Lifecycle semantics:

- When an issue reaches a handoff state, the current role must not treat that
  state as terminal completion.
- A local worker that refreshes its issue into a handoff state after a turn
  must stop continuation turns and report `handoff_state_reached`.
- Handoff preserves the workspace and surrounding review artifacts for the next
  role.
- Handoff must not schedule same-context continuation retries for the role that
  just handed off.
- Handoff does not require a fresh agent context unless the same state is also
  listed in `tracker.fresh_dispatch_states`.
- Handoff does not alter the base candidate-selection rule by itself. Dispatch
  eligibility still starts from `tracker.active_states`.

### 3.2 `tracker.fresh_dispatch_states`

Type: list of strings.

Default: `[]`.

`tracker.fresh_dispatch_states` names handoff states that require the next
automation role to start as a fresh run boundary.

Validation:

- The field is optional.
- When provided, the value must be a list.
- Each list entry must be a non-empty string.
- Every state listed in `tracker.fresh_dispatch_states` must also be listed in
  `tracker.handoff_states`.
- Every state listed in `tracker.fresh_dispatch_states` must also be listed in
  `tracker.active_states`.
- A state listed in `tracker.fresh_dispatch_states` must not also be listed in
  `tracker.terminal_states`.
- Invalid shapes, missing handoff membership, missing active-state membership,
  or unsafe terminal overlap must fail config validation before runtime
  dispatch uses the config.

Lifecycle semantics:

- Fresh dispatch is a new role/run boundary.
- The next role may inspect persisted artifacts from the prior run, including
  the issue, workpad, branch, pull request, commits, and workspace files.
- The next role must start from the workflow prompt and tracker/repository
  state, not from private continuation context of the prior agent session.
- Fresh dispatch exists to make review or merge automation independent from the
  implementation run that handed off the issue.
- If a stale retry entry exists when the issue is later found in a
  fresh-dispatch state, the dispatcher must ignore inherited thread/session
  lineage and dispatch attempt `0` with no resume context.
- If a fresh-dispatch run routes the issue to a different workflow state, the
  worker must stop and report `fresh_dispatch_state_routed` unless the target
  state is itself a handoff state, in which case `handoff_state_reached` applies.

### 3.3 `runtime_update.github_eligibility.mode`

Type: string enum.

Default: `required`.

Allowed values:

- `required`: require GitHub check-run eligibility for an actionable update
  candidate before Prepare or Apply can proceed.
- `allow_absent_checks`: allow GitHub candidates with an intentionally empty
  check-run set while still refusing pending, failing, unavailable, or unknown
  GitHub states.
- `trust_raw_git`: explicitly trust the configured git remote/base ref without
  requiring GitHub eligibility. This is intended for local or non-GitHub
  repositories where the operator has chosen raw git authority.

Validation:

- The field is optional.
- When provided, the value must be one of the allowed values above.
- Invalid values must fail config validation before runtime startup.

Lifecycle semantics:

- The default remains conservative and must not silently allow raw git
  fast-forwards when GitHub eligibility is unknown or unavailable.
- Non-default modes are operator policy choices and must be represented in the
  runtime update readiness payload exposed by state and diagnostics.
- The guided runtime update loop must use the resolved effective config value
  from runtime bootstrap, not an unconfigured internal default or direct
  construction-only test seam.

## 4. Project Layout Boundary

The root `WORKFLOW.md` remains the committed project contract for local
Symphony execution. Runtime-owned local state belongs under `.symphony/system/`
and must be ignored by the repository root `.gitignore`.

During migration, the repository may also keep targeted legacy runtime ignores
for existing local paths such as `.symphony/workspaces/`, `.symphony/log/`,
`.symphony/logs/`, `.symphony/runtime.sqlite`,
`.symphony/runtime.sqlite.bak-*`, `.symphony/runtime.sqlite-*`,
`.symphony/state.db`, `.symphony/runtime-restart-failure.json`, and
`.symphony/stress-base/`. These entries are compatibility guards only; new
runtime state should use `.symphony/system/`.

The repository must not use a broad `.symphony/`, `.symphony/*`, or
`.symphony/**` ignore rule for normal operation. Broad ignores hide future
project-owned customization and make those files unreviewable.

`.symphony/skills/` and `.symphony/prompts/` are reserved project-owned
customization paths. They are intentionally visible to git and intentionally
not loaded by the runtime in this extension.

### 4.1 Project-Local Portable Skills

The `symphony init` MVP may copy selected portable skill templates into
`.codex/skills/` in the target project. `.codex/skills/` is used because it is
the Codex project-local skill location; `.symphony/skills/` remains a reserved
future Symphony customization path and is not a hidden runtime skill-loading
source.

Copied skills are committed project files. After init, a project may edit,
replace, or delete its local copies to match its workflow. Symphony does not
secretly refresh, merge, or override those local customizations at runtime.
Generated `WORKFLOW.md` provenance records the selected portable skills so
operators and `symphony doctor` can report what init planned or materialized.

The initial portable skill catalog is:

- `commit`: small atomic Commitizen-style commits with validation evidence.
  Requires Codex project-local skill loading and `git`.
- `pull`: merge-based sync from `origin/main` into a feature branch. Requires
  Codex project-local skill loading and `git`.
- `push`: push branch updates and create or update the matching pull request.
  Requires Codex project-local skill loading, `git`, and authenticated
  GitHub CLI.
- `land`: watch PR readiness and land approved work through the merge loop.
  Requires Codex project-local skill loading, `git`, authenticated GitHub CLI,
  `uv`, and Python for the helper script.
- `linear-graphql`: narrow raw Linear GraphQL operations for cases not covered
  by Linear MCP. Requires Codex project-local skill loading and a configured
  Linear GraphQL client.
- `linear-ui-evidence`: publish Playwright screenshots and screencasts to
  Linear as rendered rich media. Requires Codex project-local skill loading,
  Node.js, and Linear MCP or equivalent Linear upload access.

By default, init selects `commit`, `pull`, `push`, and `land`. Operators may
select an explicit set with repeated `--skill <name>` flags or
`--skills <name,name>`. `--no-skills` selects no portable skills and cannot be
combined with `--skill` or `--skills`.

`--dry-run` renders the same file plan without writing any files. Existing
generated targets are non-destructive by default: dry-run marks them as
overwrites, and write mode requires interactive confirmation or `--force`.
`--force-skills` overwrites only `.codex/skills/` targets and does not authorize
overwriting unrelated init outputs such as `WORKFLOW.md`. It also does not
prune extra user files under a skill directory. Directory conflicts and skill
destinations that resolve outside the target project or `.codex/skills/` tree
are refused instead of deleted or followed.

`symphony doctor` reports generated workflow provenance and explicit
customization references as observable project content. For selected portable
skills, doctor reports whether each expected `.codex/skills/<skill>/SKILL.md`
file is installed, whether catalog-declared helper scripts are present, and
which selected-skill prerequisites are available. Tool prerequisites are checked
only when relevant to the selected skills, including `git`, `gh`, `uv`, `node`,
and Python. Linear helper skills additionally report whether Linear credentials
are present without printing secret values.

Doctor also checks Codex project-local skill visibility when the workflow
`codex.command` uses `codex app-server`. If discovery is unavailable, not using
app-server, partial, or blocked by unrecognized portable-skill provenance,
doctor reports a warning/degraded state instead of pretending that discovery
passed. Unknown portable-skill provenance in `WORKFLOW.md` is a warning with
regeneration guidance. Doctor does not claim runtime loading from
`.symphony/skills/` or `.symphony/prompts/`.

Generated profiles, bundles, and packs are init inputs only. When `symphony
init` materializes a project, it records reviewable provenance in the root
`WORKFLOW.md` so operators and `symphony doctor` can inspect which profile
inputs produced the file. Runtime policy still comes from the materialized root
`WORKFLOW.md`; runtime startup must not read profile registry templates as a
hidden policy source.

Generated profile provenance is optional for hand-written workflows. If present,
the metadata must be well-formed enough for doctor and init validation to report
the profile, selected bundle, and expanded pack ids consistently.

## 5. Invariants

Implementations must enforce the following invariants for the typed effective
workflow config:

1. Omitted handoff extension fields resolve to `[]`.
2. Omitted extension fields preserve existing behavior compatibility.
3. `tracker.handoff_states` and `tracker.fresh_dispatch_states` contain only
   non-empty strings.
4. `tracker.handoff_states` must not overlap `tracker.terminal_states`.
5. `tracker.fresh_dispatch_states` must not overlap `tracker.terminal_states`.
6. `tracker.fresh_dispatch_states` must be a subset of
   `tracker.handoff_states`.
7. `tracker.fresh_dispatch_states` must be a subset of
   `tracker.active_states`.
8. Terminal states must not be used for workflow handoff because terminal
   cleanup may remove workspaces before the next role can inspect or continue
   the work.
9. Omitted `runtime_update.github_eligibility.mode` resolves to `required`.
10. `runtime_update.github_eligibility.mode` must be one of `required`,
    `allow_absent_checks`, or `trust_raw_git`.
11. The root `.gitignore` must include `.symphony/system/`.
12. The root `.gitignore` must not include broad `.symphony/`, `.symphony/*`,
    or `.symphony/**` patterns unless an explicit migration exception is
    attached to that ignore entry.
13. `.symphony/skills/` and `.symphony/prompts/` must remain visible to git
    until a future project-owned customization implementation changes that
    contract deliberately.
14. Init-selected portable skills must be materialized under `.codex/skills/`,
    not `.symphony/skills/`.
15. Init must preserve existing project-local skill customizations unless the
    operator explicitly confirms overwrite or uses a scoped force flag.
16. Doctor must report project-local skill provenance and prerequisites as
    observable project metadata, not as hidden runtime policy.

These invariants are config-contract requirements and runtime preconditions.

## 6. Dispatch and Reconciliation Implications

The base `SPEC.md` candidate-selection model remains authoritative:

- Candidate issues are fetched from `tracker.active_states`.
- Terminal states remain cleanup states.
- Reconciliation stops active runs whose tracker state becomes terminal or
  non-active.
- Startup terminal cleanup may remove workspaces for terminal issues.

The extension adds role-boundary metadata that runtime components use:

- A handoff state signals that current-role continuation should stop at that
  state.
- A fresh-dispatch state signals that the next automation role should be
  dispatched independently.
- Because active states are the candidate source, every fresh-dispatch state
  must be active. Otherwise a config could describe a fresh run boundary that
  the dispatcher can never pick up.
- Because terminal states may trigger workspace cleanup, terminal states cannot
  safely serve as handoff states.

This extension does not make `Agent Review`, `Human Review`, or any other
state active by default. Workflows opt into those states by listing them in
`tracker.active_states` when runtime dispatch should consider them.

### 6.1 Local Worker State-Refresh Order

After each completed Codex turn, the local worker must refresh the issue state
and apply the first matching rule in this order:

1. Missing refreshed issue: stop normally with `issue_state_missing`; no
   workspace cleanup.
2. Refreshed state is in `tracker.terminal_states`: stop normally with
   `terminal_state_reached`; orchestrator terminal cleanup applies.
3. Refreshed state is in `tracker.handoff_states`: stop normally with
   `handoff_state_reached`; no workspace cleanup and no same-context retry.
4. Current state is in `tracker.fresh_dispatch_states` and refreshed state is a
   different state: stop normally with `fresh_dispatch_state_routed`; no
   workspace cleanup and no same-context retry.
5. Refreshed state is not in `tracker.active_states`: stop normally with
   `issue_left_active_states`; no workspace cleanup.
6. Refreshed state remains active and none of the above applies: continue on
   the same thread until normal max-turn behavior applies.

This order is intentional. Terminal cleanup must win over handoff metadata,
handoff states must stop the current role before same-thread continuation, and
fresh-dispatch routing is only meaningful when a fresh-dispatch role moves the
issue onward.

### 6.2 Orchestrator Dispatch and Retry Semantics

Candidate selection remains `tracker.active_states` plus existing eligibility
checks. For a configured fresh-dispatch state:

- A candidate in that state dispatches as a new attempt with no resume context.
- A stale retry timer that observes the issue in that state dispatches as a
  fresh attempt instead of applying no-progress redispatch gating.
- Fresh dispatch clears inherited retry graph lineage, previous thread/session
  IDs, worker host, and workspace metadata for the new role attempt.
- Running/claimed protection still prevents duplicate fresh runs for the same
  issue.
- Slot exhaustion may reschedule the fresh-dispatch candidate, but the
  rescheduled retry must retain the fresh boundary by keeping inherited
  context cleared.

### 6.3 Reconciliation and Cleanup Separation

Runtime reconciliation keeps the base cleanup contract:

- Terminal states stop active runs and clean the workspace.
- Non-active, non-terminal states stop active runs without workspace cleanup.
- Active states, including active handoff/fresh-dispatch states, remain
  dispatch candidates and are not treated as terminal cleanup states.
- Startup terminal cleanup only uses `tracker.terminal_states`.

Handoff and fresh dispatch therefore preserve review evidence and workspaces.
Only terminal transitions may invoke terminal cleanup.

## 7. Failure Behavior

Invalid extension config must fail before runtime use with typed workflow config
errors.

Required error behavior:

- Malformed `tracker.handoff_states` values fail with an
  `invalid_tracker_handoff_states` config error.
- `tracker.handoff_states` terminal overlap fails with an
  `invalid_tracker_handoff_states` config error.
- Malformed `tracker.fresh_dispatch_states` values fail with an
  `invalid_tracker_fresh_dispatch_states` config error.
- `tracker.fresh_dispatch_states` terminal overlap, missing handoff
  membership, or missing active-state membership fails with an
  `invalid_tracker_fresh_dispatch_states` config error.

Implementations should include the invalid field name and offending state value
in the validation message when one offending value can be identified.

## 8. Compatibility Boundaries

Existing workflows that omit both extension fields must resolve exactly as they
did before this extension:

- `tracker.handoff_states` resolves to `[]`.
- `tracker.fresh_dispatch_states` resolves to `[]`.
- Candidate selection remains based on `tracker.active_states`.
- Terminal cleanup remains based on `tracker.terminal_states`.
- No runtime handoff or fresh-dispatch behavior is implied by omission.

This extension is additive. It must not require workflow authors to configure
handoff states unless their workflow needs role-aware handoff behavior.

## 9. Implemented Lifecycle Contract

The bundled `WORKFLOW.md` uses the following v1 lifecycle:

- Implementation runs in `Todo` or `In Progress`.
- Passing implementation work hands off by moving the issue to `Agent Review`.
- `Agent Review` is active, a handoff state, and a fresh-dispatch state, so the
  review role starts as an independent run.
- UI work, product judgment, unclear human intent, or blocked external input
  routes from `Agent Review` to `Human Review`.
- Non-UI passing review routes from `Agent Review` to `Merging`.
- Normal review findings route from `Agent Review` to `In Progress`.
- Reset-level failures route from `Agent Review` to `Rework`.
- `Merging` is active, a handoff state, and a fresh-dispatch state, so landing
  starts independently from Agent Review and follows the workflow land loop.
- `Done`, `Closed`, `Canceled`, and `Duplicate` are terminal cleanup states.

## 10. Implementation and Test Evidence

The v1 reference implementation evidence is:

- Config resolution: `src/workflow/resolver.ts` resolves
  `tracker.handoff_states` and `tracker.fresh_dispatch_states`; covered by
  `tests/workflow/resolver.test.ts`.
- Config validation: `src/workflow/validator.ts` enforces terminal overlap,
  handoff subset, and active subset invariants; covered by
  `tests/workflow/validator.test.ts`.
- Local worker stop/routing behavior: `src/orchestrator/local-worker-runner.ts`
  applies the state-refresh order in Section 5.1; covered by
  `tests/orchestrator/local-runner-bridge.test.ts`.
- Fresh dispatch and stale retry behavior: `src/orchestrator/core.ts` dispatches
  fresh-dispatch candidates without inherited context and bypasses no-progress
  retry gating for stale fresh-dispatch retries; covered by
  `tests/orchestrator/core-handoff.test.ts`.
- Terminal cleanup separation: `src/orchestrator/core.ts` cleans workspaces for
  terminal transitions and does not clean for handoff/fresh-dispatch exits;
  covered by `tests/orchestrator/core-reconciliation.test.ts` and
  `tests/orchestrator/local-runner-bridge.test.ts`.
- Workflow lifecycle instructions: `WORKFLOW.md` defines Agent Review, Human
  Review, Merging, and Rework routing; covered by
  `tests/workflow/workflow-command-examples.test.ts`.

Deferred or out-of-scope items:

- Programmatic verification that Linear-rendered UI evidence media is visible
  in review comments remains reviewer-enforced in `WORKFLOW.md`.
- Human judgment in `Human Review` is explicitly outside automation dispatch.
- This extension does not make `Human Review` active in the bundled workflow;
  it is a human/product review holding state.

## 11. Example

Example workflow shape:

```yaml
tracker:
  active_states:
    - Todo
    - In Progress
    - Agent Review
    - Merging
    - Rework

  handoff_states:
    - Agent Review
    - Human Review
    - Merging

  fresh_dispatch_states:
    - Agent Review
    - Merging
```

Interpretation:

- `Agent Review` is a handoff state and a fresh-dispatch state.
- `Agent Review` is listed in `active_states`, so review automation may
  discover it as a candidate and start a fresh run.
- `Merging` is also active and fresh-dispatch, so landing starts in a separate
  run after review or human approval.
- `Human Review` is a handoff state but not a fresh-dispatch state in this
  example. Because it is not listed in `active_states`, automation does not
  dispatch it in this workflow.
- No terminal state is used for handoff.
- If the two extension fields are omitted, both resolve to `[]` and existing
  workflow behavior is preserved.

## 12. Dynamic Tool Extension Boundary

Symphony's app-server DynamicTool support is intentionally limited to the
`linear_graphql` extension. This is a local extension boundary, not a general
dynamic-tool expansion path.

Supported dynamic tools:

- `linear_graphql` is the only supported DynamicTool unless this file adds an
  explicit documented exception.
- `linear_graphql` is a low-level escape hatch for Linear attachment upload
  flows, rich `bodyData` writes or verification, targeted schema introspection,
  and rare Linear API gaps that the configured Linear MCP server cannot
  express.
- Routine Linear workflow operations, including issue lookup, comments,
  workpads, state changes, labels, projects, and ordinary links, must prefer
  Linear MCP tools when available.
- This extension does not add plugin, marketplace, realtime, filesystem, or
  process dynamic API behavior.

Unsupported dynamic tool calls:

- Unsupported DynamicTool calls must return a structured failure payload that
  includes the attempted tool name and the supported tool names.
- The failure payload must let runner events, agents, and operator surfaces
  distinguish allowlist misses from supported-tool execution failures.
- Capability mismatch events remain observable when the app-server cannot
  support an advertised tool shape.

Equivalent unsupported-tool failure payload:

```json
{
  "error": {
    "code": "unsupported_dynamic_tool",
    "attemptedToolName": "filesystem.read",
    "supportedTools": ["linear_graphql"],
    "message": "Unsupported dynamic tool: \"filesystem.read\"."
  }
}
```

## 13. Unsupported Safety-Sensitive Server Requests

Symphony handles Codex app-server request methods through an explicit
allowlist. Command execution and file-change approval requests may be answered
only by supported allowlist entries.

Unsupported approval-like server requests return structured unsupported
protocol evidence with method, category, and reason code.

Unsupported permission, authentication, account, credential, token, secret, or
session requests are safety-sensitive. Symphony must not fabricate credentials,
grant permissions, or return success for these requests.

Unsupported safety-sensitive server requests return a structured failure
response and stop the turn as operator input required unless a specific
supported policy exists.

Conformance extension:

- Unsupported permission, authentication, account-token, and unknown
  safety-sensitive server requests are rejected with structured
  method/category/reason evidence.
- Unsupported safety-sensitive requests stop as operator input required unless
  an explicit supported policy exists.

## 14. Project Execution History Persistence Schema

Project Execution History uses an explicit local SQLite schema named
`project_execution_history`. The durable schema state lives in
`history_schema_state`, and individual migration outcomes live in
`history_schema_migrations`.

Version 1 covers:

- Project Identity: `history_project_identity`.
- Ticket Identity: `history_ticket_identity`.
- Run attempts and execution graph: existing `issue_run`, `attempt`, `thread`,
  `turn`, `phase_span`, `tool_span`, and `state_transition` tables.
- Legacy diagnostic/run history: existing `runs`, `run_sessions`, and
  `run_events` tables remain diagnostic compatibility tables. They are not the
  canonical full Project Execution History shape, but they continue to power
  restart history and diagnostics while newer history tables are populated.
- Protocol summaries: `history_protocol_summary`.
- Token and Effective Model facts: `history_token_model_fact`.
- Retention metadata: `history_retention_metadata`.
- Health and degradation metadata: `history_health_metadata`.

Migration requirements:

- Migrations are idempotent and record applied version durably.
- Migration success is not inferred from table or column presence alone.
- If a migration fails, `history_schema_state.status` is `degraded` and the
  failing migration row records the redacted error. Persistence health must
  surface this degraded state instead of presenting partial history as complete.

## 15. Project Execution History Write And Flush Contract

Runtime history writes are synchronous SQLite writes on the persistence store
path. A write is considered flushed only after its store call resolves; queued
runtime observations must not be marked persisted before that point.

Durable write points:

- Run start: write legacy `runs` plus canonical `issue_run` before a worker is
  treated as history-visible.
- Attempt start/end: write `attempt` at dispatch, retry, pre-spawn failure, and
  terminal attempt finalization.
- Phase enter/exit: write `phase_span` from phase and turn lifecycle events.
- State transition: write `state_transition` for dispatch, retry, blocked,
  stalled, cancellation, and terminal transitions.
- Thread/turn observation: write `thread` and `turn` from app-server worker
  events, with turn IDs promoted from pending to persisted only after the turn
  insert succeeds.
- App-server event summary: write compact `run_events` diagnostics and
  `history_protocol_summary` rows rather than loading transcripts on the
  runtime hot path.
- Token/model observation: write `history_token_model_fact` from usage and
  effective-model telemetry observations. Token facts preserve observed input,
  output, total, cached input, reasoning output, context-window metadata,
  source, confidence, and observation time when available. Requested model and
  Effective Model are stored separately so reroutes remain auditable without
  introducing pricing snapshots or cost estimates.
- Blocker/operator action: write `history_ticket_blocker` for durable blocker
  facts and the operator action trail for audited operator decisions.
- Evidence reference: write `history_ticket_evidence_reference` for durable
  references such as Codex thread IDs and validation artifacts.
- Terminal outcome: write legacy run completion and
  `history_ticket_terminal_outcome`; failures in either terminal write degrade
  history health instead of presenting complete terminal history.

Transaction boundaries:

- Multi-row schema migrations run inside explicit transactions.
- Multi-fact runtime writes that must stay consistent must either use a single
  store transaction or keep unflushed facts out of the completed history
  projection until all required writes resolve.
- Failed writes call `recordHistoryWriteFailure`, which stores a redacted
  `history_write_failure` record and degrades `history_schema_state` with
  `history_write_failed`.

Hot-path constraints:

- Runtime persistence must use already-observed app-server events, worker
  metadata, and tracker facts. It must not load full transcripts or call
  dashboard APIs to decide whether to write Project Execution History.
- Restart recovery reads the durable SQLite tables. Live memory can enrich the
  current process view, but it is not proof of persisted ticket history.

## 16. Project History Consumer Summary

The Project History Consumer Summary is a compact read-only projection derived
from Project Execution History ticket timelines. It exists so review automation
and later workflow consumers can read durable facts without depending on the
larger ticket detail payload or implementing later workflow features early.

The v1 summary schema is
`symphony.project_history.consumer_summary.v1` and is exposed at
`GET /api/v1/projects/:projectKey/history/tickets/:ticketKey/consumer-summary`.

The summary includes:

- Current ticket state, current/last known tracker status, latest observation
  time, and fact health/degradation markers.
- Attempt totals, repeated-attempt flag, latest attempt, and recent attempts.
- Recent phase spans.
- Active/resolved blocker counts and recent blocker facts.
- Token and Effective Model facts, including total tokens, requested/effective
  models, telemetry confidence, and recent token observations.
- App Server Event Ledger Lite excerpts using bounded summaries/redacted
  excerpts only.
- Evidence references.

The summary is explicitly read-only. It must not mutate history, refresh
tracker state, call validation commands, reuse validation evidence, generate
Phase Handoff Packets, enter or inspect Drain Mode beyond already persisted
facts, or steer operator actions. Those capabilities remain owned by their
later SWP slices.

Project History health diagnostics are lifecycle-aware:

- Active, running, retrying, and blocked ticket timelines may report
  `lifecycle_pending` terminal outcome facts. Those facts are operator-visible
  but do not degrade projection health.
- Completed ticket timelines require terminal outcome facts. Missing terminal
  outcomes remain real projection gaps and degrade health.
- Token/model summaries and app-server-lite summaries are optional or
  conditionally available facts. Their absence is reported as
  `optional_unavailable` with reason codes, and does not degrade health unless
  a recorded event indicates malformed payload policy state, full payload
  persistence, or another write/projection failure.
- Schema migration failures, failed history writes, retention failures,
  malformed app-server-lite policy facts, and required completed-run fact gaps
  remain degraded diagnostics.
