import type { CodexRunner } from '../codex';
import { parseReviewOutcome } from '../review';
import type { AgentRunResult, AgentRunner, AgentRunnerEvent, AgentRunnerStartInput } from './types';

export class CodexAgentRunner implements AgentRunner {
  readonly runtime = 'codex-app-server' as const;
  readonly capabilities = {
    native_resume: 'none',
    missing_tool_output_recovery: true,
    remote_worker: true,
    enforcement_usage: true
  } as const;

  constructor(private readonly codexRunner: CodexRunner) {}

  async startSessionAndRunTurn(input: AgentRunnerStartInput): Promise<AgentRunResult> {
    const result = await this.codexRunner.startSessionAndRunTurn({
      ...input,
      onEvent: input.onEvent
        ? (event) =>
            input.onEvent?.({
              ...event,
              agent_runtime: this.runtime,
              worker_process_pid: event.codex_app_server_pid
            } satisfies AgentRunnerEvent)
        : undefined
    });

    return {
      runtime: this.runtime,
      status: result.status,
      session_id: result.session_id,
      thread_id: result.thread_id,
      turn_id: result.turn_id,
      last_event: result.last_event,
      last_agent_message: result.last_agent_message,
      error_code: result.error_code,
      error_detail: result.error_detail,
      cancellation_outcome: result.cancellation_outcome,
      input_required_payload: result.input_required_payload,
      requested_model: result.requested_model,
      effective_model: result.effective_model,
      review_outcome: parseReviewOutcome(result.last_agent_message)
    };
  }
}
