import fs from 'node:fs';
import path from 'node:path';
import type { StructuredLogger } from '../../observability';
import { CANONICAL_EVENT } from '../../observability/events';
import { REASON_CODES } from '../../observability/reason-codes';
import {
  buildMissingToolOutputBlockDetails,
  buildMissingToolOutputRecoveryPrompt,
  buildMissingToolOutputRecoveryState,
  workerTerminationResultDetail
} from './blocked-input-recovery';
import { rememberInactiveWorkerPid } from './worker-events';
import type { BlockedInputScheduleParams } from './blocked-input-coordinator';
import type {
  MissingToolOutputRecoveryState,
  OrchestratorOptions,
  OrchestratorState,
  OutstandingToolCall,
  RunningEntry,
  ToolCallLedgerObservation,
  TranscriptToolCallDiagnostic,
  TranscriptToolCallLineage,
  WorkerTerminationResult
} from '../types';

const DEFAULT_INACTIVE_WORKER_PID_TTL_MS = 60 * 60 * 1000;
const CODEX_SESSION_TRANSCRIPT_CANDIDATE_CACHE_TTL_MS = 15_000;
const CODEX_SESSION_TRANSCRIPT_MAX_CANDIDATE_FILES = 40;
const CODEX_SESSION_TRANSCRIPT_MAX_DISCOVERY_FILES = 20;
const CODEX_SESSION_TRANSCRIPT_MAX_PROBE_BYTES = 256 * 1024;
const CODEX_SESSION_TRANSCRIPT_MAX_SCAN_BYTES = 256 * 1024;
const CODEX_SESSION_TRANSCRIPT_MAX_FILE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CODEX_SESSION_TRANSCRIPT_MAX_WALL_CLOCK_MS = 20;
const CODEX_SESSION_TRANSCRIPT_MAX_DEPTH = 5;

export interface MissingToolOutputTranscriptScanBudgetOptions {
  candidateCacheTtlMs?: number;
  maxCandidateFiles?: number;
  maxDiscoveryFiles?: number;
  maxProbeBytes?: number;
  maxScanBytes?: number;
  maxFileAgeMs?: number;
  maxWallClockMs?: number;
  maxDepth?: number;
}

interface MissingToolOutputTranscriptScanBudget {
  candidateCacheTtlMs: number;
  maxCandidateFiles: number;
  maxDiscoveryFiles: number;
  maxProbeBytes: number;
  maxScanBytes: number;
  maxFileAgeMs: number;
  maxWallClockMs: number;
  maxDepth: number;
}

export interface MissingToolOutputCoordinatorHooks {
  applyToolCallLedgerObservation: (runningEntry: RunningEntry, observation: ToolCallLedgerObservation) => void;
  scheduleBlockedInput: (params: BlockedInputScheduleParams) => Promise<{ created: boolean }>;
  addRuntimeSecondsFromEntry: (runningEntry: RunningEntry) => void;
  completeRunRecord: (
    runningEntry: RunningEntry,
    terminalStatus: 'succeeded' | 'failed' | 'timed_out' | 'stalled' | 'cancelled',
    errorCode: string | null,
    recoveryOverride?: MissingToolOutputRecoveryState | null,
    terminalReasonDetail?: string | null
  ) => Promise<void>;
  persistExecutionGraphStateTransition: (
    runningEntry: RunningEntry,
    toStatus: string,
    status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'retrying',
    reasonCode: string,
    reasonDetail: string | null
  ) => Promise<void>;
  recordRuntimeEvent: (params: {
    event: string;
    severity: 'info' | 'warn' | 'error';
    issue_identifier?: string;
    session_id?: string;
    detail?: string;
    reason_code?: string | null;
    request_method?: string | null;
    request_category?: string | null;
    tool_call_id?: string | null;
    tool_name?: string | null;
  }) => void;
  workerTerminationAllowsRecovery: (result: WorkerTerminationResult) => boolean;
  workerTerminationInterruptStatus: (
    result: WorkerTerminationResult
  ) => NonNullable<MissingToolOutputRecoveryState['interrupt_cancel_result']>['status'];
  workerInstanceIdFromHandle: (workerHandle: unknown) => string | null;
}

export interface MissingToolOutputCoordinatorContext {
  readonly state: OrchestratorState;
  readonly config: OrchestratorOptions['config'];
  readonly terminateWorker: OrchestratorOptions['ports']['terminateWorker'];
  readonly recoverMissingToolOutput?: OrchestratorOptions['ports']['recoverMissingToolOutput'];
  readonly notifyObservers?: OrchestratorOptions['ports']['notifyObservers'];
  readonly logger: StructuredLogger | undefined;
  readonly nowMs: () => number;
  readonly transcriptScanBudget?: MissingToolOutputTranscriptScanBudgetOptions;
  readonly hooks: MissingToolOutputCoordinatorHooks;
}

function transcriptScanBudget(context: MissingToolOutputCoordinatorContext): MissingToolOutputTranscriptScanBudget {
  const budget = context.transcriptScanBudget;
  return {
    candidateCacheTtlMs: budget?.candidateCacheTtlMs ?? CODEX_SESSION_TRANSCRIPT_CANDIDATE_CACHE_TTL_MS,
    maxCandidateFiles: budget?.maxCandidateFiles ?? CODEX_SESSION_TRANSCRIPT_MAX_CANDIDATE_FILES,
    maxDiscoveryFiles: budget?.maxDiscoveryFiles ?? CODEX_SESSION_TRANSCRIPT_MAX_DISCOVERY_FILES,
    maxProbeBytes: budget?.maxProbeBytes ?? CODEX_SESSION_TRANSCRIPT_MAX_PROBE_BYTES,
    maxScanBytes: budget?.maxScanBytes ?? CODEX_SESSION_TRANSCRIPT_MAX_SCAN_BYTES,
    maxFileAgeMs: budget?.maxFileAgeMs ?? CODEX_SESSION_TRANSCRIPT_MAX_FILE_AGE_MS,
    maxWallClockMs: budget?.maxWallClockMs ?? CODEX_SESSION_TRANSCRIPT_MAX_WALL_CLOCK_MS,
    maxDepth: budget?.maxDepth ?? CODEX_SESSION_TRANSCRIPT_MAX_DEPTH
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readTimestampMs(value: Record<string, unknown> | null): number | null {
  if (!value) {
    return null;
  }
  for (const key of ['timestamp_ms', 'timestampMs', 'created_at_ms', 'createdAtMs', 'at_ms', 'atMs']) {
    const numeric = value[key];
    if (typeof numeric === 'number' && Number.isFinite(numeric)) {
      return numeric;
    }
  }
  for (const key of ['timestamp', 'created_at', 'createdAt', 'time']) {
    const text = readString(value[key]);
    if (!text) {
      continue;
    }
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export function coordinateHasOutstandingToolCallEvidence(runningEntry: RunningEntry): boolean {
  return Object.keys(runningEntry.outstanding_tool_calls ?? {}).length > 0;
}

export function coordinateFindMissingToolOutputCandidate(
  runningEntry: RunningEntry,
  observedAtMs: number,
  waitThresholdMs: number
): OutstandingToolCall | null {
  const calls = Object.values(runningEntry.outstanding_tool_calls ?? {});
  if (calls.length === 0) {
    return null;
  }
  const eligible = calls
    .filter((call) => observedAtMs - call.started_at_ms >= waitThresholdMs)
    .sort((left, right) => left.started_at_ms - right.started_at_ms);
  return eligible[0] ?? null;
}

export function coordinateScanCodexSessionTranscriptForToolCalls(
  context: MissingToolOutputCoordinatorContext,
  runningEntry: RunningEntry,
  observedAtMs: number
): void {
  if (!runningEntry.session_id && !runningEntry.thread_id && !runningEntry.turn_id) {
    return;
  }

  const budget = transcriptScanBudget(context);
  const transcriptPaths = findCodexSessionTranscriptPaths(context, runningEntry, observedAtMs, budget);
  if (transcriptPaths.length === 0) {
    return;
  }

  const offsets = (runningEntry.codex_session_transcript_scan_offsets ??= {});
  const reasons = new Set(runningEntry.codex_session_transcript_scan_budget?.reason_codes ?? []);
  let remainingBytes = budget.maxScanBytes;
  let bytesRead = 0;
  let filesParsed = 0;
  for (const transcriptPath of transcriptPaths) {
    if (remainingBytes <= 0) {
      reasons.add('transcript_scan_byte_budget_exhausted');
      break;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }

    const previousOffset = Math.min(offsets[transcriptPath] ?? 0, stat.size);
    let completeContent = '';
    let consumedBytes = 0;
    try {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const unreadBytes = Math.max(0, stat.size - previousOffset);
        const bytesToRead = Math.min(unreadBytes, remainingBytes);
        if (bytesToRead < unreadBytes) {
          reasons.add('transcript_scan_byte_budget_exhausted');
        }
        const buffer = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buffer, 0, buffer.length, previousOffset);
        const lastCompleteLineIndex = buffer.lastIndexOf(0x0a);
        if (lastCompleteLineIndex >= 0) {
          consumedBytes = lastCompleteLineIndex + 1;
          completeContent = buffer.subarray(0, consumedBytes).toString('utf8');
        } else if (bytesToRead > 0 && bytesToRead >= remainingBytes) {
          reasons.add('transcript_scan_byte_budget_exhausted');
        }
        remainingBytes -= bytesToRead;
        bytesRead += bytesToRead;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }

    offsets[transcriptPath] = previousOffset + consumedBytes;
    filesParsed += 1;
    for (const line of completeContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const observation = readToolCallObservationFromTranscriptRecord(parsed, runningEntry, observedAtMs);
      if (observation) {
        context.hooks.applyToolCallLedgerObservation(runningEntry, observation);
      }
    }
  }
  updateTranscriptScanBudget(runningEntry, observedAtMs, {
    candidate_count: transcriptPaths.length,
    files_considered: runningEntry.codex_session_transcript_scan_budget?.files_considered ?? transcriptPaths.length,
    files_parsed: filesParsed,
    bytes_read: bytesRead,
    exhausted: reasons.size > 0,
    reason_codes: [...reasons].sort(),
    limits: budget
  });
}

function findCodexSessionTranscriptPaths(
  context: MissingToolOutputCoordinatorContext,
  runningEntry: RunningEntry,
  observedAtMs: number,
  budget: MissingToolOutputTranscriptScanBudget
): string[] {
  const codexHome = (process.env.SYMPHONY_CODEX_HOME || path.join(process.env.HOME || '', '.codex')).trim();
  if (!codexHome) {
    return [];
  }
  const identityKey = transcriptCandidateIdentityKey(runningEntry);
  const cached = runningEntry.codex_session_transcript_candidate_cache;
  if (
    cached &&
    cached.identity_key === identityKey &&
    observedAtMs - cached.refreshed_at_ms < budget.candidateCacheTtlMs
  ) {
    runningEntry.codex_session_transcript_scan_budget = {
      ...cached,
      observed_at_ms: observedAtMs,
      reason_codes: [...cached.reason_codes],
      limits: { ...cached.limits }
    };
    return [...cached.paths];
  }

  const sessionsRoot = path.join(codexHome, 'sessions');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sessionsRoot);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const candidates: string[] = [];
  const deadlineAtMs = context.nowMs() + budget.maxWallClockMs;
  const reasonCodes = new Set<string>();
  let filesConsidered = 0;
  let filesParsed = 0;
  let remainingProbeBytes = budget.maxProbeBytes;
  const stack: Array<{ directory: string; depth: number }> = [{ directory: sessionsRoot, depth: 0 }];
  while (
    stack.length > 0 &&
    candidates.length < budget.maxCandidateFiles &&
    filesConsidered < budget.maxDiscoveryFiles
  ) {
    if (context.nowMs() > deadlineAtMs) {
      reasonCodes.add('transcript_discovery_wall_clock_budget_exhausted');
      break;
    }
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = sortCodexSessionDiscoveryEntries(
        fs.readdirSync(current.directory, { withFileTypes: true }),
        runningEntry,
        budget.maxFileAgeMs
      );
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (context.nowMs() > deadlineAtMs) {
        reasonCodes.add('transcript_discovery_wall_clock_budget_exhausted');
        break;
      }
      const entryPath = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < budget.maxDepth) {
          stack.push({ directory: entryPath, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      if (filesConsidered >= budget.maxDiscoveryFiles) {
        reasonCodes.add('transcript_discovery_file_count_budget_exhausted');
        break;
      }
      filesConsidered += 1;
      if (transcriptPathMayMatch(entryPath, runningEntry)) {
        candidates.push(entryPath);
        if (candidates.length >= budget.maxCandidateFiles) {
          reasonCodes.add('transcript_candidate_file_budget_exhausted');
          break;
        }
        continue;
      }
      let fileStat: fs.Stats;
      try {
        fileStat = fs.statSync(entryPath);
      } catch {
        continue;
      }
      if (observedAtMs - fileStat.mtimeMs > budget.maxFileAgeMs) {
        reasonCodes.add('transcript_discovery_age_budget_skipped');
        continue;
      }
      if (!runningEntry.workspace_path && !runningEntry.repo_root) {
        continue;
      }
      if (remainingProbeBytes <= 0) {
        reasonCodes.add('transcript_probe_byte_budget_exhausted');
        continue;
      }
      const probe = transcriptContentMayMatch(context, entryPath, runningEntry, {
        remainingBytes: remainingProbeBytes,
        deadlineAtMs
      });
      remainingProbeBytes = probe.remainingBytes;
      if (probe.bytesRead > 0) {
        filesParsed += 1;
      }
      for (const reason of probe.reasonCodes) {
        reasonCodes.add(reason);
      }
      if (probe.matched) {
        candidates.push(entryPath);
        if (candidates.length >= budget.maxCandidateFiles) {
          reasonCodes.add('transcript_candidate_file_budget_exhausted');
          break;
        }
      }
    }
  }
  if (candidates.length >= budget.maxCandidateFiles) {
    reasonCodes.add('transcript_candidate_file_budget_exhausted');
  }
  if (filesConsidered >= budget.maxDiscoveryFiles && stack.length > 0) {
    reasonCodes.add('transcript_discovery_file_count_budget_exhausted');
  }
  updateTranscriptScanBudget(runningEntry, observedAtMs, {
    candidate_count: candidates.length,
    files_considered: filesConsidered,
    files_parsed: filesParsed,
    bytes_read: budget.maxProbeBytes - remainingProbeBytes,
    exhausted: reasonCodes.size > 0,
    reason_codes: [...reasonCodes].sort(),
    limits: budget
  });
  const scanBudget = runningEntry.codex_session_transcript_scan_budget;
  if (!scanBudget) {
    return candidates;
  }
  runningEntry.codex_session_transcript_candidate_cache = {
    ...scanBudget,
    identity_key: identityKey,
    paths: [...candidates],
    refreshed_at_ms: observedAtMs
  };
  return candidates;
}

function transcriptPathMayMatch(transcriptPath: string, runningEntry: RunningEntry): boolean {
  const normalized = transcriptPath.toLowerCase();
  return [runningEntry.session_id, runningEntry.thread_id, runningEntry.turn_id].some((identifier) =>
    Boolean(identifier && normalized.includes(identifier.toLowerCase()))
  );
}

function sortCodexSessionDiscoveryEntries(
  entries: fs.Dirent[],
  runningEntry: RunningEntry,
  maxFileAgeMs: number
): fs.Dirent[] {
  const activeTranscriptTimeMs = runningEntry.started_at_ms;
  return [...entries].sort((left, right) => {
    const leftTranscript = left.isFile() && left.name.endsWith('.jsonl');
    const rightTranscript = right.isFile() && right.name.endsWith('.jsonl');
    if (leftTranscript !== rightTranscript) {
      return leftTranscript ? -1 : 1;
    }
    if (leftTranscript && rightTranscript) {
      const leftDistance = codexSessionTranscriptFilenameDistanceMs(left.name, activeTranscriptTimeMs, maxFileAgeMs);
      const rightDistance = codexSessionTranscriptFilenameDistanceMs(right.name, activeTranscriptTimeMs, maxFileAgeMs);
      if (leftDistance !== null || rightDistance !== null) {
        if (leftDistance === null) {
          return 1;
        }
        if (rightDistance === null) {
          return -1;
        }
        if (leftDistance !== rightDistance) {
          return leftDistance - rightDistance;
        }
      }
      return right.name.localeCompare(left.name);
    }
    const leftDirectory = left.isDirectory();
    const rightDirectory = right.isDirectory();
    if (leftDirectory !== rightDirectory) {
      return leftDirectory ? -1 : 1;
    }
    if (leftDirectory && rightDirectory) {
      return left.name.localeCompare(right.name);
    }
    return left.name.localeCompare(right.name);
  });
}

function codexSessionTranscriptFilenameDistanceMs(
  filename: string,
  activeTranscriptTimeMs: number,
  maxFileAgeMs: number
): number | null {
  const match = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3})Z)?-/u.exec(filename);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second, millisecond] = match;
  const filenameTimeMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond ?? 0)
  );
  const distanceMs = Math.abs(filenameTimeMs - activeTranscriptTimeMs);
  return distanceMs <= maxFileAgeMs ? distanceMs : null;
}

function transcriptContentMayMatch(
  context: MissingToolOutputCoordinatorContext,
  transcriptPath: string,
  runningEntry: RunningEntry,
  budget: { remainingBytes: number; deadlineAtMs: number }
): { matched: boolean; bytesRead: number; remainingBytes: number; reasonCodes: string[] } {
  const reasonCodes: string[] = [];
  if (budget.remainingBytes <= 0) {
    return { matched: false, bytesRead: 0, remainingBytes: 0, reasonCodes: ['transcript_probe_byte_budget_exhausted'] };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return { matched: false, bytesRead: 0, remainingBytes: budget.remainingBytes, reasonCodes };
  }
  const bytesToRead = Math.min(stat.size, budget.remainingBytes);
  let content = '';
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, buffer.length, 0);
      content = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { matched: false, bytesRead: 0, remainingBytes: budget.remainingBytes, reasonCodes };
  }
  if (bytesToRead < stat.size) {
    reasonCodes.push('transcript_probe_file_byte_budget_exhausted');
  }
  for (const line of content.split(/\r?\n/)) {
    if (context.nowMs() > budget.deadlineAtMs) {
      reasonCodes.push('transcript_discovery_wall_clock_budget_exhausted');
      return { matched: false, bytesRead: bytesToRead, remainingBytes: budget.remainingBytes - bytesToRead, reasonCodes };
    }
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record && transcriptRecordMayMatchRunningEntry(record, runningEntry)) {
      return { matched: true, bytesRead: bytesToRead, remainingBytes: budget.remainingBytes - bytesToRead, reasonCodes };
    }
  }
  return { matched: false, bytesRead: bytesToRead, remainingBytes: budget.remainingBytes - bytesToRead, reasonCodes };
}

function transcriptCandidateIdentityKey(runningEntry: RunningEntry): string {
  return [
    runningEntry.session_id ?? '',
    runningEntry.thread_id ?? '',
    runningEntry.turn_id ?? '',
    runningEntry.workspace_path ?? '',
    runningEntry.repo_root ?? ''
  ].join('|');
}

function updateTranscriptScanBudget(
  runningEntry: RunningEntry,
  observedAtMs: number,
  stats: {
    candidate_count: number;
    files_considered: number;
    files_parsed: number;
    bytes_read: number;
    exhausted: boolean;
    reason_codes: string[];
    limits: MissingToolOutputTranscriptScanBudget;
  }
): void {
  runningEntry.codex_session_transcript_scan_budget = {
    observed_at_ms: observedAtMs,
    candidate_count: stats.candidate_count,
    files_considered: stats.files_considered,
    files_parsed: stats.files_parsed,
    bytes_read: stats.bytes_read,
    exhausted: stats.exhausted,
    reason_codes: [...new Set(stats.reason_codes)].sort(),
    limits: {
      max_candidate_files: stats.limits.maxCandidateFiles,
      max_discovery_files: stats.limits.maxDiscoveryFiles,
      max_probe_bytes: stats.limits.maxProbeBytes,
      max_scan_bytes: stats.limits.maxScanBytes,
      max_file_age_ms: stats.limits.maxFileAgeMs,
      max_wall_clock_ms: stats.limits.maxWallClockMs
    }
  };
}

function transcriptRecordMayMatchRunningEntry(record: Record<string, unknown>, runningEntry: RunningEntry): boolean {
  const payload = asRecord(record.payload);
  const item = readTranscriptResponseItem(record);
  const threadId = readTranscriptString(['thread_id', 'threadId'], record, payload, item);
  const turnId = readTranscriptString(['turn_id', 'turnId'], record, payload, item);
  const sessionId = readTranscriptString(['session_id', 'sessionId'], record, payload, item);
  if (
    (runningEntry.thread_id && threadId === runningEntry.thread_id) ||
    (runningEntry.turn_id && turnId === runningEntry.turn_id) ||
    (runningEntry.session_id && sessionId === runningEntry.session_id)
  ) {
    return true;
  }

  const activePaths = [runningEntry.workspace_path, runningEntry.repo_root]
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));
  if (activePaths.length === 0) {
    return false;
  }
  const transcriptPaths = [
    readTranscriptString(['cwd', 'workspace_path', 'workspacePath', 'repo_root', 'repoRoot'], record),
    readTranscriptString(['cwd', 'workspace_path', 'workspacePath', 'repo_root', 'repoRoot'], payload),
    readTranscriptString(['cwd', 'workspace_path', 'workspacePath', 'repo_root', 'repoRoot'], item)
  ]
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));
  return transcriptPaths.some((candidate) => activePaths.includes(candidate));
}

function readTranscriptResponseItem(record: Record<string, unknown>): Record<string, unknown> {
  const payload = asRecord(record.payload);
  const item =
    asRecord(record.response_item) ??
    asRecord(record.responseItem) ??
    asRecord(record.rawResponseItem) ??
    asRecord(record.raw_response_item) ??
    asRecord(record.item);
  if (item) {
    return item;
  }
  const recordType = readString(record.type);
  if (payload && (recordType === 'response_item' || recordType === 'rawResponseItem' || recordType === 'raw_response_item')) {
    return payload;
  }
  return record;
}

function readTranscriptString(keys: string[], ...records: Array<Record<string, unknown> | null | undefined>): string | undefined {
  for (const record of records) {
    if (!record) {
      continue;
    }
    for (const key of keys) {
      const value = readString(record[key]);
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readToolCallObservationFromTranscriptRecord(
  value: unknown,
  runningEntry: RunningEntry,
  observedAtMs: number
): ToolCallLedgerObservation | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const item = readTranscriptResponseItem(record);
  const type = readString(item.type);
  if (type !== 'function_call' && type !== 'function_call_output') {
    return null;
  }
  const callId = readString(item.call_id) ?? readString(item.callId) ?? readString(item.id);
  if (!callId) {
    return null;
  }
  const payload = asRecord(record.payload);
  const threadId = readTranscriptString(['thread_id', 'threadId'], record, payload, item);
  const turnId = readTranscriptString(['turn_id', 'turnId'], record, payload, item);
  const sessionId = readTranscriptString(['session_id', 'sessionId'], record, payload, item);
  const explicitObservedAtMs = readTimestampMs(record) ?? readTimestampMs(item);
  const observedAt = explicitObservedAtMs ?? observedAtMs;
  const classification = classifyTranscriptToolCallRecord(
    {
      issue_id: readTranscriptString(['issue_id', 'issueId'], record, payload, item),
      issue_identifier: readTranscriptString(['issue_identifier', 'issueIdentifier', 'identifier'], record, payload, item),
      run_id: readTranscriptString(['run_id', 'runId'], record, payload, item),
      issue_run_id: readTranscriptString(['issue_run_id', 'issueRunId'], record, payload, item),
      attempt_id: readTranscriptString(['attempt_id', 'attemptId'], record, payload, item),
      codex_app_server_pid: readTranscriptPid(record, payload, item),
      thread_id: threadId,
      turn_id: turnId,
      session_id: sessionId,
      observed_at_ms: observedAt
    },
    runningEntry
  );

  recordTranscriptToolCallDiagnostic(runningEntry, {
    kind: type,
    call_id: callId,
    tool_name: readString(item.name) ?? readString(item.tool_name) ?? readString(item.toolName) ?? null,
    thread_id: threadId ?? null,
    turn_id: turnId ?? null,
    session_id: sessionId ?? null,
    issue_id: classification.record.issue_id,
    issue_identifier: classification.record.issue_identifier,
    run_id: classification.record.run_id,
    issue_run_id: classification.record.issue_run_id,
    attempt_id: classification.record.attempt_id,
    codex_app_server_pid: classification.record.codex_app_server_pid,
    observed_at_ms: observedAt,
    lineage: classification.lineage,
    reason: classification.reason,
    active_issue_id: runningEntry.issue.id,
    active_issue_identifier: runningEntry.identifier,
    active_run_id: runningEntry.run_id ?? null,
    active_issue_run_id: runningEntry.issue_run_id ?? null,
    active_attempt_id: runningEntry.attempt_id ?? null,
    active_codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
    active_thread_id: runningEntry.thread_id ?? null,
    active_turn_id: runningEntry.turn_id ?? null,
    active_session_id: runningEntry.session_id ?? null
  });

  if (classification.lineage !== 'active_owned') {
    return null;
  }

  return {
    kind: type,
    call_id: callId,
    tool_name: readString(item.name) ?? readString(item.tool_name) ?? readString(item.toolName) ?? null,
    thread_id: threadId ?? runningEntry.thread_id ?? null,
    turn_id: turnId ?? runningEntry.turn_id ?? null,
    session_id: sessionId ?? runningEntry.session_id ?? null,
    observed_at_ms: explicitObservedAtMs ?? observedAtMs,
    last_agent_message: type === 'function_call' ? runningEntry.last_message ?? null : null,
    evidence_source: 'session_transcript'
  };
}

function readTranscriptPid(...records: Array<Record<string, unknown> | null | undefined>): string | null {
  for (const record of records) {
    if (!record) {
      continue;
    }
    for (const key of ['codex_app_server_pid', 'codexAppServerPid', 'app_server_pid', 'appServerPid', 'pid']) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
      }
      const text = readString(value)?.trim();
      if (text) {
        return text;
      }
    }
  }
  return null;
}

function classifyTranscriptToolCallRecord(
  record: {
    issue_id?: string | null;
    issue_identifier?: string | null;
    run_id?: string | null;
    issue_run_id?: string | null;
    attempt_id?: string | null;
    codex_app_server_pid?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    session_id?: string | null;
    observed_at_ms: number;
  },
  runningEntry: RunningEntry
): {
  lineage: TranscriptToolCallLineage;
  reason: string;
  record: {
    issue_id: string | null;
    issue_identifier: string | null;
    run_id: string | null;
    issue_run_id: string | null;
    attempt_id: string | null;
    codex_app_server_pid: string | null;
  };
} {
  const normalized = {
    issue_id: record.issue_id?.trim() || null,
    issue_identifier: record.issue_identifier?.trim() || null,
    run_id: record.run_id?.trim() || null,
    issue_run_id: record.issue_run_id?.trim() || null,
    attempt_id: record.attempt_id?.trim() || null,
    codex_app_server_pid: record.codex_app_server_pid?.trim() || null,
    thread_id: record.thread_id?.trim() || null,
    turn_id: record.turn_id?.trim() || null,
    session_id: record.session_id?.trim() || null
  };
  const active = {
    issue_id: runningEntry.issue.id,
    issue_identifier: runningEntry.identifier,
    run_id: runningEntry.run_id ?? null,
    issue_run_id: runningEntry.issue_run_id ?? null,
    attempt_id: runningEntry.attempt_id ?? null,
    codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
    thread_id: runningEntry.thread_id ?? null,
    turn_id: runningEntry.turn_id ?? null,
    session_id: runningEntry.session_id ?? null
  };
  const identifiers: Array<keyof typeof normalized> = [
    'issue_id',
    'issue_identifier',
    'run_id',
    'issue_run_id',
    'attempt_id',
    'codex_app_server_pid',
    'thread_id',
    'turn_id',
    'session_id'
  ];
  const mismatches = identifiers.filter((key) => Boolean(normalized[key] && active[key] && normalized[key] !== active[key]));
  const matches = identifiers.filter((key) => Boolean(normalized[key] && active[key] && normalized[key] === active[key]));
  const hasPidMatch = matches.includes('codex_app_server_pid');
  const hasThreadMatch = matches.includes('thread_id');
  const hasTurnMatch = matches.includes('turn_id');
  const hasSessionMatch = matches.includes('session_id');
  const hasRunMatch = matches.includes('run_id') || matches.includes('issue_run_id') || matches.includes('attempt_id');
  const isPrior = record.observed_at_ms < runningEntry.started_at_ms;
  const lineageRecord = {
    issue_id: normalized.issue_id,
    issue_identifier: normalized.issue_identifier,
    run_id: normalized.run_id,
    issue_run_id: normalized.issue_run_id,
    attempt_id: normalized.attempt_id,
    codex_app_server_pid: normalized.codex_app_server_pid
  };

  if (mismatches.length > 0) {
    return {
      lineage: isPrior ? 'prior_stale' : 'external_manual',
      reason: `mismatched active lineage: ${mismatches.join(',')}`,
      record: lineageRecord
    };
  }

  const ownsKnownTurn = hasThreadMatch && hasTurnMatch;
  const ownsThreadBeforeTurnKnown = hasThreadMatch && !active.turn_id;
  const ownsSessionBeforeThreadKnown = hasSessionMatch && !active.thread_id && !active.turn_id;
  const ownsRunLineage = hasRunMatch && (hasThreadMatch || hasTurnMatch || hasSessionMatch || hasPidMatch);
  if (hasPidMatch || ownsKnownTurn || ownsThreadBeforeTurnKnown || ownsSessionBeforeThreadKnown || ownsRunLineage) {
    return { lineage: 'active_owned', reason: 'matches active runtime lineage', record: lineageRecord };
  }

  if (isPrior) {
    return { lineage: 'prior_stale', reason: 'transcript record predates active run start', record: lineageRecord };
  }
  if (matches.length > 0) {
    return {
      lineage: 'external_manual',
      reason: `partial active lineage is insufficient for ownership: ${matches.join(',')}`,
      record: lineageRecord
    };
  }
  return { lineage: 'unattributed', reason: 'no active runtime lineage identifiers matched', record: lineageRecord };
}

function recordTranscriptToolCallDiagnostic(runningEntry: RunningEntry, diagnostic: TranscriptToolCallDiagnostic): void {
  const diagnostics = (runningEntry.transcript_tool_call_diagnostics ??= []);
  diagnostics.push(diagnostic);
  if (diagnostics.length > 200) {
    diagnostics.splice(0, diagnostics.length - 200);
  }
}

export async function coordinateRecoverOrBlockMissingToolOutput(
  context: MissingToolOutputCoordinatorContext,
  issueId: string,
  runningEntry: RunningEntry,
  missingToolOutput: OutstandingToolCall,
  observedAtMs: number
): Promise<void> {
  const previousThreadId = missingToolOutput.thread_id ?? runningEntry.thread_id ?? null;
  const previousTurnId = missingToolOutput.turn_id ?? runningEntry.turn_id ?? null;
  const previousSessionId = missingToolOutput.session_id ?? runningEntry.session_id ?? null;
  const elapsedWaitMs = Math.max(0, observedAtMs - missingToolOutput.started_at_ms);
  const recoveryPrompt = buildMissingToolOutputRecoveryPrompt(runningEntry, missingToolOutput, {
    previousThreadId,
    previousTurnId,
    previousSessionId,
    elapsedWaitMs
  });
  const attemptCount = (runningEntry.recovery?.attempt_count ?? 0) + 1;
  const recovery = buildMissingToolOutputRecoveryState(runningEntry, missingToolOutput, {
    observedAtMs,
    previousThreadId,
    previousTurnId,
    previousSessionId,
    elapsedWaitMs,
    attemptCount,
    recoveryPrompt
  });
  const maxRecoveries = Math.max(0, context.config.missing_tool_output_max_recoveries_per_run ?? 1);

  if (attemptCount > maxRecoveries) {
    await blockMissingToolOutput(
      context,
      issueId,
      runningEntry,
      missingToolOutput,
      observedAtMs,
      REASON_CODES.missingToolOutputRecoveryExhausted,
      'automatic missing-tool-output recovery attempt limit exceeded',
      { ...recovery, last_result: 'blocked', last_result_reason_code: REASON_CODES.missingToolOutputRecoveryExhausted }
    );
    return;
  }

  if (!previousThreadId || !previousTurnId) {
    await blockMissingToolOutput(
      context,
      issueId,
      runningEntry,
      missingToolOutput,
      observedAtMs,
      REASON_CODES.missingToolOutputRecoveryStartFailed,
      'missing previous thread or turn id for same-thread guarded recovery',
      { ...recovery, last_result: 'failed', last_result_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed }
    );
    return;
  }

  if (!context.recoverMissingToolOutput) {
    await blockMissingToolOutput(context, issueId, runningEntry, missingToolOutput, observedAtMs);
    return;
  }

  // Mark the termination before interrupting so the generic worker-exit handler defers to this
  // coordinator instead of racing the cancelled worker's exit into a worker_exit_abnormal block.
  runningEntry.termination = {
    state: 'requested',
    reason: REASON_CODES.missingToolOutputRecoveryInterrupted,
    cleanup_workspace: false,
    requested_at_ms: context.nowMs(),
    worker_handle: runningEntry.worker_handle,
    worker_instance_id: runningEntry.worker_instance_id ?? null,
    codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
    worker_process_pid: runningEntry.worker_process_pid ?? null,
    thread_id: runningEntry.thread_id ?? null,
    turn_id: runningEntry.turn_id ?? null,
    session_id: runningEntry.session_id ?? null
  };
  const terminationResult = await context.terminateWorker({
    issue_id: issueId,
    worker_handle: runningEntry.worker_handle,
    cleanup_workspace: false,
    reason: REASON_CODES.missingToolOutputRecoveryInterrupted
  });
  const interruptedRecovery: MissingToolOutputRecoveryState = {
    ...recovery,
    interrupt_cancel_result: {
      status: context.hooks.workerTerminationInterruptStatus(terminationResult),
      reason_code: terminationResult.reason_code,
      detail: terminationResult.detail,
      termination_result: terminationResult
    }
  };
  if (!context.hooks.workerTerminationAllowsRecovery(terminationResult)) {
    await blockMissingToolOutput(
      context,
      issueId,
      runningEntry,
      missingToolOutput,
      observedAtMs,
      REASON_CODES.missingToolOutputRecoveryStartFailed,
      `worker interruption not safely confirmed result=${terminationResult.result} reason_code=${terminationResult.reason_code} detail=${terminationResult.detail ?? 'none'}`,
      {
        ...interruptedRecovery,
        last_result: 'failed',
        last_result_reason_code: terminationResult.reason_code,
        last_result_detail: terminationResult.detail
      },
      { terminate_worker: false }
    );
    return;
  }
  rememberInactiveWorkerPid({
    state: context.state,
    runningEntry,
    reason: REASON_CODES.missingToolOutputRecoveryInterrupted,
    nowMs: context.nowMs(),
    ttlMs: context.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS
  });
  context.hooks.recordRuntimeEvent({
    event: CANONICAL_EVENT.orchestration.missingToolOutputRecoveryInterruptCompleted,
    severity: 'warn',
    issue_identifier: runningEntry.identifier,
    session_id: previousSessionId ?? undefined,
    detail: `thread_id=${previousThreadId} turn_id=${previousTurnId} tool_name=${missingToolOutput.tool_name} call_id=${missingToolOutput.call_id} termination_result=${terminationResult.result} termination_reason_code=${terminationResult.reason_code}`
  });
  interruptedRecovery.interrupt_cancel_result = {
    status: 'succeeded',
    reason_code: terminationResult.reason_code,
    detail: terminationResult.detail ?? `interrupted previous turn ${previousTurnId ?? 'unknown'} on thread ${previousThreadId ?? 'unknown'}`,
    termination_result: terminationResult
  };

  const recovered = await context.recoverMissingToolOutput({
    issue: runningEntry.issue,
    attempt: runningEntry.retry_attempt,
    worker_host: runningEntry.worker_host ?? null,
    previous_thread_id: previousThreadId,
    previous_turn_id: previousTurnId,
    previous_session_id: previousSessionId,
    recovery_prompt: recoveryPrompt
  }).catch((error) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : 'same-thread guarded recovery threw'
  }));

  if (!recovered.ok) {
    await blockMissingToolOutput(
      context,
      issueId,
      runningEntry,
      missingToolOutput,
      observedAtMs,
      REASON_CODES.missingToolOutputRecoveryStartFailed,
      recovered.error,
      { ...interruptedRecovery, last_result: 'failed', last_result_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed }
    );
    return;
  }

  context.hooks.addRuntimeSecondsFromEntry(runningEntry);
  await context.hooks.completeRunRecord(
    runningEntry,
    'cancelled',
    REASON_CODES.missingToolOutputRecoveryInterrupted,
    { ...interruptedRecovery, last_result: 'started' }
  );
  await context.hooks.persistExecutionGraphStateTransition(
    runningEntry,
    'cancelled',
    'cancelled',
    REASON_CODES.missingToolOutputRecoveryInterrupted,
    'stalled turn interrupted for same-thread guarded recovery'
  );

  const recoveryStartedAtMs = context.nowMs();
  context.state.running.set(issueId, {
    ...runningEntry,
    worker_handle: recovered.worker_handle,
    worker_instance_id: recovered.worker_instance_id ?? context.hooks.workerInstanceIdFromHandle(recovered.worker_handle),
    monitor_handle: recovered.monitor_handle,
    worker_host: recovered.worker_host ?? runningEntry.worker_host ?? null,
    workspace_path: recovered.workspace_path ?? runningEntry.workspace_path ?? null,
    provisioner_type: recovered.provisioner_type ?? runningEntry.provisioner_type ?? null,
    branch_name: recovered.branch_name ?? runningEntry.branch_name ?? null,
    repo_root: recovered.repo_root ?? runningEntry.repo_root ?? null,
    workspace_exists: recovered.workspace_exists ?? runningEntry.workspace_exists,
    workspace_git_status: recovered.workspace_git_status ?? runningEntry.workspace_git_status,
    workspace_provisioned: recovered.workspace_provisioned ?? runningEntry.workspace_provisioned,
    workspace_is_git_worktree: recovered.workspace_is_git_worktree ?? runningEntry.workspace_is_git_worktree,
    copy_ignored_applied: recovered.copy_ignored_applied ?? runningEntry.copy_ignored_applied,
    copy_ignored_status: recovered.copy_ignored_status ?? runningEntry.copy_ignored_status,
    copy_ignored_summary: recovered.copy_ignored_summary ?? runningEntry.copy_ignored_summary,
    run_id: runningEntry.run_id,
    attempt_id: runningEntry.attempt_id ?? null,
    codex_app_server_pid: null,
    thread_id: previousThreadId,
    turn_id: previousTurnId,
    session_id: previousSessionId,
    last_event: CANONICAL_EVENT.orchestration.missingToolOutputRecoveryStarted,
    last_event_summary: 'missing tool output recovery started',
    last_message: recovery.prompt_summary,
    recent_events: [
      ...runningEntry.recent_events,
      {
        at_ms: recoveryStartedAtMs,
        event: CANONICAL_EVENT.orchestration.missingToolOutputRecoveryStarted,
        message: recovery.prompt_summary
      }
    ].slice(-20),
    started_at_ms: recoveryStartedAtMs,
    last_codex_timestamp_ms: recoveryStartedAtMs,
    last_progress_transition_at_ms: recoveryStartedAtMs,
    running_waiting_started_at_ms: null,
    stalled_waiting_since_ms: null,
    stalled_waiting_reason: null,
    heartbeat_only_event_emitted: false,
    running_wait_stall_event_emitted: false,
    outstanding_tool_calls: {},
    codex_session_transcript_scan_offsets: {},
    ownership_conflict: null,
    termination: null,
    recovery: { ...interruptedRecovery, last_result: 'started' }
  });

  context.hooks.recordRuntimeEvent({
    event: CANONICAL_EVENT.orchestration.missingToolOutputRecoveryStarted,
    severity: 'warn',
    issue_identifier: runningEntry.identifier,
    session_id: previousSessionId ?? undefined,
    detail: `mode=same_thread_guarded_continuation thread_id=${previousThreadId} previous_turn_id=${previousTurnId} tool_name=${missingToolOutput.tool_name} call_id=${missingToolOutput.call_id} attempt_count=${attemptCount}`
  });
  context.notifyObservers?.();
}

async function blockMissingToolOutput(
  context: MissingToolOutputCoordinatorContext,
  issueId: string,
  runningEntry: RunningEntry,
  missingToolOutput: OutstandingToolCall,
  observedAtMs: number,
  stopReasonCode: string = REASON_CODES.missingToolOutput,
  stopReasonDetailPrefix: string | null = null,
  recovery: MissingToolOutputRecoveryState | null = null,
  options: { terminate_worker?: boolean } = {}
): Promise<void> {
  if (!context.state.running.has(issueId) || context.state.blocked_inputs.has(issueId)) {
    return;
  }

  const { recommendedActions, diagnostic, detail } = buildMissingToolOutputBlockDetails({
    runningEntry,
    missingToolOutput,
    observedAtMs,
    stopReasonCode,
    stopReasonDetailPrefix
  });

  let terminationResult: WorkerTerminationResult | null = null;
  if (options.terminate_worker ?? true) {
    // Mark the termination before killing so the generic worker-exit handler defers to this
    // block instead of racing in a worker_exit_abnormal block with a misleading reason.
    runningEntry.termination ??= {
      state: 'requested',
      reason: stopReasonCode,
      cleanup_workspace: false,
      requested_at_ms: context.nowMs(),
      worker_handle: runningEntry.worker_handle,
      worker_instance_id: runningEntry.worker_instance_id ?? null,
      codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
      worker_process_pid: runningEntry.worker_process_pid ?? null,
      thread_id: runningEntry.thread_id ?? null,
      turn_id: runningEntry.turn_id ?? null,
      session_id: runningEntry.session_id ?? null
    };
    terminationResult = await context.terminateWorker({
      issue_id: issueId,
      worker_handle: runningEntry.worker_handle,
      cleanup_workspace: false,
      reason: stopReasonCode
    });
  }
  const blockDetail = terminationResult ? workerTerminationResultDetail(detail, terminationResult) : detail;

  rememberInactiveWorkerPid({
    state: context.state,
    runningEntry,
    reason: stopReasonCode,
    nowMs: context.nowMs(),
    ttlMs: context.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS
  });
  context.hooks.addRuntimeSecondsFromEntry(runningEntry);
  await context.hooks.completeRunRecord(runningEntry, 'cancelled', stopReasonCode, recovery, blockDetail);
  context.state.running.delete(issueId);

  await context.hooks.scheduleBlockedInput({
    issue_id: issueId,
    issue_identifier: runningEntry.identifier,
    attempt: runningEntry.retry_attempt + 1,
    issue_run_id: runningEntry.issue_run_id ?? null,
    previous_attempt_id: runningEntry.attempt_id ?? null,
    worker_host: runningEntry.worker_host ?? null,
    workspace_path: runningEntry.workspace_path ?? null,
    provisioner_type: runningEntry.provisioner_type ?? null,
    branch_name: runningEntry.branch_name ?? null,
    repo_root: runningEntry.repo_root ?? null,
    workspace_exists: runningEntry.workspace_exists,
    workspace_git_status: runningEntry.workspace_git_status,
    workspace_provisioned: runningEntry.workspace_provisioned,
    workspace_is_git_worktree: runningEntry.workspace_is_git_worktree,
    copy_ignored_applied: runningEntry.copy_ignored_applied,
    copy_ignored_status: runningEntry.copy_ignored_status,
    copy_ignored_summary: runningEntry.copy_ignored_summary,
    stop_reason_code: stopReasonCode,
    stop_reason_detail: blockDetail,
    resolution_hints: recommendedActions,
    required_actions: recommendedActions,
    session_console: runningEntry.recent_events,
    previous_thread_id: diagnostic.thread_id,
    previous_turn_id: diagnostic.turn_id,
    previous_session_id: diagnostic.session_id,
    last_progress_checkpoint_at: runningEntry.last_progress_transition_at_ms ?? runningEntry.started_at_ms,
    tool_output_wait: diagnostic,
    transcript_tool_call_diagnostics: runningEntry.transcript_tool_call_diagnostics,
    recovery
  });

  context.hooks.recordRuntimeEvent({
    event: CANONICAL_EVENT.orchestration.blockedInputScheduled,
    severity: 'warn',
    issue_identifier: runningEntry.identifier,
    session_id: diagnostic.session_id ?? undefined,
    detail: blockDetail
  });
  await context.hooks.persistExecutionGraphStateTransition(runningEntry, 'blocked', 'blocked', stopReasonCode, blockDetail);
  context.notifyObservers?.();
}
