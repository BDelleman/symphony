import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseWorkflowFrontMatter } from '../../src/workflow/frontmatter';

describe('workflow command examples', () => {
  it('keeps runtime and model selection in the project environment', () => {
    const workflowPath = path.join(process.cwd(), 'WORKFLOW.md');
    const workflow = readFileSync(workflowPath, 'utf8');
    const envExample = readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
    const worktreeInclude = readFileSync(path.join(process.cwd(), '.worktreeinclude'), 'utf8');

    expect(workflow).not.toMatch(/--model\s+\S+\s+app-server/);
    expect(workflow).not.toMatch(/CODEX_HOME=.*codex .*app-server/);
    expect(workflow).not.toMatch(/^  (?:home|model|reasoning_effort|extra_flags):/m);
    expect(envExample).toContain('SYMPHONY_AGENT_RUNTIME=codex');
    expect(envExample).toContain('ANTHROPIC_MODEL=');
    expect(envExample).toContain('SYMPHONY_CODEX_MODEL=');
    expect(worktreeInclude).not.toMatch(/^\.env(?:\..*)?$/m);
  });

  it('keeps the checked-in self-hosting workspace root under system state', () => {
    const workflowPath = path.join(process.cwd(), 'WORKFLOW.md');
    const workflow = readFileSync(workflowPath, 'utf8');
    const parsed = parseWorkflowFrontMatter(workflow);

    const workspace = parsed.config.workspace as { root?: unknown };

    expect(workspace.root).toBe('./.symphony/system/workspaces');
  });

  it('keeps Agent Review active only through handoff and fresh-dispatch config', () => {
    const workflowPath = path.join(process.cwd(), 'WORKFLOW.md');
    const workflow = readFileSync(workflowPath, 'utf8');
    const parsed = parseWorkflowFrontMatter(workflow);

    const tracker = parsed.config.tracker as {
      active_states?: unknown;
      handoff_states?: unknown;
      fresh_dispatch_states?: unknown;
    };

    expect(tracker.active_states).toEqual(['Todo', 'In Progress', 'Agent Review', 'Merging', 'Rework']);
    expect(tracker.handoff_states).toEqual(['Agent Review', 'Human Review']);
    expect(tracker.fresh_dispatch_states).toEqual(['Agent Review']);
    expect(tracker.active_states).not.toContain('Human Review');
    expect(workflow).toContain(
      '`Agent Review` is in `active_states` only with the paired `handoff_states` and `fresh_dispatch_states` entries'
    );
    expect(workflow).toContain(
      'The implementation worker must stop after moving the issue to `Agent Review`'
    );
    expect(workflow).toContain(
      '`Agent Review` -> run Step 3 Agent Review flow in this fresh review context'
    );
    expect(workflow).toContain(
      'If this run authored the implementation being reviewed, stop and leave the issue in `Agent Review`'
    );
    expect(workflow).toContain('Move issue from `Agent Review` to `In Progress`');
    expect(workflow).toContain('Move issue from `Agent Review` to `Rework`');
    expect(workflow).toContain('A Linear label named `Human Review` is an explicit human-review routing requirement');
    expect(workflow).toContain('Match this label case-insensitively');
    expect(workflow).toContain('normalized to lowercase by the tracker model');
    expect(workflow).toContain('Review routing: Human Review label present');
    expect(workflow).toContain(
      'If review passes and none of these are present: UI review, non-UI human review, or the `Human Review` label requirement'
    );
    expect(workflow).toContain('Routing: Human Review');
    expect(workflow).toContain('Routing: Merging');
  });

  it('requires scenario-to-surface review for cross-cutting contract changes', () => {
    const workflowPath = path.join(process.cwd(), 'WORKFLOW.md');
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).toContain('Run the cross-cutting contract propagation lens');
    expect(workflow).toContain('typed contract, lifecycle invariant, state');
    expect(workflow).toContain('`Propagation matrix: not required`');
    expect(workflow).toContain('Build the trace from current code reality');
    expect(workflow).toContain('Recent Linear comments, review comments, and prior findings that add or');
    expect(workflow).toContain('### Scope Comments Reviewed');
    expect(workflow).toContain('### Scenario-To-Surface Trace');
    expect(workflow).toContain('### Path Census');
    expect(workflow).toContain('### Invalid Evidence Check');
    expect(workflow).toContain('API/state/diagnostics');
    expect(workflow).toContain('Dashboard/operator UI');
    expect(workflow).toContain('Persistence/history/audit');
    expect(workflow).toContain('Fixture data is not evidence unless a production consumer assertion proves');
    expect(workflow).toContain('One representative path is not enough for audit/history/refusal invariants');
    expect(workflow).toContain('Combined "API/dashboard/persistence pass" verdicts are invalid');
    expect(workflow).toContain('real implementation path behind');
    expect(workflow).toContain('continue adjacent scanning far enough to batch');
    expect(workflow).toContain('immediate P1 safety issue');
    expect(workflow).not.toContain('| Persistence/API/dashboard/forensics | `<records/projections>` | `<pass/finding/N/A>` |');
  });

  it('requires evidence-backed Agent Review lenses', () => {
    const workflowPath = path.join(process.cwd(), 'WORKFLOW.md');
    const workflow = readFileSync(workflowPath, 'utf8');
    const lensesPath = path.join(process.cwd(), 'docs/agents/review-lenses.md');
    const lenses = readFileSync(lensesPath, 'utf8');

    expect(workflow).toContain('docs/agents/review-lenses.md');
    expect(workflow).toContain('evidence-backed Agent Review artifact');
    expect(workflow).toContain('Prior findings reviewed:');
    expect(workflow).toContain('Independent Invariants');
    expect(workflow).toContain('Triggered Review Lenses');
    expect(workflow).toContain('without evidence-backed lens verdicts is invalid');
    expect(lenses).toContain('### Multi-Phase Mutation');
    expect(lenses).toContain('### Control-Plane Hot Path');
    expect(lenses).toContain('### Generated Asset And Freshness');
    expect(lenses).toContain('### Metric And Telemetry Semantics');
  });

  it('keeps SPEC.ext.md aligned with implemented handoff runtime semantics', () => {
    const specPath = path.join(process.cwd(), 'SPEC.ext.md');
    const spec = readFileSync(specPath, 'utf8');

    expect(spec).toContain('Status: v1 reference extension');
    expect(spec).toContain('## 6. Dispatch and Reconciliation Implications');
    expect(spec).toContain('### 6.1 Local Worker State-Refresh Order');
    expect(spec).toContain('### 6.2 Orchestrator Dispatch and Retry Semantics');
    expect(spec).toContain('### 6.3 Reconciliation and Cleanup Separation');
    expect(spec).toContain('## 10. Implementation and Test Evidence');
    expect(spec).toContain('src/orchestrator/local-worker-runner.ts');
    expect(spec).toContain('tests/orchestrator/core-handoff.test.ts');
    expect(spec).toContain('tests/orchestrator/core-reconciliation.test.ts');
    expect(spec).not.toContain('Runtime stop, resume, and fresh-dispatch behavior is implemented by later slices');
    expect(spec).not.toContain('The following runtime behaviors are intentionally deferred');
  });
});
