import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDurableIdentity,
  createStoreTestHarness,
  fs,
  os,
  path,
  SqlitePersistenceStore
} from './store-test-harness';

describe('SqlitePersistenceStore identity', () => {
  const { dirs, stores, identity, openDatabase, tableNames, withLegacyProjectKey, cleanup } = createStoreTestHarness();

  afterEach(cleanup);
  it('persists durable project and ticket identity across run and execution graph reopen', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-identity-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({
      issue_id: 'linear-remote-1',
      issue_identifier: 'NIE-139',
      projectRoot: path.join(dir, 'same-name'),
      workflowPath: path.join(dir, 'same-name', 'WORKFLOW.md')
    });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const runId = storeA.startRun({
      issue_id: 'linear-remote-1',
      issue_identifier: 'NIE-139',
      identity: durableIdentity
    });
    const issueRunId = storeA.appendIssueRun({
      issue_id: 'linear-remote-1',
      issue_identifier: 'NIE-139',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      status: 'running'
    });
    const attemptId = storeA.appendAttempt({
      issue_run_id: issueRunId,
      attempt_number: 0,
      started_at: '2026-04-11T10:00:01.000Z',
      status: 'running'
    });
    const threadId = storeA.appendThread({
      attempt_id: attemptId,
      thread_id: 'thread-identity',
      started_at: '2026-04-11T10:00:02.000Z',
      status: 'running'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);

    expect(storeB.listRunHistory()[0]).toMatchObject({
      run_id: runId,
      identity: durableIdentity
    });
    expect(storeB.reconstructThreadLineage(threadId)?.issue_run.identity).toEqual(durableIdentity);
  });

  it('persists history identity rows in the versioned schema', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-identity-schema-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    const durableIdentity = identity({ issue_id: 'remote-history-1', issue_identifier: 'HIST-2' });
    store.startRun({ issue_id: 'remote-history-1', issue_identifier: 'HIST-2', identity: durableIdentity });

    const db = openDatabase(dbPath);
    try {
      expect(db.prepare('SELECT project_key FROM history_project_identity').all()).toEqual([
        { project_key: durableIdentity.project.key }
      ]);
      expect(db.prepare('SELECT ticket_key, project_key, remote_issue_id FROM history_ticket_identity').all()).toEqual([
        {
          ticket_key: durableIdentity.ticket.key,
          project_key: durableIdentity.project.key,
          remote_issue_id: 'remote-history-1'
        }
      ]);
    } finally {
      db.close();
    }
  });

  it('scopes ticket identity rows by project identity', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-ticket-scope-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const projectA = identity({
      issue_id: 'shared-remote-1',
      issue_identifier: 'NIE-162',
      projectRoot: path.join(dir, 'project-a'),
      workflowPath: path.join(dir, 'project-a', 'WORKFLOW.md')
    });
    const projectB = identity({
      issue_id: 'shared-remote-1',
      issue_identifier: 'NIE-162',
      projectRoot: path.join(dir, 'project-b'),
      workflowPath: path.join(dir, 'project-b', 'WORKFLOW.md')
    });
    expect(projectA.ticket.key).toBe(projectB.ticket.key);
    expect(projectA.project.key).not.toBe(projectB.project.key);

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    store.startRun({ issue_id: 'shared-remote-1', issue_identifier: 'NIE-162', identity: projectA });
    store.startRun({ issue_id: 'shared-remote-1', issue_identifier: 'NIE-162', identity: projectB });
    store.startRun({ issue_id: 'shared-remote-1', issue_identifier: 'NIE-162', identity: projectA });
    store.appendIssueRun({
      issue_run_id: 'project-a-run-1',
      issue_id: 'shared-remote-1',
      issue_identifier: 'NIE-162',
      identity: projectA,
      started_at: '2026-04-11T10:00:00.000Z',
      status: 'running'
    });
    store.appendIssueRun({
      issue_run_id: 'project-b-run-1',
      issue_id: 'shared-remote-1',
      issue_identifier: 'NIE-162',
      identity: projectB,
      started_at: '2026-04-11T10:01:00.000Z',
      status: 'running'
    });
    store.appendIssueRun({
      issue_run_id: 'project-a-run-2',
      issue_id: 'shared-remote-1',
      issue_identifier: 'NIE-162',
      identity: projectA,
      started_at: '2026-04-11T10:02:00.000Z',
      status: 'running'
    });

    const db = openDatabase(dbPath);
    try {
      const expectedRows = [
        { project_key: projectA.project.key, ticket_key: projectA.ticket.key },
        { project_key: projectB.project.key, ticket_key: projectB.ticket.key }
      ].sort((a, b) => a.project_key.localeCompare(b.project_key));
      expect(db.prepare('SELECT project_key, ticket_key FROM history_ticket_identity ORDER BY project_key').all()).toEqual(expectedRows);
      expect(db.prepare('SELECT COUNT(*) AS count FROM history_ticket_identity WHERE project_key = ? AND ticket_key = ?').get(projectA.project.key, projectA.ticket.key)).toEqual({
        count: 1
      });
      expect(store.listProjectTicketIdentities(projectA.project.key).items).toEqual([projectA]);
      expect(store.listProjectTicketIdentities(projectB.project.key).items).toEqual([projectB]);
      expect(store.getProjectTicketIdentity(projectA.project.key, projectA.ticket.key)).toEqual(projectA);
      expect(store.getProjectTicketIdentity(projectB.project.key, projectB.ticket.key)).toEqual(projectB);
    } finally {
      db.close();
    }
  });

  it('keeps project and ticket identity collision inputs distinct', () => {
    const rootA = identity({
      issue_id: 'remote-1',
      issue_identifier: 'TASK-1',
      projectRoot: '/work/a/service',
      workflowPath: '/work/a/service/WORKFLOW.md'
    });
    const rootB = identity({
      issue_id: 'remote-1',
      issue_identifier: 'TASK-1',
      projectRoot: '/work/b/service',
      workflowPath: '/work/b/service/WORKFLOW.md'
    });
    const workflowChanged = identity({
      issue_id: 'remote-1',
      issue_identifier: 'TASK-1',
      projectRoot: '/work/a/service',
      workflowPath: '/work/a/service/alternate/WORKFLOW.md'
    });
    const renamedTicket = identity({
      issue_id: 'remote-1',
      issue_identifier: 'TASK-99',
      projectRoot: '/work/a/service',
      workflowPath: '/work/a/service/WORKFLOW.md'
    });
    const reusedHumanIdOtherScope = identity({
      issue_id: 'remote-2',
      issue_identifier: 'TASK-1',
      projectRoot: '/work/a/service',
      workflowPath: '/work/a/service/WORKFLOW.md',
      trackerScope: 'other-project'
    });

    expect(rootA.project.key).not.toBe(rootB.project.key);
    expect(rootA.project.key).not.toBe(workflowChanged.project.key);
    expect(rootA.ticket.key).toBe(renamedTicket.ticket.key);
    expect(rootA.ticket.human_issue_identifier).not.toBe(renamedTicket.ticket.human_issue_identifier);
    expect(rootA.ticket.key).not.toBe(reusedHumanIdOtherScope.ticket.key);
  });

  it('keeps project identity stable when workflow hash and repository remote evidence change', () => {
    const originalEvidence = identity({
      issue_id: 'remote-1',
      issue_identifier: 'TASK-1',
      projectRoot: '/work/a/service',
      workflowPath: '/work/a/service/WORKFLOW.md',
      workflowHash: 'workflow-hash-a',
      repositoryRemote: 'git@github.com:nielsgl/symphony.git'
    });
    const changedWorkflowContent = identity({
      issue_id: 'remote-1',
      issue_identifier: 'TASK-1',
      projectRoot: '/work/a/service',
      workflowPath: '/work/a/service/WORKFLOW.md',
      workflowHash: 'workflow-hash-b',
      repositoryRemote: 'git@github.com:nielsgl/symphony.git'
    });
    const changedRepositoryRemote = identity({
      issue_id: 'remote-1',
      issue_identifier: 'TASK-1',
      projectRoot: '/work/a/service',
      workflowPath: '/work/a/service/WORKFLOW.md',
      workflowHash: 'workflow-hash-b',
      repositoryRemote: 'https://github.com/nielsgl/symphony.git'
    });

    expect(originalEvidence.project.key).toBe(changedWorkflowContent.project.key);
    expect(originalEvidence.project.key).toBe(changedRepositoryRemote.project.key);
    expect(changedRepositoryRemote.project.workflow_hash).toEqual({ status: 'present', value: 'workflow-hash-b' });
    expect(changedRepositoryRemote.project.repository_remote).toEqual({
      status: 'present',
      value: 'https://github.com/nielsgl/symphony.git'
    });
  });

  it('groups project history for the same root and workflow path while updating identity evidence', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-stable-project-identity-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const originalEvidence = identity({
      issue_id: 'stable-identity-1',
      issue_identifier: 'STABLE-1',
      projectRoot: path.join(dir, 'project'),
      workflowPath: path.join(dir, 'project', 'WORKFLOW.md'),
      workflowHash: 'workflow-hash-a',
      repositoryRemote: 'git@github.com:nielsgl/symphony.git'
    });
    const changedEvidence = identity({
      issue_id: 'stable-identity-1',
      issue_identifier: 'STABLE-1',
      projectRoot: path.join(dir, 'project'),
      workflowPath: path.join(dir, 'project', 'WORKFLOW.md'),
      workflowHash: 'workflow-hash-b',
      repositoryRemote: 'https://github.com/nielsgl/symphony.git'
    });

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    store.appendIssueRun({
      issue_id: 'stable-identity-1',
      issue_identifier: 'STABLE-1',
      identity: originalEvidence,
      started_at: '2026-04-11T10:00:00.000Z',
      status: 'succeeded',
      ended_at: '2026-04-11T10:02:00.000Z'
    });
    store.appendIssueRun({
      issue_id: 'stable-identity-1',
      issue_identifier: 'STABLE-1',
      identity: changedEvidence,
      started_at: '2026-04-11T11:00:00.000Z',
      status: 'succeeded',
      ended_at: '2026-04-11T11:02:00.000Z'
    });

    expect(originalEvidence.project.key).toBe(changedEvidence.project.key);
    expect(store.reconstructTicketTimeline(changedEvidence).issue_runs).toHaveLength(2);

    const db = openDatabase(dbPath);
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM history_project_identity').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT workflow_hash_value, repository_remote_value FROM history_project_identity').get()).toEqual({
        workflow_hash_value: 'workflow-hash-b',
        repository_remote_value: 'https://github.com/nielsgl/symphony.git'
      });
    } finally {
      db.close();
    }
  });

  it('normalizes legacy project identity keys idempotently without dropping history rows', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-legacy-project-identity-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const oldEvidence = withLegacyProjectKey(
      identity({
        issue_id: 'legacy-identity-1',
        issue_identifier: 'LEGACY-1',
        projectRoot: path.join(dir, 'project'),
        workflowPath: path.join(dir, 'project', 'WORKFLOW.md'),
        workflowHash: 'workflow-hash-a',
        repositoryRemote: 'git@github.com:nielsgl/symphony.git'
      })
    );
    const newEvidence = identity({
      issue_id: 'legacy-identity-1',
      issue_identifier: 'LEGACY-1',
      projectRoot: path.join(dir, 'project'),
      workflowPath: path.join(dir, 'project', 'WORKFLOW.md'),
      workflowHash: 'workflow-hash-b',
      repositoryRemote: 'https://github.com/nielsgl/symphony.git'
    });
    expect(oldEvidence.project.key).not.toBe(newEvidence.project.key);

    const storeA = new SqlitePersistenceStore({
      dbPath,
      retentionDays: 14,
      migrationFailureForTest: 'stable_project_identity_key_v1'
    });
    storeA.close();
    const dbA = openDatabase(dbPath);
    try {
      dbA.prepare("DELETE FROM history_schema_migrations WHERE schema_name = 'project_execution_history' AND version = 8").run();
      dbA
        .prepare(
          `UPDATE history_schema_state
           SET applied_version = 7, status = 'healthy', degraded_reason_code = NULL, degraded_detail = NULL
           WHERE schema_name = 'project_execution_history'`
        )
        .run();
      dbA
        .prepare(
          `INSERT INTO history_project_identity
            (project_key, project_root, workflow_path, workflow_hash_status, workflow_hash_value, workflow_hash_reason,
             repository_remote_status, repository_remote_value, repository_remote_reason, created_at, updated_at)
           VALUES (?, ?, ?, 'present', 'workflow-hash-a', NULL, 'present', ?, NULL, ?, ?)`
        )
        .run(
          oldEvidence.project.key,
          oldEvidence.project.project_root,
          oldEvidence.project.workflow_path,
          'git@github.com:nielsgl/symphony.git',
          '2026-04-11T10:00:00.000Z',
          '2026-04-11T10:00:00.000Z'
        );
      dbA
        .prepare(
          `INSERT INTO issue_run
            (issue_run_id, issue_id, issue_identifier, identity, project_key, ticket_key, started_at, ended_at, status, reason_code, reason_detail)
           VALUES ('legacy-run-1', 'legacy-identity-1', 'LEGACY-1', ?, ?, ?, '2026-04-11T10:00:00.000Z', NULL, 'running', NULL, NULL)`
        )
        .run(JSON.stringify(oldEvidence), oldEvidence.project.key, oldEvidence.ticket.key);
      dbA
        .prepare(
          `INSERT INTO history_ticket_reference
            (ticket_reference_id, project_key, ticket_key, issue_run_id, attempt_id, thread_id, turn_id,
             reference_kind, availability, uri, label, external_id, state, metadata, observed_at, observation_hash,
             duplicate_count, last_observed_at)
           VALUES ('legacy-reference-1', ?, ?, 'legacy-run-1', NULL, NULL, NULL,
             'branch', 'available', 'https://github.com/nielsgl/symphony/tree/legacy', 'legacy', NULL, NULL, NULL,
             '2026-04-11T10:00:00.000Z', 'legacy-reference-hash', 1, '2026-04-11T10:00:00.000Z')`
        )
        .run(oldEvidence.project.key, oldEvidence.ticket.key);
    } finally {
      dbA.close();
    }

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    expect(storeB.historySchemaHealth()).toMatchObject({ applied_version: 14, status: 'healthy' });
    expect(storeB.listProjectTicketIdentities(newEvidence.project.key).total).toBe(1);
    expect(storeB.reconstructTicketTimeline(newEvidence).issue_runs).toHaveLength(1);
    storeB.close();
    stores.pop();

    const storeC = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeC);
    expect(storeC.historySchemaHealth()).toMatchObject({ applied_version: 14, status: 'healthy' });
    expect(storeC.reconstructTicketTimeline(newEvidence).issue_runs).toHaveLength(1);

    const dbC = openDatabase(dbPath);
    try {
      expect(dbC.prepare('SELECT COUNT(*) AS count FROM issue_run').get()).toEqual({ count: 1 });
      expect(dbC.prepare('SELECT COUNT(*) AS count FROM history_project_identity').get()).toEqual({ count: 1 });
      expect(dbC.prepare('SELECT project_key, workflow_hash_value, repository_remote_value FROM history_project_identity').get()).toEqual({
        project_key: newEvidence.project.key,
        workflow_hash_value: 'workflow-hash-a',
        repository_remote_value: 'git@github.com:nielsgl/symphony.git'
      });
      expect(dbC.prepare('SELECT project_key FROM issue_run WHERE issue_run_id = ?').get('legacy-run-1')).toEqual({
        project_key: newEvidence.project.key
      });
      expect(dbC.prepare('SELECT project_key FROM history_ticket_identity WHERE ticket_key = ?').get(oldEvidence.ticket.key)).toEqual({
        project_key: newEvidence.project.key
      });
      expect(dbC.prepare('SELECT project_key FROM history_ticket_reference WHERE ticket_reference_id = ?').get('legacy-reference-1')).toEqual({
        project_key: newEvidence.project.key
      });
      expect(
        dbC
          .prepare(
            `SELECT COUNT(*) AS count FROM (
              SELECT project_key FROM issue_run WHERE project_key = ?
              UNION ALL SELECT project_key FROM history_ticket_identity WHERE project_key = ?
              UNION ALL SELECT project_key FROM history_ticket_reference WHERE project_key = ?
              UNION ALL SELECT project_key FROM history_identity_projection WHERE project_key = ?
            )`
          )
          .get(oldEvidence.project.key, oldEvidence.project.key, oldEvidence.project.key, oldEvidence.project.key)
      ).toEqual({ count: 0 });
    } finally {
      dbC.close();
    }
  });

  it('represents missing optional identity evidence explicitly', () => {
    const missingEvidence = buildDurableIdentity({
      projectRoot: '/repo',
      workflowPath: '/repo/WORKFLOW.md',
      workflowHash: { status: 'missing', reason: 'workflow_file_unreadable' },
      repositoryRemote: { status: 'missing', reason: 'repository_remote_unavailable' },
      trackerKind: 'linear',
      trackerScope: null,
      remoteIssueId: 'issue-1',
      humanIssueIdentifier: 'ABC-1'
    });

    expect(missingEvidence.project.workflow_hash).toEqual({ status: 'missing', reason: 'workflow_file_unreadable' });
    expect(missingEvidence.project.repository_remote).toEqual({ status: 'missing', reason: 'repository_remote_unavailable' });
    expect(missingEvidence.ticket.tracker_scope).toEqual({ status: 'missing', reason: 'tracker_scope_unavailable' });
  });

  it('backfills existing run history identity projections and degraded evidence idempotently', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-backfill-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const projectedIdentity = identity({
      issue_id: 'legacy-remote-1',
      issue_identifier: 'LEG-1',
      trackerScope: null
    });
    const issueRunIdentity = identity({
      issue_id: 'legacy-remote-2',
      issue_identifier: 'LEG-2'
    });
    const db = openDatabase(dbPath);
    try {
      db.exec(`
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
          issue_identifier TEXT NOT NULL,
          identity TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          terminal_status TEXT,
          error_code TEXT
        );
        CREATE TABLE run_sessions (
          run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          PRIMARY KEY (run_id, session_id)
        );
        CREATE TABLE run_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          at TEXT NOT NULL,
          event TEXT NOT NULL,
          message TEXT
        );
        CREATE TABLE issue_run (
          issue_run_id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
          issue_identifier TEXT NOT NULL,
          identity TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE attempt (
          attempt_id TEXT PRIMARY KEY,
          issue_run_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE thread (
          thread_id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE turn (
          turn_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_index INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE phase_span (
          phase_span_id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL,
          phase TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE tool_span (
          tool_span_id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE state_transition (
          state_transition_id TEXT PRIMARY KEY,
          issue_run_id TEXT NOT NULL,
          attempt_id TEXT,
          thread_id TEXT,
          turn_id TEXT,
          from_status TEXT,
          to_status TEXT NOT NULL,
          transitioned_at TEXT NOT NULL,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
      `);
      db.prepare(
        `INSERT INTO runs (run_id, issue_id, issue_identifier, identity, started_at, ended_at, terminal_status, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'legacy-run-projectable',
        'legacy-remote-1',
        'LEG-1',
        JSON.stringify(projectedIdentity),
        '2026-04-11T10:00:00.000Z',
        '2026-04-11T10:05:00.000Z',
        'failed',
        'legacy_error'
      );
      db.prepare(
        `INSERT INTO runs (run_id, issue_id, issue_identifier, identity, started_at, ended_at, terminal_status, error_code)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`
      ).run(
        'legacy-run-degraded',
        'legacy-remote-missing',
        'LEG-MISSING',
        '2026-04-11T10:10:00.000Z',
        '2026-04-11T10:15:00.000Z',
        'failed',
        'legacy_missing_identity'
      );
      db.prepare(
        `INSERT INTO issue_run (issue_run_id, issue_id, issue_identifier, identity, started_at, ended_at, status, reason_code, reason_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'legacy-issue-run-projectable',
        'legacy-remote-2',
        'LEG-2',
        JSON.stringify(issueRunIdentity),
        '2026-04-11T11:00:00.000Z',
        null,
        'running',
        null,
        null
      );
    } finally {
      db.close();
    }

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => Date.parse('2026-04-11T12:00:00.000Z') });
    stores.push(storeA);
    const history = storeA.listRunHistory(10);

    expect(history.find((run) => run.run_id === 'legacy-run-projectable')).toMatchObject({
      issue_identifier: 'LEG-1',
      identity: projectedIdentity,
      identity_projection: {
        source_table: 'runs',
        source_id: 'legacy-run-projectable',
        projection_status: 'projected',
        reason_code: null,
        project_key: projectedIdentity.project.key,
        ticket_key: projectedIdentity.ticket.key
      }
    });
    expect(history.find((run) => run.run_id === 'legacy-run-projectable')?.identity?.ticket.tracker_scope).toEqual({
      status: 'missing',
      reason: 'tracker_scope_unavailable'
    });
    expect(history.find((run) => run.run_id === 'legacy-run-degraded')).toMatchObject({
      issue_identifier: 'LEG-MISSING',
      identity: null,
      identity_projection: {
        source_table: 'runs',
        source_id: 'legacy-run-degraded',
        projection_status: 'degraded',
        reason_code: 'missing_durable_identity',
        project_key: null,
        ticket_key: null
      }
    });
    const backfillDbA = openDatabase(dbPath);
    try {
      expect(backfillDbA.prepare('SELECT project_key FROM history_project_identity ORDER BY project_key').all()).toEqual(
        expect.arrayContaining([{ project_key: projectedIdentity.project.key }, { project_key: issueRunIdentity.project.key }])
      );
      expect(
        backfillDbA
          .prepare('SELECT issue_run_id, project_key, ticket_key FROM issue_run WHERE issue_run_id = ?')
          .get('legacy-issue-run-projectable')
      ).toEqual({
        issue_run_id: 'legacy-issue-run-projectable',
        project_key: issueRunIdentity.project.key,
        ticket_key: issueRunIdentity.ticket.key
      });
      expect(backfillDbA.prepare('SELECT COUNT(*) AS count FROM history_identity_projection').get()).toEqual({ count: 3 });
    } finally {
      backfillDbA.close();
    }
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => Date.parse('2026-04-11T12:05:00.000Z') });
    stores.push(storeB);
    const backfillDbB = openDatabase(dbPath);
    try {
      expect(storeB.historySchemaHealth()).toMatchObject({ applied_version: 14, status: 'healthy' });
      expect(backfillDbB.prepare('SELECT COUNT(*) AS count FROM history_identity_projection').get()).toEqual({ count: 3 });
    } finally {
      backfillDbB.close();
    }
  });


});
