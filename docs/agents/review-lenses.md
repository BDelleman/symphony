# Agent Review Lenses

This file defines the review lenses for this repository. Symphony's workflow
requires evidence-backed Agent Review artifacts; this project-owned document
defines which lenses reviewers must consider and when they are triggered.

Use the lenses as an adversarial review tool, not as a checklist to rubber
stamp. A reviewer may mark a triggered lens as not applicable only when the
review artifact explains why the trigger does not affect the current diff.

Trigger lenses from behavior or contract semantics changed by the patch. A
documentation sentence that merely mentions a command, API, runtime,
dashboard, persistence, security, or integration term does not trigger the
corresponding implementation lens. Record only triggered lenses in the review
artifact; do not enumerate lenses that were considered but not triggered.

Read the complete diff. Beyond changed files, inspect only consumers,
contracts, and runtime paths for which the changed semantics create a concrete
risk. Reuse successful exact-head CI evidence and run extra validation only to
resolve a specific uncovered risk.

## Required Artifact

Agent Review comments must follow the artifact shape in `WORKFLOW.md`:

- Scope Read
- Independent Invariants
- Acceptance Criteria Mapping
- Triggered Review Lenses
- Findings
- Verdict

Each triggered lens row must include concise concrete evidence: files,
functions, tests, commands, screenshots, PR comments, or runtime paths
inspected. Passing tests alone are validation evidence; they do not replace
lens evidence. Do not add P3 suggestions, repeat the same evidence across
sections, or narrate the review procedure.

## Base Lenses

### Acceptance Criteria

Trigger: every implementation PR.

Review question: does the implementation satisfy the issue's actual acceptance
criteria, including negative cases and evidence requirements?

Evidence examples: issue checklist mapping, PR diff, focused tests, validation
commands, UI evidence comments. Recent issue or review comments that add a
live scenario are acceptance input, not background context; map them to reviewed
evidence before passing.

### Production Wiring

Trigger: any feature depends on config, bootstrap, adapters, API routes,
dashboard state, persistence, external commands, or runtime services.

Review question: is the behavior reachable through the real production path, or
only through direct construction, mocks, fixtures, or test-only seams?

Symphony examples: workflow resolver to runtime bootstrap wiring, Local API
routes to runtime managers, persistence migrations to SQLite stores.

### State Transitions And Invariants

Trigger: any change adds, changes, or depends on state, lifecycle, routing,
status, or health semantics.

Review question: what must always remain true, and what transitions must be
impossible?

Evidence examples: state machine code, transition guards, refusal reason codes,
tests for invalid transitions.

### Multi-Phase Mutation

Trigger: workflows with separate phases such as prepare/apply, claim/complete,
start/finish, drain/restart, schedule/execute, detect/remediate, or
approve/merge.

Review question: is the candidate or object accepted in the first phase pinned
or revalidated before later mutation?

Evidence examples: stored operation identity, compare-before-apply checks,
re-prepare refusal tests, audit entries binding intent to the acted-on object.

### Failure And Refusal Paths

Trigger: every implementation PR with runtime behavior.

Review question: do named failure, refusal, timeout, offline, mismatch,
permission, and unavailable paths return deterministic operator-visible states?

Evidence examples: typed error envelopes, refusal reason codes, negative-path
tests, dashboard or diagnostics projection. For refusal/audit invariants,
enumerate every relevant refusal path instead of sampling one representative
route.

### Idempotency, Retry, And Concurrency

Trigger: any API, button, scheduler, worker loop, retry loop, external webhook,
or command can run more than once or overlap with another actor.

Review question: what happens on duplicate clicks, repeated API calls, resumed
agents, replays, retries, and concurrent operators?

Evidence examples: in-flight guards, terminal-result replay, duplicate-request
tests, concurrency tests, persisted idempotency keys.

### External Integration

Trigger: changes touch GitHub, Linear, Codex app-server, filesystem/process
APIs, network APIs, package managers, shells, or generated external contracts.

Review question: are availability, auth, rate limits, stale remote state,
schema drift, partial responses, and fallback policy handled explicitly?

Evidence examples: mocked integration states plus real adapter/bootstrap path,
bounded timeouts, redacted diagnostics, contract freshness checks.

### Control-Plane Hot Path

Trigger: changes touch state, diagnostics, dashboard polling, SSE snapshots,
health checks, dispatch loops, scheduler loops, issue polling, or local API
responsiveness.

Review question: can a normal control-plane read block on slow IO, network,
child processes, builds, installs, broad filesystem scans, or unbounded work?

Evidence examples: cache/TTL behavior, async/background refresh, bounded scan
tests, stress tests, request-latency or event-loop diagnostics.

### Persistence And Auditability

Trigger: behavior claims to survive restart, write history, provide forensics,
support replay, or expose durable audit facts.

Review question: does the durable schema, migration path, projection, and
restart/reopen behavior support the claim?

Evidence examples: real store tests, migration tests from older schema,
close/reopen tests, bounded/redacted payload checks. Search write sites such as
history appenders, audit sinks, and state-context builders; a helper used in one
path does not prove sibling write paths are covered.

### Security, Secrets, And Shell Execution

Trigger: external input reaches shell commands, filesystem paths, environment,
logs, history payloads, token data, credentials, or approval/sandbox policy.

Review question: is input passed safely, are secrets redacted, and are trust
boundaries explicit?

Evidence examples: `shell:false`, argv arrays, path containment checks,
redaction tests, environment omission, approval policy tests.

### UI And Operator Workflow

Trigger: user-visible UI behavior, layout, styling, interaction, copy, loading,
error, empty states, dashboard controls, or operator decision flows changed.

Review question: can the operator understand the current state, the next safe
action, and why actions are enabled or refused?

Evidence examples: rendered Linear media, Playwright screenshots or videos,
dashboard tests, accessibility and responsive layout checks. API fields are not
UI evidence unless the dashboard rendering path consumes them and a DOM or
rendered-media assertion proves the visible state.

### Refactor Boundary Preservation

Trigger: move-only changes, extractions, facade preservation, module splits,
large-file decomposition, or architecture-boundary tickets.

Review question: did ownership move to the intended module without behavior
drift, helper-only shuffles, hidden service-locator coupling, or public API
breakage?

Evidence examples: before/after line counts, facade exports, public import
tests, boundary grep checks, behavior-equivalence tests.

### Generated Asset And Freshness

Trigger: committed generated files, bundled assets, schemas, API clients,
snapshots, manifests, or generated docs changed or are required to stay fresh.

Review question: is the generated output reproducible and guarded against stale
commits?

Evidence examples: `--check` freshness command, deterministic generator tests,
source-to-generated diff evidence, CI/meta gate wiring.

### Metric And Telemetry Semantics

Trigger: counters, timings, health states, diagnostics, dashboards, logs, or
budget/token telemetry changed.

Review question: does the metric measure the named behavior, and are sentinel,
reset, empty, aggregate-only, and unavailable states semantically correct?

Evidence examples: semantic tests with controlled timing/state, reset tests,
projection tests, docs matching emitted fields.

### Test Adequacy

Trigger: every implementation PR.

Review question: do tests cover the real path, happy path, negative paths,
regressions, production wiring, and the highest-risk lens scenarios?

Evidence examples: focused test list, full validation, real-path integration
tests, explicit rationale for untested areas. Fixture-only payloads are not
coverage unless assertions prove the production consumer behavior; tests must
assert the field, event, UI text, or persisted record that the review relies on.

## Project-Specific Lenses

Add project-specific lenses below when a recurring risk is too domain-specific
for the base lenses. Keep each project-specific lens tied to triggers and
evidence, not preferences.

### Symphony Runtime Upgrade Safety

Trigger: Symphony drain, restart, reload, runtime update, dispatch safety, or
quiescence behavior changed.

Review question: can active work continue safely until a real boundary, and are
mutations blocked until Drain Mode and quiescence gates are still true?

Evidence examples: Drain Mode gates across dispatch paths, quiescence blocker
tests, candidate pinning for update phases, runtime identity projections.

### Symphony Workflow Governance

Trigger: Linear/GitHub workflow routing, Agent Review, Human Review, Merging,
workpads, PR governance, or handoff/fresh-dispatch behavior changed.

Review question: does the workflow state machine preserve ownership boundaries,
review routing, governed PR submission, and finalization evidence?

Evidence examples: workflow text tests, tracker adapter behavior, PR body/meta
checks, state-transition tests.
