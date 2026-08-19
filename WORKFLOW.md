---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: $LINEAR_PROJECT_SLUG
  github_linking:
    mode: required
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
    - Rework
  fresh_dispatch_states:
    - Agent Review
    - Merging
    - Rework
  terminal_states:
    - Closed
    - Canceled
    - Duplicate
    - Done
polling:
  interval_ms: 5000
workspace:
  root: ./.symphony/system/workspaces
  provisioner:
    type: clone
    repo_root: .
    base_ref: origin/main
    branch_template: feature/{{ issue.identifier }}
    teardown_mode: keep
    allow_dirty_repo: false
  copy_ignored:
    enabled: true
    include_file: .worktreeinclude
    from: repo_root
    conflict_policy: skip
    require_gitignored: true
    max_files: 10000
    max_total_bytes: 5368709120
    allow_patterns: []
    deny_patterns: []
hooks:
  before_remove: |
    node scripts/workspace-before-remove.js
  timeout_ms: 60000
agent:
  max_concurrent_agents: 3
  max_turns: 20
  dispatch_backpressure:
    enabled: true
    retry_delay_ms: 30000
    min_running_agents: 1
    control_plane_health: degraded
    control_plane_stale_after_ms: 60000
codex:
  read_timeout_ms: 15000
  approval_policy: never
  thread_sandbox: danger-full-access
  turn_sandbox_policy: danger-full-access
runtime_update:
  github_eligibility:
    mode: allow_absent_checks
persistence:
  retention_days: 365
logging:
  max_bytes: 26214400
  max_files: 50
server:
  port: 3000
---

You are working unattended on Linear ticket `{{ issue.identifier }}`.

Issue:
- Title: {{ issue.title }}
- Dispatch state: {{ issue.state }}
- Labels: {{ issue.labels }}
- URL: {{ issue.url }}

{% if issue.description %}
Description:
{{ issue.description }}
{% endif %}

{% if attempt %}
This is retry attempt #{{ attempt }}. Continue from the current workspace and do not repeat completed investigation, validation, publication, or review work unless the candidate head changed.
{% endif %}

## Universal rules

1. Work only in the provided repository copy. Never inspect or modify another checkout.
2. Use the user-scoped Linear MCP for issue reads and writes. If `linear-server` is unavailable, stop with a typed readiness failure. Never fall back to `LINEAR_API_KEY`, curl, or raw HTTP.
3. Follow repository guidance and explicitly open any skill you use. Use `.codex/skills/commit/SKILL.md` before committing and the project push/land skills where directed.
4. Keep one unresolved `## Codex Workpad` comment. Start it with a compact plan, update it only when the plan materially changes, and finish it with validation and finalization evidence. Do not narrate every command.
5. Stay within the ticket. Start with the issue, repository guidance, changed files, and directly affected contracts. Expand only when concrete evidence requires it.
6. Never move directly from implementation to `Done`. `Done` is only allowed after the exact reviewed PR head is confirmed merged in the `Merging` flow.
7. `Todo` and `In Progress` are one implementation phase, so that transition may continue in the same run. Any transition to another workflow phase ends the run; stop immediately after it and perform no more tools or GitHub actions.
8. Stop early only for missing required permissions, authentication, or an unsafe ambiguity that cannot be resolved from repository or issue evidence.

{% if issue.state == 'Todo' or issue.state == 'In Progress' %}
## Implementation flow

1. Refresh the issue by explicit ID. If it is `Todo`, move it to `In Progress` before doing implementation work.
2. Find or create the single `## Codex Workpad`. Record:
   - a short plan;
   - acceptance criteria copied from the ticket;
   - required validation;
   - a compact environment stamp `<host>:<abs-workdir>@<short-sha>`.
3. Inspect the smallest useful surface, implement the ticket completely, and run targeted diagnostics as needed. Do not perform unrelated cleanup.
4. For UI-affecting changes, publish screenshots or screencasts through `linear-ui-evidence`. The evidence must be visible as Linear-rendered image/video media; local `output/playwright/*` paths are not review evidence. Missing or non-rendering UI evidence blocks Agent Review.
5. Reconcile Git and acceptance criteria, then use the commit skill to create a clean candidate commit. Required validation is bound to that commit; any later edit or commit invalidates it.
6. Publish through the single governed boundary. Set the PR body using `SYMPHONY_PR_BODY` or `SYMPHONY_PR_BODY_FILE`, then run:

   `npm run submit:pr-governed -- --mode upsert --title "<title>" --branch "<current-branch>" --wait`

   This command owns required validation, explicit-ref push, PR create/update, the `symphony` label, and exact-head CI readiness. Do not separately rerun the same required validation or wait for an external Codex review comment.
7. Attach the PR URL to Linear. The PR body must include Summary, Spec Alignment with relevant `SPEC.md` or workflow references, and Verification with exact outcomes.
8. Treat the governed command's exact-head readiness result as the single PR feedback sweep. Address actionable feedback only when it reports it; a new commit creates a new candidate and requires the governed boundary again.
9. Finalize the workpad with commit SHA, pushed branch, PR URL, validation receipt outcome, CI result, and any concise confusions.
10. Move the issue to `Agent Review` and stop immediately. The implementation worker must not perform formal Agent Review.

## PR feedback sweep protocol

- The governed submission helper reads issue comments, review comments, reviews, checks, and mergeability for the current PR head.
- Reply in the original thread when addressing feedback.
- Treat feedback on an older head as historical evidence, not current-head approval.
- Do not repeat that sweep or wait for a duplicate external review; Symphony's fresh `Agent Review` run is the formal review boundary.

{% elsif issue.state == 'Agent Review' %}
## Agent Review flow

This is a fresh, independent review. Do not implement or land the change.

1. Refresh the issue, comments, attachments, PR, base SHA, and exact head SHA. If this run authored the candidate, stop and leave the issue unchanged.
2. Read the complete changed-file manifest and diff. If it is large, batch complete files and maintain a coverage list; never silently truncate review scope.
3. Read `docs/agents/review-lenses.md`. Derive invariants independently from the issue and current code. Inspect every changed file plus directly affected unchanged consumers and contracts.
4. Run only targeted verification capable of confirming or disproving a concrete risk. Review completeness is scope-bounded, never time-, turn-, token-, or file-count-bounded.
5. Report actionable P1/P2 findings only. Do not search for unrelated enhancements.
6. Run the cross-cutting contract propagation lens when a typed contract, lifecycle invariant, state, persistence fact, API projection, dashboard field, audit record, or refusal path changes. Build the trace from current code reality. Fixture data is not evidence unless a production consumer assertion proves it. One representative path is not enough for audit/history/refusal invariants, and combined "API/dashboard/persistence pass" verdicts are invalid. If this lens is not triggered, state `Propagation matrix: not required` with the reason.
7. Draft an evidence-backed Agent Review artifact through `### Findings`, containing:
   - `### Scope Read` with Issue, PR, Base SHA, Head SHA, and Prior findings reviewed;
   - `### Independent Invariants`;
   - `### Acceptance Criteria Mapping`;
   - `### Triggered Review Lenses`;
   - for cross-cutting work, `### Scope Comments Reviewed`, `### Scenario-To-Surface Trace`, `### Path Census`, and `### Invalid Evidence Check`, separating API/state/diagnostics, Dashboard/operator UI, and Persistence/history/audit evidence;
   - `### Findings`.
8. Immediately before finalizing the artifact, refresh Linear state, issue version, and labels plus GitHub PR number, base SHA, and head SHA. Require state still `Agent Review` and the same reviewed PR/base/head; otherwise discard the verdict and stop.
9. Choose exactly one route from the refreshed evidence: fixable P1/P2 to `In Progress`; reset-level P1/P2 to `Rework`; pass with UI/human judgment or a `Human Review` label to `Human Review`; otherwise pass to `Merging`.
10. Append `### Verdict` and `### Review Receipt` with exactly one JSON object containing version, issue_id, pr_number, base_sha, head_sha, issue_version (number or null), verdict, route, reviewer_attempt_id, and created_at. Validate with `npm run check:review-artifact`, post the artifact as a normal Linear comment, make the chosen state transition, and stop immediately.

A Linear label named `Human Review` is an explicit human-review routing requirement. Match this label case-insensitively; labels are normalized to lowercase by the tracker model. The implementation workpad should contain `Review routing: Human Review label present` when observed. A pass without evidence-backed lens verdicts is invalid.

{% elsif issue.state == 'Merging' %}
## Merging flow

This is a fresh landing run. Do not redo implementation or formal review.

1. Open and follow `.codex/skills/land/SKILL.md`.
2. Refresh Linear by explicit ID and require state exactly `Merging`. Entering `Merging` is authoritative human approval; a remaining `Human Review` label is audit evidence, not a veto.
3. Locate the latest `### Review Receipt` overall. It must be passing and match the issue ID, PR number, base SHA, and exact current head SHA. Missing, malformed, failed, or stale evidence blocks landing; route a changed base or head back to `Agent Review`.
4. Run:

   `.codex/skills/land/scripts/land_watch.py --mode landing-readiness --expected-head "<head-sha>" --expected-base "<base-sha>" --json`

5. Immediately before merge, refresh Linear and require state still `Merging`; refresh the explicit GitHub PR number and require the same base and head; reread the latest Review Receipt overall and require it is still the same passing issue/PR/base/head receipt.
6. Merge with `gh pr merge "<pr-number>" --merge --match-head-commit "<head-sha>"`. Never use admin override, force, or auto-merge.
7. Read back merged state and merge commit. Post bounded landing evidence, then move the Linear issue to `Done` as the last external action and stop.

{% elsif issue.state == 'Rework' %}
## Rework flow

1. Refresh the issue and review findings. State clearly what will change in the new approach.
2. Close the obsolete PR, retire the old workpad, and create a fresh managed branch from the configured base.
3. Move the issue to `In Progress` and stop immediately. A fresh implementation run owns the replacement candidate.

{% else %}
Unsupported dispatch state `{{ issue.state }}`. Make no changes and fail closed.
{% endif %}
