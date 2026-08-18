import type {
  CodexCancellationOutcome,
  CodexInputRequestPayload,
  CodexRunnerEvent,
  CodexRunnerStartInput,
  CodexTurnErrorCode
} from '../codex/types';

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
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  provider_turn_count: number | null;
  estimated_cost_usd: number | null;
  source: 'claude_stream_result';
  confidence: 'provider_estimate' | 'missing';
}

export interface AgentRunnerEvent extends CodexRunnerEvent {
  agent_runtime?: AgentRuntime;
  worker_process_pid?: number | null;
  provider_usage?: ProviderUsage;
  process_liveness_only?: boolean;
}

export interface AgentRunnerStartInput extends Omit<CodexRunnerStartInput, 'onEvent'> {
  onEvent?: (event: AgentRunnerEvent) => void;
  runBinding?: {
    project_identity: string;
    issue_id: string;
    issue_identifier: string;
    attempt: number | null;
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
}

export interface AgentRunner {
  readonly runtime: AgentRuntime;
  readonly capabilities: AgentRunnerCapabilities;
  startSessionAndRunTurn(input: AgentRunnerStartInput): Promise<AgentRunResult>;
  resumeSessionAndRunTurn?(input: AgentRunnerResumeInput): Promise<AgentRunResult>;
}
