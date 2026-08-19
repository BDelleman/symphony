import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('Symphony self-hosting workflow policy', () => {
  it('keeps Symphony-specific PR, spec, and governance gates in checked-in workflow guidance', () => {
    const workflow = readRepoFile('WORKFLOW.md');

    expect(workflow).toContain('## PR feedback sweep protocol');
    expect(workflow).toContain('the `symphony` label');
    expect(workflow).toContain('npm run submit:pr-governed -- --mode upsert --title "<title>"');
    expect(workflow).toContain('--branch "<current-branch>" --wait');
    expect(workflow).toContain('The PR body must include Summary, Spec Alignment with relevant `SPEC.md`');
    expect(workflow).toContain('Review routing: Human Review label present');
    expect(workflow).toContain('`Done` is only allowed after the exact reviewed PR head is confirmed merged');
  });

  it('keeps reusable portable skills free of Symphony-only submit and review routing policy', () => {
    for (const skillPath of [
      '.codex/skills/commit/SKILL.md',
      '.codex/skills/pull/SKILL.md',
      '.codex/skills/push/SKILL.md',
      '.codex/skills/land/SKILL.md'
    ]) {
      const skill = readRepoFile(skillPath);
      expect(skill, skillPath).not.toContain('submit:pr-governed');
      expect(skill, skillPath).not.toContain('Spec Alignment with relevant `SPEC.md`');
      expect(skill, skillPath).not.toContain('Review routing: Human Review label present');
      expect(skill, skillPath).not.toContain('Ensure the GitHub PR has label `symphony`');
    }
  });
});
