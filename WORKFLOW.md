---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: $LINEAR_PROJECT_SLUG
  github_linking:
    mode: off

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
review_approval:
  provider: github_app
  required: true
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
2. Prefer Symphony's injected `linear_graphql` tool for issue reads and writes. If it is unavailable, use the user-scoped Linear MCP. If neither is available, stop with a typed readiness failure. Never use `LINEAR_API_KEY`, curl, or raw HTTP directly.
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

1. Read the Linear issue, comments, attachments, labels, and linked PR reference once. If this run authored the candidate, stop and leave the issue unchanged. Do not query GitHub separately; the prepare command owns that snapshot.
2. Run `npm run review:governed -- prepare --issue "{{ issue.identifier }}" --pr "<linked-pr-number>"` once. The command requires the issue branch, a clean worktree, the explicit open non-draft PR targeting `main`, the local exact head, and a successful exact-head `Fast validation (ubuntu-latest)` check. It writes the complete manifest, normalized feedback, PR context, and binary-safe diff plus a draft artifact under Git metadata. Treat the capsule as authoritative for mechanical PR/base/head/check identity, not for review judgment. If refreshed context invalidates an existing draft, use `draft.previous.md` only as reference and complete the new placeholder-bearing `draft.md`.
3. Read the capsule's `context.json`, complete `diff.patch`, and `draft.md`, then read `docs/agents/review-lenses.md`. Derive invariants independently from the issue and current code. Inspect every changed file and only unchanged consumers or contracts concretely affected by the changed semantics; never silently truncate the diff.
4. Trigger lenses from changed semantics, not vocabulary. Documentation that merely names a command, API, runtime, dashboard, or persistence concept does not trigger those implementation lenses. Record only triggered lenses; do not catalog untriggered lenses.
5. Reuse the green exact-head Fast CI evidence. Run additional targeted verification only when it can confirm or disprove a concrete uncovered risk. Do not inspect the artifact validator unless finalization reports a validation failure.
6. Report actionable P1/P2 findings only. Do not add P3 notes, unrelated enhancements, repeated evidence, or a narrative of the review process.
7. Run the cross-cutting contract propagation lens only when a typed contract, lifecycle invariant, state, persistence fact, API projection, dashboard field, audit record, or refusal path changes. Build the trace from current code reality. Fixture data is not evidence unless a production consumer assertion proves it. One representative path is not enough for audit/history/refusal invariants, and combined "API/dashboard/persistence pass" verdicts are invalid. If this lens is not triggered, state `Propagation matrix: not required` with the reason.
8. Complete the capsule's `draft.md` through `### Findings` as a concise, evidence-backed Agent Review artifact containing:
   - `### Scope Read` with Issue, PR, Base SHA, Head SHA, and Prior findings reviewed;
   - `### Independent Invariants`;
   - `### Acceptance Criteria Mapping`;
   - `### Triggered Review Lenses`;
   - for cross-cutting work, `### Scope Comments Reviewed`, `### Scenario-To-Surface Trace`, `### Path Census`, and `### Invalid Evidence Check`, separating API/state/diagnostics, Dashboard/operator UI, and Persistence/history/audit evidence;
   - `### Findings`.
9. Immediately before finalization, refresh Linear once and require state still `Agent Review`; capture the issue version and labels. Choose exactly one route: fixable P1/P2 to `In Progress` (`in_progress`); reset-level P1/P2 to `Rework` (`rework`); pass with UI/human judgment or a `Human Review` label to `Human Review` (`human_review`); otherwise pass to `Merging` (`merging`).
10. Run `symphony review finalize --issue "{{ issue.identifier }}" --pr "<linked-pr-number>" --route "<route>" --body-file "<draft-file>"`. The installed command performs an adjacent GitHub refresh, rejects dirty/stale PR evidence, writes the v2 Review Receipt and final artifact under private Git metadata, and prints the terminal review envelope. It holds no reviewer App credentials and never changes GitHub or Linear.
11. Post the generated `final.md` as one normal Linear comment. Return exactly the generated `SYMPHONY_REVIEW_OUTCOME_V1 ...` envelope as the final response, with no other text. Leave Linear in `Agent Review`; Symphony validates the receipt, owns the App approval, and performs the selected transition. Gate failure blocks in Agent Review and never falls back to Human Review.

A Linear label named `Human Review` is an explicit human-review routing requirement. Match this label case-insensitively; labels are normalized to lowercase by the tracker model. The implementation workpad should contain `Review routing: Human Review label present` when observed. A pass without evidence-backed lens verdicts is invalid.

{% elsif issue.state == 'Merging' %}
## Merging flow

This is a fresh landing run. Do not redo implementation or formal review.

1. Open and follow `.codex/skills/land/SKILL.md`.
2. Refresh Linear by explicit ID and require state exactly `Merging`. Entering `Merging` is authoritative human approval; a remaining `Human Review` label is audit evidence, not a veto.
3. Locate the latest `### Review Receipt` overall. For gated runs it must be v2, passing, and match the issue ID, PR number, base SHA, and exact current head SHA. Require an exact-head `symphony-reviewer[bot]` approval. Missing, malformed, failed, stale, or v1-only evidence from a new gated run blocks landing; route a changed base or head back to `Agent Review`.
4. Run:

   `.codex/skills/land/scripts/land_watch.py --mode landing-readiness --expected-head "<head-sha>" --expected-base "<base-sha>" --require-reviewer-app-approval --json`

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
