import { REASON_CODES } from '../observability/reason-codes';
import type { CodexAppServerThreadActivitySource } from './app-server-protocol';

export interface CodexRunnerStartInput {
  command: string;
  commandArgs?: string[];
  commandEnv?: Record<string, string>;
  workspaceCwd: string;
  workerHost?: string;
  prompt: string;
  continuationPrompt?: string;
  title: string;
  maxTurns?: number;
  approvalPolicy?:
    | string
    | {
        reject?: {
          sandbox_approval?: boolean;
          rules?: boolean;
          mcp_elicitations?: boolean;
        };
      };
  threadSandbox?: string;
  turnSandboxPolicy?: Record<string, unknown>;
  onEvent?: (event: CodexRunnerEvent) => void;
  cancellationSignal?: AbortSignal;
  readTimeoutMs: number;
  turnTimeoutMs: number;
}

export interface CodexRunnerRecoveryInput extends CodexRunnerStartInput {
  previousThreadId: string;
  previousTurnId: string;
  previousSessionId?: string | null;
}

export type CodexTurnStatus = 'completed' | 'failed';

export type CodexTurnErrorCode =
  | 'codex_not_found'
  | 'invalid_workspace_cwd'
  | 'invalid_remote_workspace_cwd'
  | typeof REASON_CODES.unsafeWorkspaceRoot
  | 'response_timeout'
  | typeof REASON_CODES.turnTimeout
  | 'port_exit'
  | 'response_error'
  | 'turn_failed'
  | 'turn_cancelled'
  | typeof REASON_CODES.turnInputRequired;

export type CodexCancellationOutcome = 'requested' | 'graceful_exit' | 'forced_kill_exited' | 'forced_kill_requested';

export interface CodexUsageTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
  model_context_window?: number;
}

export type TokenTelemetryStatus = 'unavailable' | 'pending' | 'available';

export interface TokenTelemetrySnapshot {
  token_telemetry_status: TokenTelemetryStatus;
  token_telemetry_last_source: string | null;
  token_telemetry_last_at_ms: number | null;
}

export interface CodexProtocolWarningEvidence {
  method: string;
  reason_code: string;
  message: string | null;
  severity: 'info' | 'warn';
  source: 'app_server_protocol';
}

export interface CodexModelRerouteEvidence {
  requested_model: string | null;
  effective_model: string;
  reason_code: string;
  source: 'app_server_protocol' | 'claude_assistant_step' | 'claude_stream_result';
}

export interface CodexInputRequestOption {
  label: string;
  value?: string;
}

export interface CodexInputQuestion {
  id: string;
  prompt?: string;
  options?: CodexInputRequestOption[];
}

export interface CodexInputRequestPayload {
  request_id: string;
  request_method: string;
  prompt_text: string | null;
  questions: CodexInputQuestion[];
  options: string[];
  input_schema_type: 'options' | 'text' | 'unknown';
  input_required_at: string;
}

export interface CodexTurnResult {
  status: CodexTurnStatus;
  thread_id: string;
  turn_id: string;
  session_id: string;
  last_event: string;
  terminal_source?: 'app_server_protocol' | 'session_transcript';
  last_agent_message?: string;
  completed_at_ms?: number;
  duration_ms?: number;
  time_to_first_token_ms?: number;
  error_code?: CodexTurnErrorCode;
  error_detail?: string;
  cancellation_outcome?: CodexCancellationOutcome;
  input_required_payload?: CodexInputRequestPayload;
  turns_completed: number;
  usage?: CodexUsageTotals;
  token_telemetry_status?: TokenTelemetryStatus;
  token_telemetry_last_source?: string | null;
  token_telemetry_last_at_ms?: number | null;
  rate_limits?: Record<string, unknown> | null;
  protocol_warnings?: CodexProtocolWarningEvidence[];
  model_reroute?: CodexModelRerouteEvidence | null;
  requested_model?: string | null;
  effective_model?: string | null;
  transcript_lookup?: CodexTranscriptLookupMetadata;
}

export interface CodexTranscriptLookupMetadata {
  source: 'indexed' | 'filename' | 'fallback' | 'cache' | 'missing' | 'budget_exhausted';
  cached_source?: 'indexed' | 'filename' | 'fallback' | 'missing' | 'budget_exhausted';
  candidate_count: number;
  files_considered: number;
  files_parsed: number;
  bytes_read: number;
  exhausted: boolean;
  reason_codes: string[];
  cache_refreshed_at_ms: number;
  cache_expires_at_ms: number;
}

export interface CodexRunnerEvent {
  event: string;
  timestamp: string;
  codex_app_server_pid: number | null;
  worker_instance_id?: string | null;
  thread_id?: string;
  turn_id?: string;
  session_id?: string;
  usage?: CodexUsageTotals;
  token_telemetry_status?: TokenTelemetryStatus;
  token_telemetry_last_source?: string | null;
  token_telemetry_last_at_ms?: number | null;
  rate_limits?: Record<string, unknown> | null;
  protocol_warnings?: CodexProtocolWarningEvidence[];
  protocol_warning?: CodexProtocolWarningEvidence;
  model_reroute?: CodexModelRerouteEvidence | null;
  requested_model?: string | null;
  effective_model?: string | null;
  codex_thread_activity_at_ms?: number | null;
  codex_thread_activity_source?: CodexAppServerThreadActivitySource | null;
  codex_thread_activity_status?: string | null;
  detail?: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_call_evidence_source?: 'worker_event' | 'app_server_protocol' | 'session_transcript';
  terminal_source?: 'app_server_protocol' | 'session_transcript';
  reason_code?: string;
  request_method?: string;
  request_category?: string;
  transcript_lookup_source?: CodexTranscriptLookupMetadata['source'];
  transcript_lookup_cached_source?: CodexTranscriptLookupMetadata['cached_source'];
  transcript_lookup_candidate_count?: number;
  transcript_lookup_files_considered?: number;
  transcript_lookup_files_parsed?: number;
  transcript_lookup_bytes_read?: number;
  transcript_lookup_exhausted?: boolean;
  transcript_lookup_reason_codes?: string[];
  transcript_lookup_cache_refreshed_at_ms?: number;
  transcript_lookup_cache_expires_at_ms?: number;
}
