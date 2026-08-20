import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

function readRepoFile(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('linear ui evidence guidance', () => {
  it('keeps the ui evidence skill focused on the script-backed GraphQL-only path', () => {
    const skill = readRepoFile('.codex/skills/linear-ui-evidence/SKILL.md');

    expect(skill).toContain('intentional GraphQL-only exception');
    expect(skill).toContain('publish-linear-ui-evidence.js');
    expect(skill).toContain('fileUpload(makePublic:false)');
    expect(skill).toContain('comment.bodyData');
    expect(skill).toContain('Do not hand-author raw `linear_graphql` calls');
    expect(skill).toContain('verification.status: "passed"');
  });

  it('points raw linear_graphql users to the publisher for screenshots and screencasts', () => {
    const skill = readRepoFile('.codex/skills/linear-graphql/SKILL.md');

    expect(skill).toContain('Do not use this skill to hand-build screenshot or screencast uploads');
    expect(skill).toContain('publish-linear-ui-evidence.js');
    expect(skill).toContain('For Playwright screenshots or screencasts, use the `linear-ui-evidence`');
    expect(skill).not.toContain('### Upload UI evidence media to a comment');
    expect(skill).not.toContain('Do this in three steps:');
  });

  it('documents the MCP-first boundary and Agent Review blocker in workflow guidance', () => {
    const workflow = readRepoFile('WORKFLOW.md');
    const playbook = readRepoFile('docs/playbooks/linear-workflow-playbook.md');
    const reviewChecklist = readRepoFile('docs/playbooks/PR-REVIEW-CHECKLIST.md');

    expect(playbook).toContain('intentional exception to MCP-first Linear operations');
    expect(playbook).toContain('Do not hand-author dynamic app-server `linear_graphql` calls');
    expect(workflow).toContain('Missing or non-rendering UI evidence');
    expect(workflow).toContain('The evidence must be visible as Linear-rendered image/video media');
    expect(reviewChecklist).toContain('Linear workflow operations use MCP');
    expect(reviewChecklist).toContain('Any raw `linear_graphql` use is justified');
    expect(reviewChecklist).toContain('UI-affecting changes include rendered Linear rich media evidence');
    expect(reviewChecklist).toContain('Local `output/playwright/*` paths');
  });
});
