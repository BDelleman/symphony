import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseWorkflowFrontMatter } from '../../src/workflow/frontmatter';
import { TemplateEngine } from '../../src/workflow/template-engine';

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
    expect(tracker.handoff_states).toEqual(['Agent Review', 'Human Review', 'Merging', 'Rework']);
    expect(tracker.fresh_dispatch_states).toEqual(['Agent Review', 'Merging', 'Rework']);
    expect(tracker.active_states).not.toContain('Human Review');
    expect(workflow).toContain(
      'The implementation worker must not perform formal Agent Review'
    );
    expect(workflow).toContain('Any transition to another workflow phase ends the run');
    expect(workflow).toContain(
      'This is a fresh, independent review'
    );
    expect(workflow).toContain(
      'If this run authored the candidate, stop and leave the issue unchanged'
    );
    expect(workflow).toContain('fixable P1/P2 to `In Progress`');
    expect(workflow).toContain('reset-level P1/P2 to `Rework`');
    expect(workflow).toContain('A Linear label named `Human Review` is an explicit human-review routing requirement');
    expect(workflow).toContain('Match this label case-insensitively');
    expect(workflow).toContain('normalized to lowercase by the tracker model');
    expect(workflow).toContain('Review routing: Human Review label present');
    expect(workflow).toContain('otherwise pass to `Merging`');
    expect(workflow).toContain('make the chosen state transition');
    expect(workflow).toContain('npm run review:governed -- prepare --issue');
    expect(workflow).toContain('--pr "<linked-pr-number>"');
    expect(workflow).toContain('npm run review:governed -- finalize --body-file');
    expect(workflow.match(/review:governed -- prepare/g)).toHaveLength(1);
    expect(workflow).toContain('Do not query GitHub separately; the prepare command owns that snapshot');
    expect(workflow).toContain('Immediately refresh Linear again');
    expect(workflow).not.toContain('review_round');
  });

  it('renders only the instructions owned by the dispatch state', async () => {
    const workflow = readFileSync(path.join(process.cwd(), 'WORKFLOW.md'), 'utf8');
    const parsed = parseWorkflowFrontMatter(workflow);
    const template = new TemplateEngine().compile(parsed.promptTemplate);
    const issue = {
      identifier: 'NIE-1',
      title: 'Test',
      description: 'Test change',
      labels: [],
      url: 'https://linear.app/test',
      state: 'In Progress'
    };

    const implementation = await template.render({ issue, attempt: null });
    expect(implementation).toContain('## Implementation flow');
    expect(implementation).not.toContain('## Agent Review flow');
    expect(implementation).not.toContain('## Merging flow');

    const review = await template.render({ issue: { ...issue, state: 'Agent Review' }, attempt: null });
    expect(review).toContain('## Agent Review flow');
    expect(review).not.toContain('## Implementation flow');
    expect(review).not.toContain('## Merging flow');

    const merging = await template.render({ issue: { ...issue, state: 'Merging' }, attempt: null });
    expect(merging).toContain('## Merging flow');
    expect(merging).not.toContain('## Implementation flow');
    expect(merging).not.toContain('## Agent Review flow');
  });

  it('requires scenario-to-surface review for cross-cutting contract changes', () => {
    const workflowPath = path.join(process.cwd(), 'WORKFLOW.md');
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).toContain('Run the cross-cutting contract propagation lens');
    expect(workflow).toContain('typed contract, lifecycle invariant, state');
    expect(workflow).toContain('`Propagation matrix: not required`');
    expect(workflow).toContain('Build the trace from current code reality');
    expect(workflow).toContain('### Scope Comments Reviewed');
    expect(workflow).toContain('### Scenario-To-Surface Trace');
    expect(workflow).toContain('### Path Census');
    expect(workflow).toContain('### Invalid Evidence Check');
    expect(workflow).toContain('API/state/diagnostics');
    expect(workflow).toContain('Dashboard/operator UI');
    expect(workflow).toContain('Persistence/history/audit');
    expect(workflow).toContain('Fixture data is not evidence unless a production consumer assertion proves');
    expect(workflow).toContain('One representative path is not enough for audit/history/refusal invariants');
    expect(workflow).toContain('combined "API/dashboard/persistence pass" verdicts are invalid');
    expect(workflow).not.toContain('| Persistence/API/dashboard/forensics | `<records/projections>` | `<pass/finding/N/A>` |');
  });

  it('requires evidence-backed Agent Review lenses', () => {
    const workflowPath = path.join(process.cwd(), 'WORKFLOW.md');
    const workflow = readFileSync(workflowPath, 'utf8');
    const lensesPath = path.join(process.cwd(), 'docs/agents/review-lenses.md');
    const lenses = readFileSync(lensesPath, 'utf8');

    expect(workflow).toContain('docs/agents/review-lenses.md');
    expect(workflow).toContain('evidence-backed Agent Review artifact');
    expect(workflow).toContain('Prior findings reviewed');
    expect(workflow).toContain('Independent Invariants');
    expect(workflow).toContain('Triggered Review Lenses');
    expect(workflow).toContain('without evidence-backed lens verdicts is invalid');
    expect(workflow).toContain('Trigger lenses from changed semantics, not vocabulary');
    expect(workflow).toContain('Do not add P3 notes');
    expect(lenses).toContain('documentation sentence that merely mentions a command');
    expect(lenses).toContain('Record only triggered lenses');
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
    expect(spec).toContain('### 10.1 Governed Agent Review Capsule');
    expect(spec).toContain('scripts/review-with-governance.js');
    expect(spec).not.toContain('Runtime stop, resume, and fresh-dispatch behavior is implemented by later slices');
    expect(spec).not.toContain('The following runtime behaviors are intentionally deferred');
  });
});
