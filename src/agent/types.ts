import type {
  CodexCancellationOutcome,
  CodexInputRequestPayload,
  CodexRunnerEvent,
  CodexRunnerStartInput,
  CodexTurnErrorCode
} from '../codex/types';
import type { AgentReviewOutcome } from '../review';

export type AgentRuntime = 'codex-app-server' | 'claude-cli';

export interface AgentRunnerCapabilities {
  native_resume: 'within-attempt' | 'none';
  missing_tool_output_recovery: boolean;
  remote_worker: boolean;
  enforcement_usage: boolean;
}

export interface ProviderUsage {
  runtime: 'claude-cli';
  model: string | null;
  effective_models?: string[];
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  provider_turn_count: number | null;
  estimated_cost_usd: number | null;
  source: 'claude_invocation' | 'claude_assistant_step' | 'claude_stream_result';
  status: 'awaiting' | 'partial' | 'final' | 'unobserved';
  confidence: 'provider_step' | 'provider_result' | 'legacy_partial' | 'missing';
  api_retry_count?: number;
  api_error_status?: number | string | null;
  terminal_reason?: string | null;
  stop_reason?: string | null;
  duration_ms?: number | null;
  duration_api_ms?: number | null;
  time_to_first_token_ms?: number | null;
  permission_denial_count?: number;
  unknown_event_count?: number;
  auxiliary_result_count?: number;
  nested_session_detected?: boolean;
  supervised_session_coverage?: 'complete' | 'partial' | 'missing';
  tool_counts?: Record<string, number>;
  mcp_counts?: Record<string, number>;
  updated_at?: string;
  missing_reason?: string | null;
  reconciliation_delta?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    provider_turn_count: number;
  } | null;
  model_usage?: Array<{
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    estimated_cost_usd: number | null;
  }>;
}

export interface ProviderUsageStepFact {
  message_id_hash: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  observed_at: string;
}

export interface AgentRunnerEvent extends CodexRunnerEvent {
  agent_runtime?: AgentRuntime;
  worker_process_pid?: number | null;
  provider_usage?: ProviderUsage;
  provider_usage_step_facts?: ProviderUsageStepFact[];
  process_liveness_only?: boolean;
}

export interface AgentRunnerStartInput extends Omit<CodexRunnerStartInput, 'onEvent'> {
  onEvent?: (event: AgentRunnerEvent) => void;
  runBinding?: {
    project_identity: string;
    issue_id: string;
    issue_identifier: string;
    attempt: number | null;
    symphony_attempt_id?: string;
  };
}

export interface AgentRunnerResumeInput extends AgentRunnerStartInput {
  previousSessionId: string;
}

export interface AgentRunResult {
  runtime: AgentRuntime;
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  last_event: string;
  last_agent_message?: string;
  error_code?: CodexTurnErrorCode | string;
  error_detail?: string;
  cancellation_outcome?: CodexCancellationOutcome;
  input_required_payload?: CodexInputRequestPayload;
  provider_usage?: ProviderUsage;
  requested_model?: string | null;
  effective_model?: string | null;
  retryable?: boolean;
  review_outcome?: AgentReviewOutcome | null;
}

export interface AgentRunner {
  readonly runtime: AgentRuntime;
  readonly capabilities: AgentRunnerCapabilities;
  startSessionAndRunTurn(input: AgentRunnerStartInput): Promise<AgentRunResult>;
  resumeSessionAndRunTurn?(input: AgentRunnerResumeInput): Promise<AgentRunResult>;
}
