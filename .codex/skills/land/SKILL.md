---
name: land
description: Land an exact reviewed PR head with a merge commit after Linear and GitHub readiness checks.
---

# Land

Use this skill only for the landing phase. Do not redo implementation, formal Agent Review, or candidate validation when their exact-head evidence is still valid.

## Preconditions

- `gh` is authenticated and the working tree is clean.
- Linear MCP is connected; never fall back to raw HTTP or `LINEAR_API_KEY`.
- The Linear issue is exactly `Merging`.
- A passing Agent Review receipt identifies the current PR and exact head SHA.

Entering `Merging` is authoritative human approval. A remaining `Human Review` label is audit evidence, not a veto after the state transition.

## Procedure

1. Locate the PR for the current branch and capture its number and head SHA.
2. Refresh the Linear issue. Require state `Merging` and capture its issue version and labels.
3. Locate the latest Agent Review receipt overall. It must be passing and identify the same issue ID, PR number, base SHA, and head SHA. Missing, failed, malformed, or stale evidence blocks landing. Route a changed base or head back to `Agent Review`.
4. Require a clean worktree. Reuse exact-head CI and the review receipt; do not rerun implementation validation.
5. Run the bounded readiness watcher:

   ```bash
   .codex/skills/land/scripts/land_watch.py \
     --mode landing-readiness \
     --expected-head "$head_sha" \
     --expected-base "$base_sha" \
     --json
   ```

6. Address actionable feedback only if the watcher reports it. Any fix creates a new candidate and requires implementation validation plus a fresh Agent Review.
7. Immediately before merge, refresh Linear, the explicit GitHub PR number, and the latest Review Receipt overall. Require state still `Merging`, the same passing issue/PR/base/head receipt, green required checks, no conflicts, and no unresolved review feedback.
8. Merge exactly that head with a merge commit:

   ```bash
   gh pr merge "$pr_number" --merge --match-head-commit "$head_sha"
   ```

   Never use admin override, force, or auto-merge.
9. Read back the merged PR and merge commit. Post bounded landing evidence, then move the Linear issue to `Done` as the last external action and stop.

## Failure handling

- Changed state: stop without merging.
- Changed head: return the issue to `Agent Review`; do not reuse the old receipt.
- Conflict or failed check: return to implementation for repair and a new candidate.
- Timeout or provider failure: leave the issue in `Merging` and report the typed failure; never guess readiness.
- Ambiguous permission, auth, or review state: fail closed.

The watcher exits nonzero for feedback, failed CI, head drift, timeout, or inspection failure. Its JSON result is the landing-readiness evidence; do not duplicate its polling manually.
