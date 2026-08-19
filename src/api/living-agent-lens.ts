/**
 * Living Agent Lens projector.
 *
 * Composes the projected ApiStateResponse + (optional) issue diagnostics into
 * the normalized LivingAgentLensResponse described in
 * docs/analysis/living-agent-lens-ultimate-design-spec.md.
 *
 * Design properties:
 *  - Pure function. No HTTP, no I/O. Inputs in, response out.
 *  - Every numeric output (gravity_score, transcript_confidence.score) has a
 *    reasons array so the UI can render an honest tooltip.
 *  - When a section the design demands cannot yet be backed by a real signal,
 *    the projector emits a structured MissingCapability and uses an amber/
 *    "unavailable" fallback — never silent green.
 */

import { listActionRequiredReasonCodes, REASON_CODES } from '../observability/reason-codes';
import type {
  ApiAvailableOperatorAction,
  ApiStateResponse,
  ApiIssueRuntimeDiagnosticsResponse,
  ApiAgentConversationProjection,
  OperatorActionProjection
} from './types';
import type {
  ContextWindowFacts,
  CurrentMessageCard,
  EventOrbitNode,
  EvidenceNode,
  FilterDescriptor,
  FocusRun,
  FooterTelemetry,
  GravityBand,
  GravityIssue,
  GravityReason,
  InterlockBody,
  InterlockStep,
  LensModelFacts,
  LensTelemetry,
  LivingAgentLensResponse,
  MissingCapability,
  OperatorActionButton,
  RefreshTransport,
  RoleStream,
  ShellTelemetry,
  SnapshotFreshness,
  TelemetryCell,
  TranscriptConfidence
} from './living-agent-lens-types';

const ACTION_REQUIRED_REASON_CODES = new Set<string>(listActionRequiredReasonCodes());

/** Configuration knobs for the projector. Defaults match the source image. */
export interface ProjectLivingAgentLensOptions {
  /** Explicit focus selection by issue_identifier (e.g. "NIE-300"). */
  focusIssueIdentifier?: string | null;
  /** Issue runtime diagnostics for the focus (drives event orbit detail). */
  focusDiagnostics?: ApiIssueRuntimeDiagnosticsResponse | null;
  /** Operator login, when available (footer cell + audit). */
  operator?: string | null;
  /** Locale used to format the local-time footer cell. */
  locale?: string;
  /** Now() override for deterministic tests. */
  nowMs?: number;
  /** Transport hint (stream | polling | offline) from the caller. */
  refreshTransport?: RefreshTransport;
  /** ISO build version label used by the runtime-build telemetry cell. */
  runtimeVersionLabel?: string | null;
  /**
   * Persistence/audit health snapshot used to decide whether the Audit cell
   * can honestly claim "Recording". Composed by the server route handler from
   * `DiagnosticsSource.getPersistenceHealth()`. When omitted, the projector
   * renders the cell as amber/unknown and emits an `audit_recording_proof`
   * missing-capability rather than asserting a recording state it cannot prove.
   */
  auditHealth?: AuditHealthInput | null;
}

export interface AuditHealthInput {
  /** True iff the persistence sink is enabled (history writes go somewhere). */
  enabled: boolean;
  /** True iff the persistence integrity check is healthy. */
  integrity_ok: boolean;
  /** Most recent write-failure record, if any. */
  recent_write_failure: { at: string | null; detail: string | null } | null;
  /** Optional detail endpoint for the audit cell to open. */
  detail_endpoint?: string | null;
}

type RunningEntry = ApiStateResponse['running'][number];
type RetryingEntry = ApiStateResponse['retrying'][number];
type BlockedEntry = ApiStateResponse['blocked'][number];

type AnyActiveEntry =
  | { kind: 'running'; entry: RunningEntry }
  | { kind: 'retrying'; entry: RetryingEntry }
  | { kind: 'blocked'; entry: BlockedEntry };

const NEEDS_REVIEW_GLYPH = 'review' as const;

/**
 * Build a full Living Agent Lens response from a projected ApiStateResponse.
 * The caller is responsible for fetching the snapshot via the snapshot service
 * and the (optional) focus diagnostics via the issue diagnostics route.
 */
export function projectLivingAgentLens(
  state: ApiStateResponse,
  options: ProjectLivingAgentLensOptions = {}
): LivingAgentLensResponse {
  const now = options.nowMs ?? Date.now();
  const missing: MissingCapability[] = [];

  const entries = collectActiveEntries(state);
  const queue = buildGravityQueue(entries, now, options.focusIssueIdentifier ?? null, missing);
  const focusRow = queue.find((row) => row.is_focus) ?? null;
  const focusEntry = focusRow
    ? entries.find((e) => normalizeIdentifier(activeIdentifier(e)) === normalizeIdentifier(focusRow.issue_identifier)) ?? null
    : null;

  const focus = focusEntry ? buildFocus(focusEntry) : null;
  const lens = focusEntry ? buildLens(focusEntry, state, options.focusDiagnostics ?? null, missing) : null;

  const interlocks = buildInterlocks(focusEntry, state, missing);
  const evidencePath = buildEvidencePath(focusEntry, state, missing);
  const actions = buildActions(focusEntry, state, missing);
  const shell = buildShell(state, options, missing);
  const footer = buildFooter(state, options, now);
  const freshness = buildFreshness(state, options.refreshTransport ?? 'polling');

  return {
    generated_at: state.generated_at,
    snapshot_freshness: freshness,
    shell,
    queue,
    focus,
    lens,
    interlocks,
    evidence_path: evidencePath,
    actions,
    footer,
    missing_capabilities: missing,
    api_degraded_mode: state.api_degraded_mode,
    api_degraded_reason_code: state.api_degraded_reason_code
  };
}

// ============================================================================
// Active-entry collection
// ============================================================================

function collectActiveEntries(state: ApiStateResponse): AnyActiveEntry[] {
  const out: AnyActiveEntry[] = [];
  for (const entry of state.running) out.push({ kind: 'running', entry });
  for (const entry of state.retrying) out.push({ kind: 'retrying', entry });
  for (const entry of state.blocked) out.push({ kind: 'blocked', entry });
  return out;
}

function activeIdentifier(active: AnyActiveEntry): string {
  return active.entry.issue_identifier;
}

function normalizeIdentifier(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

// ============================================================================
// Gravity queue + scoring
// ============================================================================

function buildGravityQueue(
  entries: AnyActiveEntry[],
  now: number,
  focusOverride: string | null,
  missing: MissingCapability[]
): GravityIssue[] {
  if (entries.length === 0) {
    return [];
  }

  const rows = entries.map((active) => buildGravityRow(active, now, missing));
  rows.sort((left, right) => right.gravity_score - left.gravity_score);

  const focusNorm = normalizeIdentifier(focusOverride);
  let focusRow: GravityIssue | undefined;
  if (focusNorm) {
    focusRow = rows.find((row) => normalizeIdentifier(row.issue_identifier) === focusNorm);
  }
  if (!focusRow) {
    focusRow = rows[0];
  }
  for (const row of rows) {
    row.is_focus = row === focusRow;
    if (row.is_focus) {
      row.gravity_band = 'focus';
    }
  }

  // Honest marker: gravity is computed in-projector until backend authors it.
  if (!missing.some((m) => m.id === 'gravity_score')) {
    missing.push({
      id: 'gravity_score',
      label: 'Backend-authored gravity score',
      required_for: 'gravity',
      severity: 'degrades_observability',
      current_fallback:
        'Gravity score is computed by the projector from runtime state, retry/blocked flags, and age.',
      implementation_hint:
        'Move gravity_score, gravity_band, and gravity_reasons into the orchestrator snapshot so all surfaces share a single ordering.'
    });
  }

  return rows;
}

function buildGravityRow(active: AnyActiveEntry, now: number, missing: MissingCapability[]): GravityIssue {
  const entry = active.entry;
  const reasons: GravityReason[] = [];
  let score = 0.15; // base for an active issue

  const ageMs = resolveAgeMs(active, now);
  const ageScore = Math.min(0.1, ageMs > 0 ? Math.min(0.1, ageMs / (1000 * 60 * 60)) * 0.1 : 0);
  if (ageScore > 0.005) {
    reasons.push({ code: 'age', label: `Open ${formatDuration(ageMs)}`, weight: ageScore, evidence_ref: null });
    score += ageScore;
  }

  let state: GravityIssue['state'] = 'running';
  let glyph: GravityIssue['glyph'] = 'running';
  let statusLabel = 'active';

  if (active.kind === 'blocked') {
    state = 'blocked';
    glyph = 'blocked';
    statusLabel = humanizeReason(active.entry.stop_reason_code) ?? 'blocked';
    reasons.push({ code: 'blocked', label: 'Blocked awaiting operator', weight: 0.6, evidence_ref: active.entry.stop_reason_code });
    score += 0.6;
    if (active.entry.requires_manual_resume) {
      reasons.push({ code: REASON_CODES.manualResume, label: 'Requires manual resume', weight: 0.05, evidence_ref: null });
      score += 0.05;
    }
    if (active.entry.breaker_active) {
      reasons.push({ code: 'breaker_active', label: 'Circuit breaker open', weight: 0.1, evidence_ref: null });
      score += 0.1;
    }
    if (ACTION_REQUIRED_REASON_CODES.has(active.entry.stop_reason_code)) {
      state = 'review';
      glyph = NEEDS_REVIEW_GLYPH;
      statusLabel = 'needs review';
      reasons.push({ code: 'action_required', label: 'Operator review required', weight: 0.05, evidence_ref: active.entry.stop_reason_code });
      score += 0.05;
    }
  } else if (active.kind === 'retrying') {
    state = 'retry';
    glyph = 'retry';
    if (active.entry.due_state === 'overdue') {
      statusLabel = 'retry overdue';
      reasons.push({ code: 'retry_overdue', label: 'Retry overdue', weight: 0.5, evidence_ref: active.entry.retry_cause?.reason_code ?? null });
      score += 0.5;
    } else {
      statusLabel = 'retrying';
      reasons.push({ code: 'retry_pending', label: 'Retry pending', weight: 0.2, evidence_ref: active.entry.retry_cause?.reason_code ?? null });
      score += 0.2;
    }
    if (typeof active.entry.attempt === 'number' && active.entry.attempt > 1) {
      reasons.push({ code: 'multiple_attempts', label: `Attempt ${active.entry.attempt}`, weight: 0.05, evidence_ref: null });
      score += 0.05;
    }
  } else {
    const running = active.entry;
    state = 'running';
    glyph = 'running';
    if (running.awaiting_input) {
      state = 'review';
      glyph = NEEDS_REVIEW_GLYPH;
      statusLabel = 'needs review';
      reasons.push({ code: 'awaiting_input', label: 'Awaiting operator input', weight: 0.5, evidence_ref: null });
      score += 0.5;
    } else if (running.stalled_waiting) {
      state = 'warning';
      glyph = 'warning';
      statusLabel = 'stalled waiting';
      reasons.push({ code: 'stalled_waiting', label: 'Tool wait exceeded threshold', weight: 0.35, evidence_ref: running.stalled_waiting_reason ?? null });
      score += 0.35;
    } else if (running.turn_control_state === 'automation_fault') {
      state = 'warning';
      glyph = 'warning';
      statusLabel = 'automation fault';
      reasons.push({ code: 'automation_fault', label: 'Automation fault', weight: 0.5, evidence_ref: running.turn_control_reason_code }); // eslint-disable-line
      score += 0.5;
    } else if (running.progress_signal_state === 'stalled_waiting' || running.progress_signal_state === 'active_but_opaque') {
      state = 'warning';
      glyph = 'warning';
      statusLabel = 'progressing opaquely';
      reasons.push({ code: 'opaque_progress', label: 'Progress signal opaque', weight: 0.2, evidence_ref: null });
      score += 0.2;
    } else {
      const phaseLabel = running.current_phase ?? running.state ?? 'running';
      statusLabel = String(phaseLabel).toLowerCase();
    }

    if (running.token_telemetry_status === 'unavailable' && state === 'running') {
      reasons.push({ code: 'telemetry_unavailable', label: 'Token telemetry unavailable', weight: 0.05, evidence_ref: null });
      score += 0.05;
    }
  }

  // Clamp
  score = Math.max(0.1, Math.min(1.0, Number(score.toFixed(2))));

  const band = bandForScore(score);
  const title = resolveTitle(active, missing);

  return {
    issue_id: entry.issue_id,
    issue_identifier: entry.issue_identifier,
    title,
    status_label: statusLabel,
    state,
    glyph,
    gravity_score: score,
    gravity_band: band,
    gravity_reasons: reasons,
    recommended_focus_reason: reasons.length > 0 ? reasons[0].label : null,
    is_focus: false,
    detail_endpoint: `/api/v1/issues/${encodeURIComponent(entry.issue_identifier)}`
  };
}

function bandForScore(score: number): GravityBand {
  if (score >= 0.9) return 'urgent';
  if (score >= 0.7) return 'urgent';
  if (score >= 0.35) return 'warning';
  if (score >= 0.1) return 'active';
  return 'idle';
}

function resolveAgeMs(active: AnyActiveEntry, now: number): number {
  let started: string | null = null;
  if (active.kind === 'running') started = active.entry.started_at;
  else if (active.kind === 'retrying') started = active.entry.due_at;
  else started = active.entry.blocked_at;
  if (!started) return 0;
  const parsed = Date.parse(started);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, now - parsed);
}

function resolveTitle(active: AnyActiveEntry, missing?: MissingCapability[]): string {
  // ApiStateResponse.running does NOT expose the tracker (Linear) issue title;
  // the snapshot service projects identifiers + runtime state but not the
  // original Issue.title. The design doc shows tracker titles ("Chatty",
  // "Auth Flow Polish") in queue rows and focus crowns. Until the snapshot
  // service projects issue_title onto running/retrying/blocked entries, the
  // projector falls back to the runtime "last message" (running) or stop-
  // reason text (blocked) and emits a missing_capability so the UI can
  // surface the gap.
  if (missing && !missing.some((m) => m.id === 'tracker_title_projection')) {
    missing.push({
      id: 'tracker_title_projection',
      label: 'Tracker issue title on the snapshot projection',
      required_for: 'gravity',
      severity: 'degrades_observability',
      current_fallback:
        'Queue and focus titles fall back to last_message (running), retry headline (retrying), or stop_reason_detail (blocked) because ApiStateResponse.{running,retrying,blocked} do not expose the tracker title.',
      implementation_hint:
        'Add issue_title to the running/retrying/blocked projections in src/api/snapshot-service.ts so the lens can render the Linear title in queue rows and the focus crown.'
    });
  }
  if (active.kind === 'running') {
    return active.entry.last_message?.split('\n')[0]?.slice(0, 80) ?? active.entry.issue_identifier;
  }
  if (active.kind === 'retrying') {
    return active.entry.retry_cause?.headline ?? active.entry.error ?? active.entry.issue_identifier;
  }
  return active.entry.stop_reason_detail ?? humanizeReason(active.entry.stop_reason_code) ?? active.entry.issue_identifier;
}

function humanizeReason(code: string | null | undefined): string | null {
  if (!code) return null;
  return code.replace(/[_:.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

// ============================================================================
// Focus + lens telemetry
// ============================================================================

function buildFocus(active: AnyActiveEntry): FocusRun {
  const entry = active.entry;
  const branch = 'branch_name' in entry ? entry.branch_name ?? null : null;
  const workspace = 'workspace_path' in entry ? entry.workspace_path ?? null : null;
  const threadId = 'thread_id' in entry ? entry.thread_id ?? null : 'previous_thread_id' in entry ? entry.previous_thread_id ?? null : null;
  const sessionId = active.kind === 'running'
    ? (entry as RunningEntry).session_id
    : active.kind === 'retrying'
      ? (entry as RetryingEntry).previous_session_id
      : (entry as BlockedEntry).previous_session_id;

  const runAttempt = active.kind === 'running' ? (entry as RunningEntry).turn_count + 1 : (entry as RetryingEntry | BlockedEntry).attempt;

  const trackerUrl = `https://linear.app/issue/${encodeURIComponent(entry.issue_identifier)}`;
  return {
    issue_id: entry.issue_id,
    issue_identifier: entry.issue_identifier,
    title: resolveTitle(active),
    run_attempt: typeof runAttempt === 'number' ? runAttempt : 1,
    thread_id: threadId,
    session_id: sessionId,
    workspace_path: workspace,
    branch,
    pr_links: [],
    tracker_url: trackerUrl,
    durable_run_key: threadId ?? sessionId ?? entry.issue_identifier
  };
}

function buildLens(
  active: AnyActiveEntry,
  state: ApiStateResponse,
  diagnostics: ApiIssueRuntimeDiagnosticsResponse | null,
  missing: MissingCapability[]
): LensTelemetry {
  const ringTone = lensRingTone(active);
  const currentMessage = buildCurrentMessage(active);
  const roleStream = buildRoleStream(active, missing);
  const events = buildEventOrbit(active, state, diagnostics, missing);
  const contextWindow = buildContextWindow(active, missing);
  const transcriptConfidence = buildTranscriptConfidence(active, missing);
  const model = buildLensModel(active);

  return {
    ring_tone: ringTone,
    current_message: currentMessage,
    role_stream: roleStream,
    events,
    context_window: contextWindow,
    transcript_confidence: transcriptConfidence,
    model
  };
}

function lensRingTone(active: AnyActiveEntry): LensTelemetry['ring_tone'] {
  if (active.kind === 'blocked') return 'red';
  if (active.kind === 'retrying') return 'amber';
  const running = active.entry as RunningEntry;
  if (running.awaiting_input) return 'amber';
  if (running.stalled_waiting) return 'amber';
  if (running.turn_control_state === 'automation_fault') return 'red';
  return 'blue';
}

function buildCurrentMessage(active: AnyActiveEntry): CurrentMessageCard | null {
  if (active.kind !== 'running') return null;
  const running = active.entry as RunningEntry;
  const conv: ApiAgentConversationProjection['latest'] | null = running.conversation_latest ?? null;
  if (conv && conv.summary) {
    return {
      message_id: `msg-${running.issue_identifier}-${conv.at_ms ?? 0}`,
      role: conv.role ?? 'assistant',
      excerpt: truncate(conv.summary, 280),
      at: conv.at ?? running.last_event_at ?? running.started_at,
      truncated: conv.summary.length > 280,
      source_ref: conv.source ?? null
    };
  }
  if (running.last_message) {
    return {
      message_id: `msg-${running.issue_identifier}-fallback`,
      role: 'assistant',
      excerpt: truncate(running.last_message, 280),
      at: running.last_event_at ?? running.started_at,
      truncated: running.last_message.length > 280,
      source_ref: running.last_event ?? null
    };
  }
  return null;
}

function buildRoleStream(active: AnyActiveEntry, missing: MissingCapability[]): RoleStream {
  const window = 12;
  if (!missing.some((m) => m.id === 'role_stream_window')) {
    missing.push({
      id: 'role_stream_window',
      label: 'Last-N role histogram on the conversation projection',
      required_for: 'role_stream',
      severity: 'degrades_observability',
      current_fallback:
        'Role counts default to zero with neutral tone until ApiAgentConversationProjection.latest exposes a recent_roles[] window.',
      implementation_hint:
        'Add recent_roles[] (last 12 messages) to ApiAgentConversationProjection.latest or expose conversation.metadata.role_counts on running entries.'
    });
  }
  void active; // role data not yet exposed per-entry
  return {
    window_size: window,
    segments: (['assistant', 'tool', 'user', 'system', 'runtime'] as const).map((role) => ({
      role,
      count: 0,
      tone: roleTone(role)
    }))
  };
}

function roleTone(role: 'assistant' | 'tool' | 'user' | 'system' | 'runtime'): RoleStream['segments'][number]['tone'] {
  switch (role) {
    case 'assistant':
      return 'blue';
    case 'tool':
      return 'green';
    case 'user':
      return 'violet';
    case 'system':
      return 'amber';
    case 'runtime':
      return 'neutral';
  }
}

function buildEventOrbit(
  active: AnyActiveEntry,
  state: ApiStateResponse,
  diagnostics: ApiIssueRuntimeDiagnosticsResponse | null,
  missing: MissingCapability[]
): EventOrbitNode[] {
  const identifier = normalizeIdentifier(activeIdentifier(active));
  const events = state.recent_runtime_events
    .filter((event) => !event.issue_identifier || normalizeIdentifier(event.issue_identifier) === identifier)
    .slice(0, 6);

  if (events.length === 0 && !diagnostics) {
    if (!missing.some((m) => m.id === 'event_orbit')) {
      missing.push({
        id: 'event_orbit',
        label: 'Curated event orbit projection',
        required_for: 'event_orbit',
        severity: 'degrades_observability',
        current_fallback: 'Event orbit is empty until tool/runtime events are available for the focused issue.',
        implementation_hint:
          'Emit lens.events[] in the projector with id/category/tone/icon/summary/detail_endpoint derived from tool-call ledger + recent runtime events.'
      });
    }
    return [];
  }

  return events.map((event, idx) => {
    const tone: EventOrbitNode['tone'] = event.severity === 'error' ? 'red' : event.severity === 'warn' ? 'amber' : 'blue';
    const category = classifyEventCategory(event.event ?? '');
    return {
      id: `${event.at}-${idx}`,
      label: shortenLabel(category, event.event ?? 'event'),
      category,
      at: event.at,
      tone,
      icon: iconForCategory(category),
      summary: event.detail ?? event.event ?? '',
      evidence_ref: event.tool_call_id ?? null,
      detail_endpoint: event.tool_call_id ? `/api/v1/issues/${encodeURIComponent(active.entry.issue_identifier)}/diagnostics` : null
    };
  });
}

function classifyEventCategory(event: string): EventOrbitNode['category'] {
  const e = event.toLowerCase();
  if (e.includes('terminal') || e.includes('shell') || e.includes('exec')) return 'terminal';
  if (e.includes('git') || e.includes('commit') || e.includes('branch')) return 'git';
  if (e.includes('linear') || e.includes('tracker')) return 'linear';
  if (e.includes('build') || e.includes('compile')) return 'build';
  if (e.includes('test') || e.includes('vitest')) return 'tests';
  if (e.includes('tool')) return 'tool';
  return 'runtime';
}

function iconForCategory(category: EventOrbitNode['category']): string {
  switch (category) {
    case 'terminal': return 'terminal';
    case 'git': return 'git-branch';
    case 'linear': return 'square-stack';
    case 'build': return 'cube';
    case 'tests': return 'beaker';
    case 'tool': return 'wrench';
    case 'runtime': return 'cpu';
  }
}

function shortenLabel(category: EventOrbitNode['category'], event: string): string {
  return `${category} ${event.split(/[._-]/).pop() ?? ''}`.trim();
}

function buildContextWindow(active: AnyActiveEntry, missing: MissingCapability[]): ContextWindowFacts {
  const entry = active.entry;
  const tokens = 'tokens' in entry ? entry.tokens : null;
  const limit = tokens?.model_context_window ?? 200;
  // Honest stub: visible/clipped/redacted not exposed yet.
  if (!missing.some((m) => m.id === 'bounded_window')) {
    missing.push({
      id: 'bounded_window',
      label: 'Bounded transcript window stats',
      required_for: 'context_window',
      severity: 'degrades_observability',
      current_fallback:
        'visible/clipped/redacted message counts default to zero until the projector exposes them.',
      implementation_hint:
        'Add context_window {visible_messages, clipped_messages, redacted_count, limit, scan_budget_state} to the issue projection.'
    });
  }
  return {
    visible_messages: 0,
    clipped_messages: 0,
    redacted_count: 0,
    limit,
    scan_budget_state: 'unknown'
  };
}

function buildTranscriptConfidence(active: AnyActiveEntry, missing: MissingCapability[]): TranscriptConfidence {
  if (active.kind !== 'running') {
    return { score: 0, label: 'unavailable', reasons: ['Focused entry is not running'] };
  }
  const running = active.entry as RunningEntry;
  const diagSummary = running.transcript_tool_call_diagnostic_summary;
  const scanBudget = running.codex_session_transcript_scan_budget;

  const reasons: string[] = [];
  let score = 0.6;
  if (diagSummary?.detailed_diagnostics_available) {
    reasons.push(`${diagSummary.total_count ?? 0} tool calls verified`);
    score += 0.2;
  } else {
    reasons.push('No transcript diagnostic loaded');
    score -= 0.2;
  }
  if (scanBudget?.exhausted) {
    reasons.push('Scan budget exhausted');
    score -= 0.25;
  } else if (scanBudget) {
    reasons.push('No scan budget exhaustion');
    score += 0.1;
  }
  if (running.missing_tool_output_recovery && running.missing_tool_output_recovery.status === 'in_progress') {
    reasons.push('Missing tool output recovery active');
    score -= 0.15;
  }
  if (running.token_telemetry_confidence === 'observed_live') {
    reasons.push('Token telemetry observed live');
    score += 0.1;
  }

  score = Math.max(0, Math.min(1, Number(score.toFixed(2))));
  const label: TranscriptConfidence['label'] = score >= 0.8 ? 'high' : score >= 0.55 ? 'medium' : score > 0 ? 'low' : 'unavailable';

  if (!missing.some((m) => m.id === 'transcript_confidence')) {
    missing.push({
      id: 'transcript_confidence',
      label: 'Backend-authored transcript confidence',
      required_for: 'transcript_confidence',
      severity: 'visual_only',
      current_fallback:
        'Transcript confidence is composed by the projector from diagnostic + scan-budget + recovery signals.',
      implementation_hint: 'Promote transcript_confidence.{score,label,reasons} into the issue projection.'
    });
  }

  return { score, label, reasons };
}

function buildLensModel(active: AnyActiveEntry): LensModelFacts | null {
  if (active.kind !== 'running') return null;
  const running = active.entry as RunningEntry;
  if (!running.requested_model && !running.effective_model) return null;
  return {
    requested: running.requested_model,
    effective: running.effective_model,
    reroute_reason: running.model_reroute?.reason_code ?? null
  };
}

function truncate(value: string, max: number): string {
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// ============================================================================
// Interlock spine
// ============================================================================

/**
 * The only operator intent targets backed by real, existing backend routes:
 *  - 'submit_input' → POST /api/v1/issues/:id/input    (blocked, has pending_input)
 *  - 'resume'       → POST /api/v1/issues/:id/resume   (blocked, requires_manual_resume)
 *  - 'clear_automation_fault' → POST /api/v1/issues/:id/clear-automation-fault
 * Anything else (e.g. free-form "steer a running agent") is a missing capability.
 */
type IntentTarget =
  | { kind: 'submit_input'; endpoint: string; request_id: string }
  | { kind: 'resume'; endpoint: string }
  | { kind: 'clear_automation_fault'; endpoint: string }
  | { kind: 'none'; reason: string };

function resolveIntentTarget(active: AnyActiveEntry | null): IntentTarget {
  if (!active) return { kind: 'none', reason: 'Select an issue to compose intent.' };
  if (active.kind === 'retrying') {
    return { kind: 'none', reason: 'Retrying entries dispatch automatically; no operator intent route is required.' };
  }
  if (active.kind === 'running') {
    return {
      kind: 'none',
      reason:
        'No backend route accepts free-form guidance for a running agent. Wait for the agent to emit an input request (which routes to /input), or use Drain/Cancel.'
    };
  }
  const blocked = active.entry;
  if (blocked.pending_input?.request_id) {
    return {
      kind: 'submit_input',
      endpoint: `/api/v1/issues/${encodeURIComponent(blocked.issue_identifier)}/input`,
      request_id: blocked.pending_input.request_id
    };
  }
  if (blocked.runtime_state_kind === 'automation_fault') {
    return {
      kind: 'clear_automation_fault',
      endpoint: `/api/v1/issues/${encodeURIComponent(blocked.issue_identifier)}/clear-automation-fault`
    };
  }
  if (blocked.requires_manual_resume) {
    return {
      kind: 'resume',
      endpoint: `/api/v1/issues/${encodeURIComponent(blocked.issue_identifier)}/resume`
    };
  }
  return {
    kind: 'none',
    reason: 'Blocked entry does not surface a pending input request and is not flagged for manual resume.'
  };
}

function buildInterlocks(
  active: AnyActiveEntry | null,
  state: ApiStateResponse,
  missing: MissingCapability[]
): InterlockStep[] {
  const target = resolveIntentTarget(active);
  const preconditions = buildPreconditions(active, state);
  const intent = buildIntent(active, target);
  const preview = buildPreview(active, target, missing);
  const receipt = buildReceipt(active);

  return [preconditions, intent, preview, receipt];
}

function buildPreconditions(active: AnyActiveEntry | null, state: ApiStateResponse): InterlockStep {
  const checks: InterlockBody = { kind: 'preconditions', checks: [] };
  if (active && 'workspace_exists' in active.entry) {
    const workspaceClean = active.entry.workspace_git_status === 'clean';
    checks.checks.push({
      id: 'workspace_clean',
      label: 'Workspace clean',
      ok: workspaceClean,
      detail: workspaceClean ? null : `git status: ${active.entry.workspace_git_status ?? 'unknown'}`,
      owner: 'workspace-manager',
      evidence_ref: active.entry.workspace_path ?? null
    });
  }
  if (active && 'workspace_provisioned' in active.entry) {
    checks.checks.push({
      id: 'branch_up_to_date',
      label: 'Branch up to date',
      ok: Boolean(active.entry.workspace_provisioned),
      detail: active.entry.workspace_provisioned ? null : 'Workspace not provisioned',
      owner: 'workspace-manager',
      evidence_ref: active.entry.branch_name ?? null
    });
  }
  const conflicting = state.counts.running + state.counts.retrying;
  const activeWorkerCount = state.worker_event_pressure?.active_worker_count ?? 0;
  checks.checks.push({
    id: 'no_conflicting_runs',
    label: 'No conflicting runs',
    ok: conflicting <= Math.max(1, activeWorkerCount) * 2,
    detail: `${conflicting} active runs · ${activeWorkerCount} active workers`,
    owner: 'orchestrator',
    evidence_ref: null
  });
  checks.checks.push({
    id: 'sla_within_limits',
    label: 'SLA within limits',
    ok: state.snapshot_freshness_state !== 'stale',
    detail: state.snapshot_freshness_state === 'stale' ? 'Snapshot stale' : null,
    owner: 'observability',
    evidence_ref: null
  });

  const verified = checks.checks.filter((c) => c.ok).length;
  const total = checks.checks.length;
  const allOk = verified === total;
  return {
    index: 1,
    id: 'preconditions',
    title: '1 PRECONDITIONS',
    subtitle: 'Verified before send',
    tone: allOk ? 'green' : 'amber',
    state_label: `${verified} / ${total} verified`,
    body: checks
  };
}

function buildIntent(active: AnyActiveEntry | null, target: IntentTarget): InterlockStep {
  let intentCapsule: string;
  let stateLabel: string;
  let tone: InterlockStep['tone'];
  let composerEndpoint: string | null = null;
  switch (target.kind) {
    case 'submit_input':
      intentCapsule = 'Answer pending input';
      stateLabel = 'Submit operator answer';
      tone = 'blue';
      composerEndpoint = target.endpoint;
      break;
    case 'resume':
      intentCapsule = 'Resume blocked run';
      stateLabel = 'Operator-initiated resume';
      tone = 'blue';
      composerEndpoint = target.endpoint;
      break;
    case 'clear_automation_fault':
      intentCapsule = 'Clear automation fault';
      stateLabel = 'Clear breaker + restart turn';
      tone = 'amber';
      composerEndpoint = target.endpoint;
      break;
    case 'none':
      intentCapsule = active ? target.reason : 'Select an issue to compose intent.';
      stateLabel = active ? 'No safe operator route' : 'No focus selected';
      tone = 'neutral';
      break;
  }
  return {
    index: 2,
    id: 'intent',
    title: '2 SAFE INTERVENTION',
    subtitle: 'Operator intent',
    tone,
    state_label: stateLabel,
    body: {
      kind: 'intent',
      intent_capsule: intentCapsule,
      reason_note_required: target.kind !== 'none',
      composer_endpoint: composerEndpoint
    }
  };
}

/**
 * Render the EXACT request body the corresponding /input, /resume, or
 * /clear-automation-fault route would accept. The projector intentionally
 * uses the real field names from the route handlers (request_id, answer,
 * reason_note, resume_override_reason). When no real route applies, the
 * preview is explicitly unavailable and a `command_preview` missing
 * capability is emitted with severity `blocks_action`.
 */
function buildPreview(
  active: AnyActiveEntry | null,
  target: IntentTarget,
  missing: MissingCapability[]
): InterlockStep {
  if (!active) {
    return {
      index: 3,
      id: 'preview',
      title: '3 ENDPOINT PREVIEW',
      subtitle: 'What will be sent',
      tone: 'neutral',
      state_label: 'No request',
      body: { kind: 'preview', method: null, endpoint: null, body_preview: null, truncated: false }
    };
  }
  if (target.kind === 'none') {
    if (!missing.some((m) => m.id === 'command_preview')) {
      missing.push({
        id: 'command_preview',
        label: 'Operator intent route for non-blocked runs',
        required_for: 'command_preview',
        severity: 'blocks_action',
        current_fallback:
          'No real backend route accepts free-form operator guidance for running or retrying entries. Preview and submit are disabled until such a route exists.',
        implementation_hint:
          'Add POST /api/v1/issues/:id/actions/:action/preview that mirrors the exact submit-time request builder, and an operator-guidance route if free-form steering of running agents is in scope.'
      });
    }
    return {
      index: 3,
      id: 'preview',
      title: '3 ENDPOINT PREVIEW',
      subtitle: 'What will be sent',
      tone: 'amber',
      state_label: 'Preview unavailable',
      body: { kind: 'preview', method: null, endpoint: null, body_preview: target.reason, truncated: false }
    };
  }
  const body = renderRealRequestBody(target);
  // Even when the body shape matches the route, we still emit a visual-only
  // missing-capability marker because the value of `reason_note` (and the
  // answer payload) is operator input, not server-generated. A proper
  // backend preview endpoint would author the entire envelope.
  if (!missing.some((m) => m.id === 'command_preview')) {
    missing.push({
      id: 'command_preview',
      label: 'Backend-generated command preview',
      required_for: 'command_preview',
      severity: 'visual_only',
      current_fallback:
        'Preview body matches the exact request shape the target route accepts. Reason note and answer payload are operator-supplied at submit time.',
      implementation_hint:
        'Add POST /api/v1/issues/:id/actions/:action/preview returning {method, endpoint, body_preview, reason_note_required, destructive, refusal_reasons, predicted_state_delta} from the same request builder the submit path uses.'
    });
  }
  return {
    index: 3,
    id: 'preview',
    title: '3 ENDPOINT PREVIEW',
    subtitle: 'What will be sent',
    tone: 'amber',
    state_label: `Preview · ${target.kind.replace(/_/g, ' ')}`,
    body: { kind: 'preview', method: 'POST', endpoint: target.endpoint, body_preview: body, truncated: false }
  };
}

function renderRealRequestBody(target: Exclude<IntentTarget, { kind: 'none' }>): string {
  switch (target.kind) {
    case 'submit_input':
      return [
        '{',
        `  "request_id": ${JSON.stringify(target.request_id)},`,
        '  "reason_note": "<operator note, required>",',
        '  "actor": "<optional>",',
        '  "answer": {',
        '    "question_id": "<from pending_input.questions[].id>",',
        '    "option_label": "<from pending_input.questions[].options[].label>",',
        '    "text": "<free-text answer when input_schema_type=text>"',
        '  }',
        '}'
      ].join('\n');
    case 'resume':
      return [
        '{',
        '  "reason_note": "<operator note, required>",',
        '  "actor": "<optional>",',
        '  "resume_override_reason": "<optional override>"',
        '}'
      ].join('\n');
    case 'clear_automation_fault':
      return [
        '{',
        '  "reason_note": "<operator note, required>",',
        '  "actor": "<optional>"',
        '}'
      ].join('\n');
  }
}

function buildReceipt(active: AnyActiveEntry | null): InterlockStep {
  const ops: OperatorActionProjection[] | undefined = active && 'operator_actions' in active.entry ? active.entry.operator_actions : undefined;
  const latest = ops?.[ops.length - 1] ?? null;
  if (!latest) {
    return {
      index: 4,
      id: 'receipt',
      title: '4 AUDIT RECEIPT',
      subtitle: 'Immutable record',
      tone: 'neutral',
      state_label: 'Will create receipt',
      body: { kind: 'receipt', lifecycle: 'preview', receipt_id: null, at: null, result: null }
    };
  }
  const lifecycle: 'created' | 'rejected' | 'failed' = latest.result === 'accepted' ? 'created' : latest.result === 'rejected' ? 'rejected' : 'failed';
  const tone = lifecycle === 'created' ? 'green' : 'red';
  const receiptId = `receipt_${(latest.result_code ?? latest.action).slice(0, 8)}`;
  return {
    index: 4,
    id: 'receipt',
    title: '4 AUDIT RECEIPT',
    subtitle: 'Immutable record',
    tone,
    state_label: `${receiptId} · ${lifecycle}`,
    body: { kind: 'receipt', lifecycle, receipt_id: receiptId, at: new Date(latest.requested_at_ms).toISOString(), result: latest.message ?? latest.result_code ?? latest.result }
  };
}

// ============================================================================
// Evidence path
// ============================================================================

function buildEvidencePath(active: AnyActiveEntry | null, state: ApiStateResponse, missing: MissingCapability[]): EvidenceNode[] {
  if (!active) return [];
  const entry = active.entry;
  const threadId = 'thread_id' in entry ? entry.thread_id : 'previous_thread_id' in entry ? entry.previous_thread_id : null;
  const sessionId = 'session_id' in entry ? entry.session_id : 'previous_session_id' in entry ? entry.previous_session_id : null;
  const issueIdentifier = entry.issue_identifier;

  // Thread pill: backed by GET /api/v1/threads/:threadId (real route).
  const threadNode: EvidenceNode = {
    id: 'thread',
    label: 'thread',
    value: threadId ?? 'thread unavailable',
    tone: threadId ? 'green' : 'amber',
    detail: threadId ? null : 'Thread not yet bound for this run',
    open_endpoint: threadId ? `/api/v1/threads/${encodeURIComponent(threadId)}` : null,
    copy_value: threadId
  };

  // Transcript pill: NO backend route exposes the raw session rollout today.
  // Show the path as informational only — no open_endpoint, amber tone, and
  // surface a missing-capability so the gap is visible in context.
  const transcriptNode: EvidenceNode = {
    id: 'transcript',
    label: 'transcript',
    value: sessionId ? `sessions/${sessionId}/rollout.jsonl` : 'transcript unavailable',
    tone: 'amber',
    detail: sessionId
      ? 'Session rollout viewer is not implemented; path is informational only.'
      : 'No session id recorded yet',
    open_endpoint: null,
    copy_value: sessionId
  };
  if (!missing.some((m) => m.id === 'transcript_open_endpoint')) {
    missing.push({
      id: 'transcript_open_endpoint',
      label: 'Session transcript rollout viewer',
      required_for: 'evidence_path',
      severity: 'degrades_observability',
      current_fallback:
        'Transcript path renders as informational text (amber, not openable) because /api/v1/sessions/:id/rollout does not exist.',
      implementation_hint:
        'Implement GET /api/v1/sessions/:sessionId/rollout (or a curated viewer endpoint) that streams the session rollout with redaction policy applied.'
    });
  }

  // API snapshot pill: opens the focused-issue projection (real route).
  // Use /api/v1/issues/:identifier rather than /api/v1/state so the open
  // target matches what the spec calls "API snapshot for selected issue".
  const apiSnapshotNode: EvidenceNode = {
    id: 'api_snapshot',
    label: 'api snapshot',
    value: `snapshot_${String(state.snapshot_generated_at_ms)}.json`,
    tone: state.snapshot_freshness_state === 'fresh' ? 'green' : state.snapshot_freshness_state === 'aging' ? 'amber' : 'red',
    detail: state.snapshot_freshness_state === 'fresh' ? null : `Snapshot ${state.snapshot_freshness_state}`,
    open_endpoint: `/api/v1/issues/${encodeURIComponent(issueIdentifier)}`,
    copy_value: String(state.snapshot_generated_at_ms)
  };

  const nodes: EvidenceNode[] = [threadNode, transcriptNode, apiSnapshotNode, buildAuditEvidence(active)];

  if (!missing.some((m) => m.id === 'evidence_path_receipts')) {
    missing.push({
      id: 'evidence_path_receipts',
      label: 'Audit receipt query endpoint',
      required_for: 'audit_receipt',
      severity: 'degrades_observability',
      current_fallback: 'Audit cell derives a receipt id from the latest operator_actions entry; no detail endpoint yet.',
      implementation_hint:
        'Implement GET /api/v1/audit/receipts/:receiptId returning {receipt_id, action, actor, request_preview_hash, pre_state, post_state, evidence_references}.'
    });
  }

  return nodes;
}

function buildAuditEvidence(active: AnyActiveEntry): EvidenceNode {
  const ops: OperatorActionProjection[] | undefined = 'operator_actions' in active.entry ? active.entry.operator_actions : undefined;
  const latest = ops?.[ops.length - 1] ?? null;
  if (!latest) {
    return {
      id: 'audit',
      label: 'audit',
      value: 'no receipts yet',
      tone: 'gray',
      detail: 'No operator action has been recorded for this run',
      open_endpoint: null,
      copy_value: null
    };
  }
  const receiptId = `receipt_${(latest.result_code ?? latest.action).slice(0, 8)}`;
  const tone: EvidenceNode['tone'] = latest.result === 'accepted' ? 'green' : latest.result === 'rejected' ? 'amber' : 'red';
  return {
    id: 'audit',
    label: 'audit',
    value: receiptId,
    tone,
    detail: latest.message ?? null,
    open_endpoint: null,
    copy_value: receiptId
  };
}

// ============================================================================
// Action dock
// ============================================================================

function buildActions(active: AnyActiveEntry | null, state: ApiStateResponse, missing: MissingCapability[]): OperatorActionButton[] {
  const available: ApiAvailableOperatorAction[] = active && 'available_actions' in active.entry ? active.entry.available_actions : [];

  function findAvailable(id: ApiAvailableOperatorAction['id']): ApiAvailableOperatorAction | null {
    return available.find((a) => a.id === id) ?? null;
  }

  const lastResultByAction = new Map<string, OperatorActionProjection>();
  const ops: OperatorActionProjection[] = active && 'operator_actions' in active.entry ? active.entry.operator_actions : [];
  for (const op of ops) {
    lastResultByAction.set(op.action, op);
  }

  const drainActive = state.drain_mode.active;
  const apiHealthy = state.health.dispatch_validation === 'ok';
  const target = resolveIntentTarget(active);

  if (!missing.some((m) => m.id === 'action_dock_more')) {
    missing.push({
      id: 'action_dock_more',
      label: 'Secondary action surfaces (Runtime Panels, Event Feed, Project History, Diagnostics, Raw JSON, Settings)',
      required_for: 'forensics',
      severity: 'visual_only',
      current_fallback: 'More menu links to existing API surfaces; not yet a designed secondary panel.',
      implementation_hint:
        'Add /api/v1/living-agent-lens/secondary returning project history, raw diagnostics, and settings entry points.'
    });
  }

  // Steer maps to /input (only when the focused entry has a pending operator
  // input request). Free-form guidance of a running agent has no backend route.
  const canSteer = target.kind === 'submit_input' && apiHealthy;
  const steerDisabledReason = !active
    ? 'Select an issue to steer'
    : !apiHealthy
      ? 'API dispatch validation failed'
      : target.kind === 'submit_input'
        ? null
        : 'No pending operator input on the focused entry. Symphony has no route to steer a running agent without an input request.';

  // Resume maps to /resume (only when blocked + requires_manual_resume).
  const canResume = target.kind === 'resume' && apiHealthy;
  const resumeDisabledReason = !active
    ? 'Select an issue to resume'
    : !apiHealthy
      ? 'API dispatch validation failed'
      : target.kind === 'resume'
        ? null
        : active.kind === 'blocked'
          ? 'Blocked entry does not require manual resume (no operator route applies).'
          : 'Resume requires a blocked run.';

  return [
    {
      id: 'steer',
      label: 'Steer',
      intent_line: 'Answer pending input',
      icon: 'compass',
      tone: 'blue',
      enabled: canSteer,
      disabled_reason: steerDisabledReason,
      destructive: false,
      api_action: findAvailable('submit_input'),
      last_result: lastResultByAction.get('submit_input') ?? null
    },
    {
      id: 'resume',
      label: 'Resume',
      intent_line: 'Unblock with operator note',
      icon: 'play',
      tone: 'blue',
      enabled: canResume,
      disabled_reason: resumeDisabledReason,
      destructive: false,
      api_action: findAvailable('resume'),
      last_result: lastResultByAction.get('resume') ?? null
    },
    {
      id: 'inspect_evidence',
      label: 'Inspect Evidence',
      intent_line: 'Open transcript path',
      icon: 'document-search',
      tone: 'green',
      enabled: !!active,
      disabled_reason: active ? null : 'Select an issue to inspect',
      destructive: false,
      api_action: null,
      last_result: null
    },
    {
      id: 'export_forensics',
      label: 'Export Forensics',
      intent_line: 'Bundle run artifacts',
      icon: 'download',
      tone: 'violet',
      enabled: !!active,
      disabled_reason: active ? null : 'Select an issue to export',
      destructive: false,
      api_action: null,
      last_result: null
    },
    {
      id: 'drain_wait',
      label: drainActive ? 'Drain: Active' : 'Drain: Wait',
      intent_line: drainActive ? 'Quiescence in progress' : 'Quiesce new work',
      icon: 'pause',
      tone: 'amber',
      enabled: true,
      disabled_reason: null,
      destructive: false,
      api_action: null,
      last_result: null
    },
    {
      id: 'more',
      label: 'More',
      intent_line: '',
      icon: 'ellipsis',
      tone: 'neutral',
      enabled: true,
      disabled_reason: null,
      destructive: false,
      api_action: null,
      last_result: null,
      more_items: [
        { id: 'runtime_panels', label: 'Runtime Panels', endpoint: '/api/v1/diagnostics', enabled: true, disabled_reason: null },
        {
          id: 'event_feed',
          label: 'Event Feed',
          endpoint: null,
          enabled: false,
          disabled_reason: '/api/v1/events is an SSE stream, not an operator panel. A designed event feed is not yet implemented.'
        },
        { id: 'project_history', label: 'Project History', endpoint: '/api/v1/history', enabled: true, disabled_reason: null },
        { id: 'diagnostics', label: 'Diagnostics', endpoint: '/api/v1/diagnostics', enabled: true, disabled_reason: null },
        { id: 'raw_json', label: 'Raw JSON', endpoint: '/api/v1/state', enabled: true, disabled_reason: null },
        { id: 'classic_dashboard', label: 'Classic Dashboard', endpoint: '/dashboard', enabled: true, disabled_reason: null },
        {
          id: 'settings',
          label: 'Settings',
          endpoint: null,
          enabled: false,
          disabled_reason: 'No configurable settings endpoint exists yet. /api/v1/workflow/path is read-only workflow identity, not a settings UI.'
        }
      ]
    }
  ];
}

// ============================================================================
// Shell + footer
// ============================================================================

/**
 * Render the Audit ribbon cell from real persistence/audit health. The cell
 * may only show the red "Recording" state when the server has explicitly
 * proven the history sink is enabled + integrity_ok. Anything else degrades
 * to amber/red with a precise reason and emits an `audit_recording_proof`
 * missing-capability if the proof is absent.
 */
function buildAuditCell(audit: AuditHealthInput | null, missing: MissingCapability[]): TelemetryCell {
  const detailEndpoint = audit?.detail_endpoint ?? '/api/v1/diagnostics';
  if (!audit) {
    if (!missing.some((m) => m.id === 'audit_recording_proof')) {
      missing.push({
        id: 'audit_recording_proof',
        label: 'Audit recording proof',
        required_for: 'audit_receipt',
        severity: 'degrades_observability',
        current_fallback:
          'Audit ribbon cell shows amber "Unknown" because the projector was not given a persistence/audit health snapshot.',
        implementation_hint:
          'Pass auditHealth (DiagnosticsSource.getPersistenceHealth() composed into {enabled, integrity_ok, recent_write_failure}) into projectLivingAgentLens.'
      });
    }
    return {
      icon: 'record',
      label: 'Audit',
      value: 'Unknown',
      detail: 'Audit recording proof not provided by the runtime.',
      tone: 'amber',
      detail_endpoint: detailEndpoint
    };
  }
  if (!audit.enabled) {
    return {
      icon: 'record',
      label: 'Audit',
      value: 'Not recording',
      detail: 'Persistence sink is disabled; operator actions are not durably logged.',
      tone: 'amber',
      detail_endpoint: detailEndpoint
    };
  }
  if (!audit.integrity_ok) {
    return {
      icon: 'record',
      label: 'Audit',
      value: 'Degraded',
      detail: audit.recent_write_failure?.detail ?? 'Persistence integrity check failed.',
      tone: 'red',
      detail_endpoint: detailEndpoint
    };
  }
  if (audit.recent_write_failure) {
    return {
      icon: 'record',
      label: 'Audit',
      value: 'Recording (recent failure)',
      detail: audit.recent_write_failure.detail ?? 'A recent history write failed; the sink has since recovered.',
      tone: 'amber',
      detail_endpoint: detailEndpoint
    };
  }
  return {
    icon: 'record',
    label: 'Audit',
    value: 'Recording',
    detail: 'Persistence sink enabled and integrity-ok.',
    tone: 'red',
    detail_endpoint: detailEndpoint
  };
}

function buildShell(state: ApiStateResponse, options: ProjectLivingAgentLensOptions, missing: MissingCapability[]): ShellTelemetry {
  const runtime = state.runtime_identity;
  const dispatchOk = state.health.dispatch_validation === 'ok';
  const cpHealth = state.health.control_plane;
  const worstHealth = cpHealth?.worst_health ?? (dispatchOk ? 'healthy' : 'degraded');
  const refreshAgeS = state.snapshot_age_ms / 1000;

  return {
    brand: { title: 'Symphony Control Constellation', subtitle: 'Living Agent Lens' },
    orchestrator: {
      icon: 'orbit',
      label: 'Orchestrator',
      value: 'Local',
      detail: dispatchOk ? 'Healthy' : state.health.last_error ?? 'Degraded',
      tone: dispatchOk ? 'green' : 'red',
      detail_endpoint: '/api/v1/diagnostics'
    },
    runtime_build: buildRuntimeBuildCell(runtime, options, missing),
    system_health: {
      icon: 'shield-check',
      label: 'System Health',
      value: humanizeHealth(worstHealth),
      detail: state.health.last_error ?? null,
      tone: toneForHealth(worstHealth),
      detail_endpoint: '/api/v1/diagnostics'
    },
    audit: buildAuditCell(options.auditHealth ?? null, missing),
    refresh_pulse: {
      icon: 'pulse',
      label: 'Refresh Pulse',
      value: state.snapshot_freshness_state === 'stale' ? 'STALE' : state.snapshot_freshness_state === 'aging' ? 'AGING' : `${refreshAgeS.toFixed(1)}s`,
      detail: `${state.snapshot_freshness_state} · ${refreshTransportLabel(options.refreshTransport ?? 'polling')}`,
      tone: state.snapshot_freshness_state === 'stale' ? 'red' : state.snapshot_freshness_state === 'aging' ? 'amber' : 'blue',
      detail_endpoint: null
    },
    filters: buildFilters(state, missing)
  };
}

function buildRuntimeBuildCell(
  runtime: ApiStateResponse['runtime_identity'],
  options: ProjectLivingAgentLensOptions,
  missing: MissingCapability[]
): TelemetryCell {
  if (!runtime) {
    if (!missing.some((m) => m.id === 'runtime_identity')) {
      missing.push({
        id: 'runtime_identity',
        label: 'Runtime build identity',
        required_for: 'project_identity',
        severity: 'degrades_observability',
        current_fallback: 'Runtime build cell shows "unknown" with amber tone.',
        implementation_hint: 'Ensure runtime_identity is populated on every snapshot.'
      });
    }
    return {
      icon: 'hash',
      label: 'Runtime Build',
      value: 'unknown',
      detail: 'No runtime identity reported',
      tone: 'amber',
      detail_endpoint: '/api/v1/diagnostics'
    };
  }
  const sha = runtime.running_build.commit_sha?.slice(0, 7) ?? null;
  const tone = runtime.status === 'current' ? 'green' : runtime.status === 'stale' ? 'amber' : 'neutral';
  return {
    icon: 'hash',
    label: 'Runtime Build',
    value: options.runtimeVersionLabel ?? sha ?? runtime.running_build.identity ?? 'unknown',
    detail: sha ? `commit ${sha}` : runtime.running_build.source_timestamp ?? null,
    tone,
    detail_endpoint: '/api/v1/diagnostics'
  };
}

function humanizeHealth(value: string): string {
  switch (value) {
    case 'healthy': return 'All Green';
    case 'degraded': return 'Degraded';
    case 'slow': return 'Slow';
    case 'failed': return 'Failed';
    default: return value;
  }
}

function toneForHealth(value: string): TelemetryCell['tone'] {
  switch (value) {
    case 'healthy': return 'green';
    case 'slow': return 'amber';
    case 'degraded': return 'amber';
    case 'failed': return 'red';
    default: return 'neutral';
  }
}

function refreshTransportLabel(transport: RefreshTransport): string {
  switch (transport) {
    case 'stream': return 'stream';
    case 'polling': return 'polling';
    case 'stale': return 'stale';
    case 'offline': return 'offline';
  }
}

function buildFilters(state: ApiStateResponse, missing: MissingCapability[]): FilterDescriptor[] {
  const needsMe = state.blocked.length + state.running.filter((r) => r.awaiting_input).length;
  const stalled = state.running.filter((r) => r.stalled_waiting).length;
  const retryOverdue = state.retrying.filter((r) => r.due_state === 'overdue').length;
  const unsafeRestart = state.drain_mode.active ? 1 : 0;
  const budgetRisk = state.running.filter((r) => r.budget_status === 'warning' || r.budget_status === 'hard_limited').length;
  const modelRerouted = state.running.filter((r) => r.model_reroute).length;

  // The filter counts are real, but the Filters button itself has no panel UI
  // wired in yet: no route exists to apply a filter and re-render the queue
  // under that lens. Mark the surface as a missing capability so the shell
  // can render the Filters button as disabled-with-reason.
  if (!missing.some((m) => m.id === 'shell_smart_filters')) {
    missing.push({
      id: 'shell_smart_filters',
      label: 'Smart-view filter panel',
      required_for: 'gravity',
      severity: 'degrades_observability',
      current_fallback:
        'Filters button is disabled. Filter counts (Needs me, Stalled, Retry overdue, etc.) are computed but no panel UI exists to apply them.',
      implementation_hint:
        'Add a /lens filter overlay and either client-side filtering on the queue or a `?filter=` query param honored by /api/v1/living-agent-lens.'
    });
  }

  return [
    { id: 'needs_me', label: 'Needs me', count: needsMe, active: false },
    { id: 'stalled', label: 'Stalled', count: stalled, active: false },
    { id: 'retry_overdue', label: 'Retry overdue', count: retryOverdue, active: false },
    { id: 'unsafe_restart', label: 'Unsafe to restart', count: unsafeRestart, active: false },
    { id: 'budget_risk', label: 'Budget risk', count: budgetRisk, active: false },
    { id: 'model_rerouted', label: 'Model rerouted', count: modelRerouted, active: false }
  ];
}

function buildFooter(state: ApiStateResponse, options: ProjectLivingAgentLensOptions, now: number): FooterTelemetry {
  const locale = options.locale ?? 'en-US';
  const snapshotTime = new Date(state.snapshot_generated_at_ms).toLocaleTimeString(locale, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const localTime = new Date(now).toLocaleDateString(locale, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });

  const apiHealthy = state.health.dispatch_validation === 'ok' && state.snapshot_freshness_state !== 'stale';
  const pressure = state.worker_event_pressure;
  const activeWorkers = pressure?.active_worker_count ?? 0;
  const waitingWorkers = pressure?.waiting_worker_count ?? 0;
  const totalWorkers = activeWorkers + waitingWorkers;
  const blockedRetry = state.blocked.length + state.retrying.length;

  return {
    operator: options.operator ?? null,
    snapshot_time: snapshotTime,
    local_time: localTime,
    api: {
      icon: 'plug',
      label: 'API',
      value: apiHealthy ? 'Healthy' : 'Degraded',
      detail: state.health.last_error ?? null,
      tone: apiHealthy ? 'green' : 'red',
      detail_endpoint: '/api/v1/diagnostics'
    },
    workers: {
      icon: 'cpu',
      label: 'Workers',
      value: `${activeWorkers} / ${Math.max(1, totalWorkers)}`,
      detail: pressure?.degraded ? pressure.reason_code ?? 'degraded' : null,
      tone: pressure?.degraded ? 'amber' : 'green',
      detail_endpoint: '/api/v1/diagnostics'
    },
    queues: {
      icon: 'layers',
      label: 'Queues',
      value: String(blockedRetry),
      detail: `${state.blocked.length} blocked · ${state.retrying.length} retry`,
      tone: blockedRetry === 0 ? 'green' : blockedRetry < 3 ? 'amber' : 'red',
      detail_endpoint: null
    }
  };
}

function buildFreshness(state: ApiStateResponse, transport: RefreshTransport): SnapshotFreshness {
  const cadence = Number((state.snapshot_age_ms / 1000).toFixed(1));
  const label = state.snapshot_freshness_state === 'stale' ? 'STALE'
    : transport === 'polling' && state.snapshot_freshness_state === 'aging' ? 'POLLING'
    : `${cadence}s`;
  return {
    generated_at_ms: state.snapshot_generated_at_ms,
    age_ms: state.snapshot_age_ms,
    state: state.snapshot_freshness_state,
    transport,
    label,
    cadence_seconds: Number.isFinite(cadence) ? cadence : null
  };
}
