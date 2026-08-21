import { DYNAMIC_TOOL_CONSOLE_RECOVERY_ACTION, UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE } from './dynamic-tool-capability';

export const REASON_CODE_REGISTRY_VERSION = '2026-08-21.v1';

export type ReasonCodeClassification =
  | 'healthy'
  | 'awaiting_input'
  | 'stalled_waiting'
  | 'retrying'
  | 'blocked_input'
  | 'failed';

export type ReasonCodeActionability = 'none' | 'recommended' | 'required';

export interface ReasonCodeDefinition {
  reason_code: string;
  classification: ReasonCodeClassification;
  actionability: ReasonCodeActionability;
  recommended_actions: string[];
  label: string;
  headline: string;
  detail: string;
  expected_transition: string | null;
}

export const REASON_CODES = {
  normalCompletion: 'normal_completion',
  maxTurnsReached: 'max_turns_reached',
  handoffStateReached: 'handoff_state_reached',
  handoffRelease: 'handoff_release',
  freshDispatchStateRouted: 'fresh_dispatch_state_routed',
  freshDispatchNoRoute: 'fresh_dispatch_no_route',
  issueLeftActiveStates: 'issue_left_active_states',
  issueStateMissing: 'issue_state_missing',
  terminalStateReached: 'terminal_state_reached',
  dispatchStarted: 'dispatch_started',
  attemptStarted: 'attempt_started',
  codexSessionStarted: 'codex_session_started',
  workerExitAbnormal: 'worker_exit_abnormal',
  workerStalled: 'worker_stalled',
  workerOpaqueActivityHardTimeout: 'worker_opaque_activity_hard_timeout',
  slotsExhausted: 'slots_exhausted',
  dispatchBackpressureControlPlane: 'dispatch_backpressure_control_plane',
  dispatchBackpressureHostLoad: 'dispatch_backpressure_host_load',
  retryFetchFailed: 'retry_fetch_failed',
  spawnFailed: 'spawn_failed',
  manualResume: 'manual_resume',
  operatorRequeueRequested: 'operator_requeue_requested',
  operatorRetryStepRequested: 'operator_retry_step_requested',
  operatorClearAutomationFault: 'operator_clear_automation_fault',
  turnTimeout: 'turn_timeout',
  turnInputRequired: 'turn_input_required',
  turnWaitingThresholdExceeded: 'turn_waiting_threshold_exceeded',
  missingToolOutput: 'missing_tool_output',
  missingToolOutputRecoveryInterrupted: 'missing_tool_output_recovery_interrupted',
  missingToolOutputRecoveryExhausted: 'missing_tool_output_recovery_exhausted',
  missingToolOutputRecoveryStartFailed: 'missing_tool_output_recovery_start_failed',
  missingToolOutputRecoveryUnsafe: 'missing_tool_output_recovery_unsafe',
  workerHandleMissing: 'worker_handle_missing',
  workerCancelFailed: 'worker_cancel_failed',
  workerCancelUnsupported: 'worker_cancel_unsupported',
  workerCancelGracefulExit: 'worker_cancel_graceful_exit',
  workerCancelForcedKillExited: 'worker_cancel_forced_kill_exited',
  workerCancelForcedKillUnconfirmed: 'worker_cancel_forced_kill_unconfirmed',
  workerCancelRequested: 'worker_cancel_requested',
  workerCancelSettledWithoutOutcome: 'worker_cancel_settled_without_outcome',
  workerCancelUnknown: 'worker_cancel_unknown',
  workspaceCleanupFailed: 'workspace_cleanup_failed',
  operatorWorkspaceConflict: 'operator_action_required_workspace_conflict',
  workspaceAttemptResidueRecovered: 'workspace_attempt_residue_recovered',
  operatorNoProgressRedispatchBlocked: 'operator_action_required_no_progress_redispatch_blocked',
  agentReviewHandoffProgressObserved: 'agent_review_handoff_progress_observed',
  noProgressBlockSuppressed: 'no_progress_block_suppressed',
  staleBlockedInputCleared: 'stale_blocked_input_cleared',
  freshDispatchAfterReviewHandoff: 'fresh_dispatch_after_review_handoff',
  operatorBudgetLimitExceeded: 'operator_action_required_budget_limit_exceeded',
  attemptTerminatedBudgetLimitExceeded: 'attempt_terminated_budget_limit_exceeded',
  unsupportedDynamicToolConsoleResume: UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE,
  awaitingHumanReviewScopeIncomplete: 'awaiting_human_review_scope_incomplete',
  issueStateRefreshFailed: 'issue_state_refresh_failed',
  unsafeWorkspaceRoot: 'unsafe_workspace_root',
  workspaceEmpty: 'workspace_empty',
  unsupportedServerRequest: 'unsupported_server_request',
  unsupportedApprovalServerRequest: 'unsupported_approval_server_request',
  unsupportedPermissionServerRequest: 'unsupported_permission_server_request',
  unsupportedAuthenticationServerRequest: 'unsupported_authentication_server_request',
  unsupportedAccountServerRequest: 'unsupported_account_server_request',
  unsupportedSafetySensitiveServerRequest: 'unsupported_safety_sensitive_server_request',
  codexProtocolWarning: 'codex_protocol_warning',
  codexProtocolGuardianWarning: 'codex_protocol_guardian_warning',
  codexProtocolDeprecationNotice: 'codex_protocol_deprecation_notice',
  codexProtocolConfigWarning: 'codex_protocol_config_warning',
  codexModelRerouted: 'codex_model_rerouted',
  claudeModelObserved: 'claude_model_observed',
  claudePermissionDenied: 'claude_permission_denied',
  claudeSandboxRuntimeFailed: 'claude_sandbox_runtime_failed',
  reviewApprovalOutcomeInvalid: 'review_approval_outcome_invalid',
  reviewApprovalContextMismatch: 'review_approval_context_mismatch',
  reviewApprovalCredentialsInvalid: 'review_approval_credentials_invalid',
  reviewApprovalGithubFailed: 'review_approval_github_failed',
  reviewApprovalReadbackFailed: 'review_approval_readback_failed',
  reviewApprovalSupervisorUnavailable: 'review_approval_supervisor_unavailable',
  symphonyPhaseMarker: 'symphony_phase_marker',
  recoveredAfterRestart: 'recovered_after_restart',
  projectHistorySchemaHealthUnavailable: 'project_history_schema_health_unavailable',
  projectHistoryTrackerSnapshotMissing: 'project_history_tracker_snapshot_missing',
  projectHistoryTerminalOutcomeMissing: 'project_history_terminal_outcome_missing',
  projectHistoryThreadTurnReferencesMissing: 'project_history_thread_turn_references_missing',
  projectHistoryEvidenceReferencesMissing: 'project_history_evidence_references_missing',
  projectHistoryOperationalFactsMissing: 'project_history_operational_facts_missing',
  projectHistoryTokenModelSummariesMissing: 'project_history_token_model_summaries_missing',
  projectHistoryAppServerLiteSummariesMissing: 'project_history_app_server_lite_summaries_missing',
  projectHistoryAppServerLiteDegraded: 'project_history_app_server_lite_degraded',
  projectHistoryPayloadRedacted: 'project_history_payload_redacted',
  projectHistoryPayloadTruncated: 'project_history_payload_truncated',
  workerEventPressure: 'worker_event_pressure',
  liveTokenFallbackNotOnHotPath: 'live_token_fallback_not_on_hot_path',
  stateProjectionUnavailable: 'state_projection_unavailable',
  runtimeUpdateDrainModeRequired: 'runtime_update_drain_mode_required',
  runtimeUpdateQuiescenceRequired: 'runtime_update_quiescence_required',
  runtimeUpdateNotActionable: 'runtime_update_not_actionable',
  runtimeUpdateNotPrepared: 'runtime_update_not_prepared',
  runtimeUpdateRepositoryUnavailable: 'runtime_update_repository_unavailable',
  runtimeUpdateGithubEligibilityRequired: 'runtime_update_github_eligibility_required',
  runtimeUpdateCandidateChanged: 'runtime_update_candidate_changed',
  runtimeUpdateRestartWrapperUnavailable: 'runtime_update_restart_wrapper_unavailable',
  runtimeUpdateRestartSupervisorAvailable: 'runtime_update_restart_supervisor_available',
  runtimeUpdateRestartRequested: 'runtime_update_restart_requested',
  runtimeUpdateRestartDuplicate: 'runtime_update_restart_duplicate',
  runtimeUpdateRestartSupervisorRefused: 'runtime_update_restart_supervisor_refused',
  runtimeUpdateRestartStarted: 'runtime_update_restart_started',
  runtimeUpdateRestartCompleted: 'runtime_update_restart_completed',
  runtimeUpdateRestartFailed: 'runtime_update_restart_failed',
  runtimeUpdateRestartIdentityMismatch: 'runtime_update_restart_identity_mismatch',
  runtimeUpdateDashboardAssetsVerified: 'runtime_update_dashboard_assets_verified',
  runtimeUpdateDashboardAssetVerificationFailed: 'runtime_update_dashboard_asset_verification_failed',
  runtimeUpdateReconnectObserved: 'runtime_update_reconnect_observed',
  unknownRuntimeReason: 'unknown_runtime_reason'
} as const;

export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];

export const CANONICAL_REASON_CODE_REGISTRY = {
  [REASON_CODES.normalCompletion]: {
    reason_code: REASON_CODES.normalCompletion,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Normal Completion',
    headline: 'Run is progressing',
    detail: 'The worker completed normally and the orchestrator is continuing while the issue remains active.',
    expected_transition: 'Run continues until completion or a runtime signal changes state'
  },
  [REASON_CODES.maxTurnsReached]: {
    reason_code: REASON_CODES.maxTurnsReached,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Max Turns Reached',
    headline: 'Run turn budget reached',
    detail: 'The worker completed normally after reaching the configured maximum turns for the current attempt.',
    expected_transition: 'Orchestrator continuation may schedule the next attempt while the issue remains active'
  },
  [REASON_CODES.handoffStateReached]: {
    reason_code: REASON_CODES.handoffStateReached,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Handoff State Reached',
    headline: 'Run stopped at handoff',
    detail: 'The worker completed normally and stopped because the refreshed issue state is configured as a handoff point.',
    expected_transition: 'Separate handoff automation may dispatch the next workflow'
  },
  [REASON_CODES.recoveredAfterRestart]: {
    reason_code: REASON_CODES.recoveredAfterRestart,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Recovered After Restart',
    headline: 'Orphaned history graph recovered',
    detail: 'Startup reconciliation closed execution records whose parent run had a provable terminal outcome.',
    expected_transition: 'No automatic transition; the repaired history graph remains terminal'
  },
  [REASON_CODES.symphonyPhaseMarker]: {
    reason_code: REASON_CODES.symphonyPhaseMarker,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Symphony Phase Marker',
    headline: 'Workflow phase observed',
    detail: 'Symphony projected a provider-neutral workflow phase from supervised runner activity.',
    expected_transition: 'The phase advances when the next supervised runner activity is observed'
  },
  [REASON_CODES.handoffRelease]: {
    reason_code: REASON_CODES.handoffRelease,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Handoff Release',
    headline: 'Run released at handoff',
    detail:
      'A running worker was cancelled without workspace cleanup because the issue crossed into a fresh-dispatch handoff state started by another workflow role.',
    expected_transition: 'Fresh-dispatch automation may start a new run without inherited implementation context'
  },
  [REASON_CODES.freshDispatchStateRouted]: {
    reason_code: REASON_CODES.freshDispatchStateRouted,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Fresh Dispatch State Routed',
    headline: 'Fresh run routed issue',
    detail: 'The worker completed normally and stopped because a fresh-dispatch run moved the issue to its next workflow state.',
    expected_transition: 'The dispatcher for the routed state may pick up the issue next'
  },
  [REASON_CODES.freshDispatchNoRoute]: {
    reason_code: REASON_CODES.freshDispatchNoRoute,
    classification: 'blocked_input',
    actionability: 'required',
    recommended_actions: ['Inspect the phase blocker', 'Correct the required evidence or tracker state', 'Requeue the issue'],
    label: 'Fresh Phase Did Not Route',
    headline: 'Fresh workflow phase stopped without routing',
    detail: 'A fresh review or landing run completed while the issue remained in its dispatch state, so Symphony blocked redispatch instead of looping.',
    expected_transition: 'An operator corrects the blocker and requeues the issue'
  },
  [REASON_CODES.issueLeftActiveStates]: {
    reason_code: REASON_CODES.issueLeftActiveStates,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Issue Left Active States',
    headline: 'Run stopped after state change',
    detail: 'The worker completed normally and stopped because the refreshed issue state is no longer active.',
    expected_transition: 'No same-workflow continuation is scheduled'
  },
  [REASON_CODES.issueStateMissing]: {
    reason_code: REASON_CODES.issueStateMissing,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Issue State Missing',
    headline: 'Run stopped after missing refresh result',
    detail: 'The worker completed normally and stopped because the tracker refresh did not return the issue.',
    expected_transition: 'No continuation is scheduled until the issue is visible again'
  },
  [REASON_CODES.terminalStateReached]: {
    reason_code: REASON_CODES.terminalStateReached,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Terminal State Reached',
    headline: 'Run stopped at terminal state',
    detail: 'The worker completed normally and the refreshed issue state is terminal, so terminal cleanup applies.',
    expected_transition: 'Workspace cleanup runs and no continuation is scheduled'
  },
  [REASON_CODES.dispatchStarted]: {
    reason_code: REASON_CODES.dispatchStarted,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Dispatch Started',
    headline: 'Run dispatch started',
    detail: 'The orchestrator started dispatching an attempt.',
    expected_transition: 'Worker spawn and attempt lifecycle events follow'
  },
  [REASON_CODES.attemptStarted]: {
    reason_code: REASON_CODES.attemptStarted,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Attempt Started',
    headline: 'Attempt started',
    detail: 'A worker attempt was persisted under the execution graph.',
    expected_transition: 'Thread and turn lifecycle events follow'
  },
  [REASON_CODES.codexSessionStarted]: {
    reason_code: REASON_CODES.codexSessionStarted,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Codex Session Started',
    headline: 'Codex session started',
    detail: 'A Codex thread was persisted under the current attempt.',
    expected_transition: 'Turn lifecycle events follow'
  },
  [REASON_CODES.workerExitAbnormal]: {
    reason_code: REASON_CODES.workerExitAbnormal,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Monitor the retry; inspect worker logs if the same reason repeats'],
    label: 'Worker Exit Abnormal',
    headline: 'Run is waiting to retry',
    detail: 'The worker exited abnormally and the orchestrator scheduled a retry.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.workerStalled]: {
    reason_code: REASON_CODES.workerStalled,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Monitor the retry; inspect recent runtime events if stalls repeat'],
    label: 'Worker Stalled',
    headline: 'Run is waiting to retry',
    detail: 'The worker stopped producing progress before the configured stall timeout.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.workerOpaqueActivityHardTimeout]: {
    reason_code: REASON_CODES.workerOpaqueActivityHardTimeout,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Monitor the retry; inspect Codex thread activity if opaque runs repeat'],
    label: 'Opaque Activity Hard Timeout',
    headline: 'Run is waiting to retry',
    detail: 'The worker stayed alive without observable meaningful progress past the configured opaque activity hard timeout.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.slotsExhausted]: {
    reason_code: REASON_CODES.slotsExhausted,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Wait for an orchestrator slot to free up', 'Review worker slot configuration if this persists'],
    label: 'Slots Exhausted',
    headline: 'Run is waiting to retry',
    detail: 'No orchestrator or worker-host slots are currently available.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.dispatchBackpressureControlPlane]: {
    reason_code: REASON_CODES.dispatchBackpressureControlPlane,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Wait for local control-plane health to recover', 'Reduce local agent concurrency if this persists'],
    label: 'Control Plane Backpressure',
    headline: 'Run is waiting for local capacity',
    detail: 'Dispatch is delayed because compact control-plane health indicates degraded local supervision.',
    expected_transition: 'Automatic retry after the configured backpressure delay'
  },
  [REASON_CODES.dispatchBackpressureHostLoad]: {
    reason_code: REASON_CODES.dispatchBackpressureHostLoad,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Wait for host load to fall', 'Reduce local agent concurrency if this persists'],
    label: 'Host Load Backpressure',
    headline: 'Run is waiting for local capacity',
    detail: 'Dispatch is delayed because local host load is above the configured threshold.',
    expected_transition: 'Automatic retry after the configured backpressure delay'
  },
  [REASON_CODES.retryFetchFailed]: {
    reason_code: REASON_CODES.retryFetchFailed,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Inspect tracker connectivity and retry state refresh errors'],
    label: 'Retry Fetch Failed',
    headline: 'Run is waiting to retry',
    detail: 'The orchestrator could not refresh issue state while processing a retry.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.spawnFailed]: {
    reason_code: REASON_CODES.spawnFailed,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Inspect worker launch configuration and retry logs'],
    label: 'Spawn Failed',
    headline: 'Run is waiting to retry',
    detail: 'The orchestrator could not spawn the worker process.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.manualResume]: {
    reason_code: REASON_CODES.manualResume,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Monitor the resumed run'],
    label: 'Manual Resume',
    headline: 'Run is waiting to retry',
    detail: 'The run was manually resumed and queued for dispatch.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.operatorRequeueRequested]: {
    reason_code: REASON_CODES.operatorRequeueRequested,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Monitor the requeued run'],
    label: 'Operator Requeue Requested',
    headline: 'Run was requeued by an operator',
    detail: 'An operator explicitly requeued the issue from the action console.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.operatorRetryStepRequested]: {
    reason_code: REASON_CODES.operatorRetryStepRequested,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Monitor the retried step'],
    label: 'Operator Retry Step Requested',
    headline: 'Failed step retry was requested',
    detail: 'An operator explicitly retried the last failed or stalled step.',
    expected_transition: 'Automatic retry at the scheduled due time'
  },
  [REASON_CODES.operatorClearAutomationFault]: {
    reason_code: REASON_CODES.operatorClearAutomationFault,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Monitor the redispatched run'],
    label: 'Operator Cleared Automation Fault',
    headline: 'Automation fault was cleared by an operator',
    detail: 'An operator cleared a no-progress automation fault and requested redispatch.',
    expected_transition: 'Fresh dispatch starts when runtime safety gates pass'
  },
  [REASON_CODES.turnTimeout]: {
    reason_code: REASON_CODES.turnTimeout,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Monitor the retry; inspect Codex turn logs if the same reason repeats'],
    label: 'Turn Timeout',
    headline: 'Codex turn deadline expired',
    detail: 'The Codex turn exceeded the configured hard wall-clock turn timeout before terminal evidence arrived.',
    expected_transition: 'Automatic retry if the issue remains eligible'
  },
  [REASON_CODES.turnInputRequired]: {
    reason_code: REASON_CODES.turnInputRequired,
    classification: 'awaiting_input',
    actionability: 'required',
    recommended_actions: ['Open the issue detail and answer the pending input request'],
    label: 'Turn Input Required',
    headline: 'Run is awaiting operator input',
    detail: 'Codex requested input that requires an operator response.',
    expected_transition: 'Run continues after input is submitted'
  },
  [REASON_CODES.turnWaitingThresholdExceeded]: {
    reason_code: REASON_CODES.turnWaitingThresholdExceeded,
    classification: 'stalled_waiting',
    actionability: 'required',
    recommended_actions: ['Inspect issue diagnostics', 'Cancel the current turn', 'Requeue the run'],
    label: 'Turn Waiting Threshold Exceeded',
    headline: 'Run is alive but waiting too long',
    detail: 'The run is still alive through codex.turn.waiting heartbeats after the configured wait threshold.',
    expected_transition:
      'Automatic recovery may schedule a retry; otherwise the operator can cancel the current turn or requeue.'
  },
  [REASON_CODES.missingToolOutput]: {
    reason_code: REASON_CODES.missingToolOutput,
    classification: 'blocked_input',
    actionability: 'required',
    recommended_actions: ['Inspect the Codex thread', 'Resume the blocked run', 'Cancel the blocked run'],
    label: 'Missing Tool Output',
    headline: 'Run is blocked on missing tool output',
    detail: 'Codex emitted a tool call but Symphony did not observe the matching tool output before the wait threshold.',
    expected_transition: null
  },
  [REASON_CODES.missingToolOutputRecoveryInterrupted]: {
    reason_code: REASON_CODES.missingToolOutputRecoveryInterrupted,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Monitor the guarded recovery turn'],
    label: 'Missing Tool Output Recovery Interrupted',
    headline: 'Run is starting guarded recovery',
    detail: 'The stalled turn was interrupted so Symphony can resume the same Codex thread with a guarded recovery prompt.',
    expected_transition: 'A same-thread guarded recovery turn starts'
  },
  [REASON_CODES.missingToolOutputRecoveryExhausted]: {
    reason_code: REASON_CODES.missingToolOutputRecoveryExhausted,
    classification: 'blocked_input',
    actionability: 'required',
    recommended_actions: ['Inspect external state for the last tool action', 'Manually resume the Codex thread with guarded continuation', 'Cancel or requeue after inspection'],
    label: 'Missing Tool Output Recovery Exhausted',
    headline: 'Run is blocked after recovery was exhausted',
    detail: 'Automatic missing-tool-output recovery already reached its configured attempt limit.',
    expected_transition: null
  },
  [REASON_CODES.missingToolOutputRecoveryStartFailed]: {
    reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed,
    classification: 'blocked_input',
    actionability: 'required',
    recommended_actions: ['Inspect thread/turn/session ids', 'Manually resume the Codex thread with guarded continuation', 'Cancel or requeue after inspection'],
    label: 'Missing Tool Output Recovery Start Failed',
    headline: 'Run is blocked because recovery could not start',
    detail: 'Symphony could not start a same-thread guarded recovery turn for the stalled tool call.',
    expected_transition: null
  },
  [REASON_CODES.missingToolOutputRecoveryUnsafe]: {
    reason_code: REASON_CODES.missingToolOutputRecoveryUnsafe,
    classification: 'blocked_input',
    actionability: 'required',
    recommended_actions: ['Inspect external state for the last tool action', 'Decide whether the action applied before retrying', 'Manually resume, cancel, or requeue after inspection'],
    label: 'Missing Tool Output Recovery Unsafe',
    headline: 'Run is blocked on ambiguous recovery state',
    detail: 'The recovering agent reported that the indeterminate tool action could not be verified safely.',
    expected_transition: null
  },
  [REASON_CODES.workerHandleMissing]: {
    reason_code: REASON_CODES.workerHandleMissing,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Inspect worker lifecycle state', 'Confirm the active worker handle before retrying termination'],
    label: 'Worker Handle Missing',
    headline: 'Worker termination could not inspect a valid handle',
    detail: 'The orchestrator attempted worker termination but the handle did not include the required identity fields.',
    expected_transition: null
  },
  [REASON_CODES.workerCancelFailed]: {
    reason_code: REASON_CODES.workerCancelFailed,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Inspect worker cancellation logs', 'Verify whether the worker process is still running'],
    label: 'Worker Cancel Failed',
    headline: 'Worker cancellation failed',
    detail: 'The worker cancellation operation threw before a safe interruption outcome could be confirmed.',
    expected_transition: null
  },
  [REASON_CODES.workerCancelUnsupported]: {
    reason_code: REASON_CODES.workerCancelUnsupported,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Inspect worker handle origin', 'Use a runner that supports cancellation before automatic recovery'],
    label: 'Worker Cancel Unsupported',
    headline: 'Worker cancellation is unsupported',
    detail: 'The worker handle did not expose the cancellation contract required to safely interrupt the active worker.',
    expected_transition: null
  },
  [REASON_CODES.workerCancelGracefulExit]: {
    reason_code: REASON_CODES.workerCancelGracefulExit,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Worker Cancel Graceful Exit',
    headline: 'Worker exited after graceful cancellation',
    detail: 'The worker process exited after the cancellation request without requiring forced kill.',
    expected_transition: 'The orchestrator may continue with the stop or recovery path that requested cancellation'
  },
  [REASON_CODES.workerCancelForcedKillExited]: {
    reason_code: REASON_CODES.workerCancelForcedKillExited,
    classification: 'healthy',
    actionability: 'recommended',
    recommended_actions: ['Review cancellation logs for repeated forced-kill patterns'],
    label: 'Worker Cancel Forced Kill Exited',
    headline: 'Worker exited after forced kill',
    detail: 'Graceful cancellation did not settle in time, but the forced kill request confirmed process exit.',
    expected_transition: 'The orchestrator may continue with the stop or recovery path that requested cancellation'
  },
  [REASON_CODES.workerCancelForcedKillUnconfirmed]: {
    reason_code: REASON_CODES.workerCancelForcedKillUnconfirmed,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Inspect host process table', 'Manually verify whether the worker process is still alive'],
    label: 'Worker Cancel Forced Kill Unconfirmed',
    headline: 'Forced kill did not confirm worker exit',
    detail: 'The worker required forced kill, but process exit was not confirmed within the cancellation settle window.',
    expected_transition: null
  },
  [REASON_CODES.workerCancelRequested]: {
    reason_code: REASON_CODES.workerCancelRequested,
    classification: 'stalled_waiting',
    actionability: 'required',
    recommended_actions: ['Inspect worker process state', 'Wait for or manually confirm worker exit'],
    label: 'Worker Cancel Requested',
    headline: 'Worker cancellation was requested',
    detail: 'Cancellation was requested but the runtime did not provide confirmed settlement evidence.',
    expected_transition: null
  },
  [REASON_CODES.workerCancelSettledWithoutOutcome]: {
    reason_code: REASON_CODES.workerCancelSettledWithoutOutcome,
    classification: 'healthy',
    actionability: 'recommended',
    recommended_actions: ['Upgrade runner cancellation reporting if graceful/forced detail is needed'],
    label: 'Worker Cancel Settled Without Outcome',
    headline: 'Worker settled after cancellation',
    detail: 'The worker settled after cancellation, but the runner did not report whether the exit was graceful or forced.',
    expected_transition: 'The orchestrator may continue when settlement is sufficient for the stop path'
  },
  [REASON_CODES.workerCancelUnknown]: {
    reason_code: REASON_CODES.workerCancelUnknown,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Inspect worker process state', 'Do not start automatic recovery until interruption is confirmed'],
    label: 'Worker Cancel Unknown',
    headline: 'Worker cancellation outcome is unknown',
    detail: 'The worker cancellation request did not produce enough evidence to confirm safe interruption.',
    expected_transition: null
  },
  [REASON_CODES.workspaceCleanupFailed]: {
    reason_code: REASON_CODES.workspaceCleanupFailed,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Inspect workspace cleanup logs', 'Manually clean or preserve the workspace before retrying'],
    label: 'Workspace Cleanup Failed',
    headline: 'Workspace cleanup failed',
    detail: 'Worker cancellation may have settled, but the requested workspace cleanup did not succeed.',
    expected_transition: null
  },
  [REASON_CODES.operatorWorkspaceConflict]: {
    reason_code: REASON_CODES.operatorWorkspaceConflict,
    classification: 'blocked_input',
    actionability: 'required',
    recommended_actions: ['Resolve workspace git conflicts', 'Resume or cancel the blocked run'],
    label: 'Workspace Conflict',
    headline: 'Run is blocked on operator input',
    detail: 'The orchestrator paused this run until an operator resolves the workspace conflict.',
    expected_transition: null
  },
  [REASON_CODES.workspaceAttemptResidueRecovered]: {
    reason_code: REASON_CODES.workspaceAttemptResidueRecovered,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Inspect dirty workspace diff', 'Run required validation', 'Commit only ticket-scoped residue'],
    label: 'Workspace Attempt Residue Recovered',
    headline: 'Run is continuing from previous attempt residue',
    detail: 'A managed issue workspace contained recoverable non-ephemeral residue from a prior attempt, so redispatch continues with explicit validation instructions.',
    expected_transition: 'Worker validates and finalizes the carried-forward workspace state'
  },
  [REASON_CODES.operatorNoProgressRedispatchBlocked]: {
    reason_code: REASON_CODES.operatorNoProgressRedispatchBlocked,
    classification: 'failed',
    actionability: 'recommended',
    recommended_actions: ['Inspect no-progress diagnostics', 'Commit progress before redispatch', 'Cancel and return to backlog'],
    label: 'No Progress Redispatch Blocked',
    headline: 'Redispatch stopped after no progress',
    detail: 'Completion gate stopped redispatch because no progress signal was detected; no answerable input payload is pending.',
    expected_transition: null
  },
  [REASON_CODES.agentReviewHandoffProgressObserved]: {
    reason_code: REASON_CODES.agentReviewHandoffProgressObserved,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Agent Review Handoff Progress Observed',
    headline: 'Review handoff progress was recovered',
    detail: 'Tracker-side Agent Review handoff progress was observed before stalled-wait cleanup.',
    expected_transition: 'Cleanup completes and dispatch follows the current tracker state'
  },
  [REASON_CODES.noProgressBlockSuppressed]: {
    reason_code: REASON_CODES.noProgressBlockSuppressed,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'No Progress Block Suppressed',
    headline: 'No-progress block suppressed',
    detail: 'The progress classifier found tracker-side progress, so the no-progress circuit breaker did not block redispatch.',
    expected_transition: 'Redispatch continues according to tracker state'
  },
  [REASON_CODES.staleBlockedInputCleared]: {
    reason_code: REASON_CODES.staleBlockedInputCleared,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Stale Blocked Input Cleared',
    headline: 'Stale blocked input latch was cleared',
    detail: 'A no-progress blocked-input latch without pending input was cleared because tracker state is actionable.',
    expected_transition: 'Normal dispatch can resume'
  },
  [REASON_CODES.freshDispatchAfterReviewHandoff]: {
    reason_code: REASON_CODES.freshDispatchAfterReviewHandoff,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Fresh Dispatch After Review Handoff',
    headline: 'Fresh implementation dispatch started',
    detail: 'A fresh worker was dispatched after recovered Agent Review handoff progress.',
    expected_transition: 'The issue continues in a new worker for the current tracker state'
  },
  [REASON_CODES.operatorBudgetLimitExceeded]: {
    reason_code: REASON_CODES.operatorBudgetLimitExceeded,
    classification: 'blocked_input',
    actionability: 'required',
    recommended_actions: ['Increase budget and resume', 'Cancel and return to backlog'],
    label: 'Budget Limit Exceeded',
    headline: 'Run is blocked on operator input',
    detail: 'The run exceeded the configured budget and requires manual resume.',
    expected_transition: null
  },
  [REASON_CODES.attemptTerminatedBudgetLimitExceeded]: {
    reason_code: REASON_CODES.attemptTerminatedBudgetLimitExceeded,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Review the budget policy and restart after resolving the cause'],
    label: 'Budget Limit Terminated Attempt',
    headline: 'Run failed',
    detail: 'The run exceeded the configured budget and the budget policy terminated the attempt.',
    expected_transition: null
  },
  [REASON_CODES.unsupportedDynamicToolConsoleResume]: {
    reason_code: REASON_CODES.unsupportedDynamicToolConsoleResume,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: [DYNAMIC_TOOL_CONSOLE_RECOVERY_ACTION],
    label: 'Unsupported Console Dynamic Tool Resume',
    headline: 'Console resume cannot run dynamic tools',
    detail:
      'A Symphony-originated dynamic-tool session was continued from a console/TUI environment that rejected dynamic tool execution.',
    expected_transition: null
  },
  [REASON_CODES.awaitingHumanReviewScopeIncomplete]: {
    reason_code: REASON_CODES.awaitingHumanReviewScopeIncomplete,
    classification: 'blocked_input',
    actionability: 'required',
    recommended_actions: ['Complete scope or provide an explicit resume override'],
    label: 'Awaiting Human Review (Scope Incomplete)',
    headline: 'Run is blocked on operator input',
    detail: 'PR is open but scope is incomplete and no progress signal was detected.',
    expected_transition: null
  },
  [REASON_CODES.issueStateRefreshFailed]: {
    reason_code: REASON_CODES.issueStateRefreshFailed,
    classification: 'retrying',
    actionability: 'recommended',
    recommended_actions: ['Inspect tracker connectivity and confirm the Linear issue state before requeueing'],
    label: 'Issue State Refresh Failed',
    headline: 'Tracker refresh failed after run activity',
    detail:
      'The Codex turn completed and reached post-run tracker refresh, but Symphony could not refresh the issue state from Linear before deciding the next workflow step. The scheduled retry refreshes tracker state without rerunning the completed turn.',
    expected_transition: 'Automatic tracker refresh retry at the scheduled due time'
  },
  [REASON_CODES.unsafeWorkspaceRoot]: {
    reason_code: REASON_CODES.unsafeWorkspaceRoot,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Inspect workspace configuration and restart after resolving the cause'],
    label: 'Unsafe Workspace Root',
    headline: 'Run failed',
    detail: 'The worker reported an unsafe workspace root.',
    expected_transition: null
  },
  [REASON_CODES.workspaceEmpty]: {
    reason_code: REASON_CODES.workspaceEmpty,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Inspect workspace provisioning and restart after resolving the cause'],
    label: 'Workspace Empty',
    headline: 'Run failed',
    detail: 'The worker reported an empty workspace.',
    expected_transition: null
  },
  [REASON_CODES.unsupportedApprovalServerRequest]: {
    reason_code: REASON_CODES.unsupportedApprovalServerRequest,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Update the approval server-request allowlist or reject the upstream method as unsupported'],
    label: 'Unsupported Approval Server Request',
    headline: 'Runner rejected an unsupported approval protocol request',
    detail:
      'The Codex app-server emitted an approval-like server request that is not in the explicit Symphony approval allowlist.',
    expected_transition: null
  },
  [REASON_CODES.unsupportedServerRequest]: {
    reason_code: REASON_CODES.unsupportedServerRequest,
    classification: 'failed',
    actionability: 'recommended',
    recommended_actions: ['Inspect the app-server method and add explicit support only when Symphony can answer it safely'],
    label: 'Unsupported Server Request',
    headline: 'Runner rejected an unsupported protocol request',
    detail: 'The Codex app-server emitted a request method that Symphony does not support.',
    expected_transition: null
  },
  [REASON_CODES.unsupportedPermissionServerRequest]: {
    reason_code: REASON_CODES.unsupportedPermissionServerRequest,
    classification: 'blocked_input',
    actionability: 'required',
    recommended_actions: ['Add an explicit permission-grant policy or keep the request rejected as unsupported'],
    label: 'Unsupported Permission Server Request',
    headline: 'Runner blocked an unsupported permission protocol request',
    detail:
      'The Codex app-server requested permission approval, but Symphony has no supported permission-grant policy for this request.',
    expected_transition: null
  },
  [REASON_CODES.unsupportedAuthenticationServerRequest]: {
    reason_code: REASON_CODES.unsupportedAuthenticationServerRequest,
    classification: 'blocked_input',
    actionability: 'required',
    recommended_actions: ['Authenticate outside the runner or add an explicit supported authentication policy'],
    label: 'Unsupported Authentication Server Request',
    headline: 'Runner blocked an unsupported authentication protocol request',
    detail:
      'The Codex app-server requested authentication handling, but Symphony must not fabricate credentials or report success.',
    expected_transition: null
  },
  [REASON_CODES.unsupportedAccountServerRequest]: {
    reason_code: REASON_CODES.unsupportedAccountServerRequest,
    classification: 'blocked_input',
    actionability: 'required',
    recommended_actions: ['Handle account-token requests through an explicit supported policy before enabling this path'],
    label: 'Unsupported Account Server Request',
    headline: 'Runner blocked an unsupported account protocol request',
    detail:
      'The Codex app-server requested account or token handling, but Symphony has no supported credential response for it.',
    expected_transition: null
  },
  [REASON_CODES.unsupportedSafetySensitiveServerRequest]: {
    reason_code: REASON_CODES.unsupportedSafetySensitiveServerRequest,
    classification: 'blocked_input',
    actionability: 'required',
    recommended_actions: ['Classify the request explicitly before allowing the runner to answer it'],
    label: 'Unsupported Safety-Sensitive Server Request',
    headline: 'Runner blocked an unsupported safety-sensitive protocol request',
    detail:
      'The Codex app-server emitted a safety-sensitive request that is not in Symphony’s supported request policy.',
    expected_transition: null
  },
  [REASON_CODES.codexProtocolWarning]: {
    reason_code: REASON_CODES.codexProtocolWarning,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Codex Protocol Warning',
    headline: 'Codex emitted a warning',
    detail: 'The Codex app-server emitted a generic warning notification that was preserved as runner evidence.',
    expected_transition: 'Run continues while warning evidence is available for diagnostics'
  },
  [REASON_CODES.codexProtocolGuardianWarning]: {
    reason_code: REASON_CODES.codexProtocolGuardianWarning,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Codex Guardian Warning',
    headline: 'Codex guardian emitted a warning',
    detail: 'The Codex app-server emitted a guardian warning notification that was preserved as runner evidence.',
    expected_transition: 'Run continues while warning evidence is available for diagnostics'
  },
  [REASON_CODES.codexProtocolDeprecationNotice]: {
    reason_code: REASON_CODES.codexProtocolDeprecationNotice,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Codex Deprecation Notice',
    headline: 'Codex emitted a deprecation notice',
    detail: 'The Codex app-server emitted a deprecation notice that was preserved as runner evidence.',
    expected_transition: 'Run continues while warning evidence is available for diagnostics'
  },
  [REASON_CODES.codexProtocolConfigWarning]: {
    reason_code: REASON_CODES.codexProtocolConfigWarning,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Codex Config Warning',
    headline: 'Codex emitted a config warning',
    detail: 'The Codex app-server emitted a config warning notification that was preserved as runner evidence.',
    expected_transition: 'Run continues while warning evidence is available for diagnostics'
  },
  [REASON_CODES.codexModelRerouted]: {
    reason_code: REASON_CODES.codexModelRerouted,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Codex Model Rerouted',
    headline: 'Codex selected a different effective model',
    detail: 'The Codex app-server reported a model reroute and the runner preserved requested and effective model evidence.',
    expected_transition: 'Run continues with effective model evidence available for diagnostics'
  },
  [REASON_CODES.claudeModelObserved]: {
    reason_code: REASON_CODES.claudeModelObserved,
    classification: 'healthy',
    actionability: 'recommended',
    recommended_actions: ['Confirm the observed Claude model is acceptable for the configured runtime policy'],
    label: 'Claude Model Observed',
    headline: 'Claude reported an additional effective model',
    detail: 'Terminal provider usage reported positive usage for a Claude model other than the primary effective model.',
    expected_transition: 'The invocation remains terminal while model rerouting is visible in provider telemetry'
  },
  [REASON_CODES.claudePermissionDenied]: {
    reason_code: REASON_CODES.claudePermissionDenied,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Inspect the Claude sandbox policy and requested operation before retrying'],
    label: 'Claude Permission Denied',
    headline: 'Claude reported a denied operation',
    detail: 'The Claude runtime permission layer denied an operation during unattended execution.',
    expected_transition: null
  },
  [REASON_CODES.claudeSandboxRuntimeFailed]: {
    reason_code: REASON_CODES.claudeSandboxRuntimeFailed,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Run Symphony doctor and repair the reported Claude sandbox failure before retrying'],
    label: 'Claude Sandbox Runtime Failed',
    headline: 'Claude could not start or retain its supervised sandbox',
    detail: 'The Claude runtime stopped after its host sandbox preflight or a sandboxed Bash operation failed containment setup.',
    expected_transition: null
  },
  [REASON_CODES.reviewApprovalOutcomeInvalid]: {
    reason_code: REASON_CODES.reviewApprovalOutcomeInvalid,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Rerun a fresh Agent Review and require the installed review finalization command'],
    label: 'Review Outcome Invalid',
    headline: 'Agent Review did not produce a valid supervisor request',
    detail: 'The provider completed, but its terminal review envelope was missing, malformed, duplicated, or did not match the supervised attempt.',
    expected_transition: 'Issue remains in Agent Review until a fresh valid review completes'
  },
  [REASON_CODES.reviewApprovalContextMismatch]: {
    reason_code: REASON_CODES.reviewApprovalContextMismatch,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Refresh the PR and rerun Agent Review on the exact current head'],
    label: 'Review Context Mismatch',
    headline: 'Reviewed evidence no longer matches live state',
    detail: 'The supervisor rejected the request because issue, PR, head, checks, feedback, workspace, or receipt evidence changed or was ambiguous.',
    expected_transition: 'Issue remains in Agent Review pending a fresh exact-head review'
  },
  [REASON_CODES.reviewApprovalCredentialsInvalid]: {
    reason_code: REASON_CODES.reviewApprovalCredentialsInvalid,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Fix the reviewer GitHub App configuration and rerun symphony doctor'],
    label: 'Reviewer Credentials Invalid',
    headline: 'Supervisor reviewer identity is not ready',
    detail: 'The reviewer App key, installation, repository association, permissions, or identity separation did not validate.',
    expected_transition: 'Issue remains in Agent Review until operator configuration is repaired'
  },
  [REASON_CODES.reviewApprovalGithubFailed]: {
    reason_code: REASON_CODES.reviewApprovalGithubFailed,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Inspect GitHub availability and App permissions, then retry the supervisor gate'],
    label: 'Reviewer GitHub Request Failed',
    headline: 'GitHub App approval could not complete',
    detail: 'The supervisor could not validate, submit, or query the exact-head GitHub review.',
    expected_transition: 'Issue remains in Agent Review; no Human Review fallback is used'
  },
  [REASON_CODES.reviewApprovalReadbackFailed]: {
    reason_code: REASON_CODES.reviewApprovalReadbackFailed,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Inspect the exact-head App review and Linear state before retrying'],
    label: 'Review Approval Readback Failed',
    headline: 'Supervisor action could not be confirmed',
    detail: 'An approval or route may have succeeded, but the required exact-state readback did not confirm it.',
    expected_transition: 'Supervisor reconciliation reuses confirmed work or leaves the issue in Agent Review'
  },
  [REASON_CODES.reviewApprovalSupervisorUnavailable]: {
    reason_code: REASON_CODES.reviewApprovalSupervisorUnavailable,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Restore the Symphony supervisor and durable history store, then rerun Agent Review'],
    label: 'Review Supervisor Unavailable',
    headline: 'Supervisor review gate is unavailable',
    detail: 'The post-turn coordinator or its required durable capability was unavailable.',
    expected_transition: 'Issue remains in Agent Review'
  },
  [REASON_CODES.projectHistorySchemaHealthUnavailable]: {
    reason_code: REASON_CODES.projectHistorySchemaHealthUnavailable,
    classification: 'failed',
    actionability: 'recommended',
    recommended_actions: ['Inspect persistence diagnostics before relying on project history completeness'],
    label: 'Project History Schema Health Unavailable',
    headline: 'Project history health is unavailable',
    detail: 'The Project History API could not read schema health while projecting ticket history.',
    expected_transition: null
  },
  [REASON_CODES.projectHistoryTrackerSnapshotMissing]: {
    reason_code: REASON_CODES.projectHistoryTrackerSnapshotMissing,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Project History Tracker Snapshot Missing',
    headline: 'Tracker snapshot is missing',
    detail: 'The ticket history exists, but no tracker status snapshot has been recorded for this ticket.',
    expected_transition: 'Future tracker observations may fill this fact'
  },
  [REASON_CODES.projectHistoryTerminalOutcomeMissing]: {
    reason_code: REASON_CODES.projectHistoryTerminalOutcomeMissing,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Project History Terminal Outcome Missing',
    headline: 'Terminal outcome is missing',
    detail: 'The ticket history exists, but no terminal outcome fact has been recorded for this ticket.',
    expected_transition: 'The ticket may still be active or awaiting a terminal write'
  },
  [REASON_CODES.projectHistoryThreadTurnReferencesMissing]: {
    reason_code: REASON_CODES.projectHistoryThreadTurnReferencesMissing,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Project History Thread References Missing',
    headline: 'Thread or turn references are missing',
    detail: 'The ticket history exists, but no thread or turn references were recorded for this ticket.',
    expected_transition: 'Future execution graph writes may fill this fact'
  },
  [REASON_CODES.projectHistoryEvidenceReferencesMissing]: {
    reason_code: REASON_CODES.projectHistoryEvidenceReferencesMissing,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Project History Evidence Missing',
    headline: 'Evidence references are missing',
    detail: 'The ticket history exists, but no validation or review evidence references were recorded for this ticket.',
    expected_transition: 'Future validation evidence writes may fill this fact'
  },
  [REASON_CODES.projectHistoryOperationalFactsMissing]: {
    reason_code: REASON_CODES.projectHistoryOperationalFactsMissing,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Project History Operational Facts Missing',
    headline: 'Tracker, PR, or operator facts are missing',
    detail: 'The ticket history exists, but tracker snapshots, PR references, and operator action facts are not available for this ticket.',
    expected_transition: 'Future operational fact writes may fill this fact'
  },
  [REASON_CODES.projectHistoryTokenModelSummariesMissing]: {
    reason_code: REASON_CODES.projectHistoryTokenModelSummariesMissing,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Project History Token Model Summaries Missing',
    headline: 'Token or model summaries are missing',
    detail: 'The ticket history exists, but token and model summaries were not recorded for this ticket.',
    expected_transition: 'Future app-server-lite or runner telemetry writes may fill this fact'
  },
  [REASON_CODES.projectHistoryAppServerLiteSummariesMissing]: {
    reason_code: REASON_CODES.projectHistoryAppServerLiteSummariesMissing,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Project History App Server Summaries Missing',
    headline: 'App-server-lite summaries are missing',
    detail: 'The ticket history exists, but app-server-lite summary events were not recorded for this ticket.',
    expected_transition: 'Future app-server-lite events may fill this fact'
  },
  [REASON_CODES.projectHistoryAppServerLiteDegraded]: {
    reason_code: REASON_CODES.projectHistoryAppServerLiteDegraded,
    classification: 'failed',
    actionability: 'recommended',
    recommended_actions: ['Inspect app-server-lite payload policy metadata for malformed or full-payload-stored events'],
    label: 'Project History App Server Lite Degraded',
    headline: 'App-server-lite payload policy is degraded',
    detail: 'One or more project history app-server-lite events had malformed payload policy metadata or stored a full payload.',
    expected_transition: 'Future app-server-lite writes should preserve summary-only or redacted payload policy metadata'
  },
  [REASON_CODES.projectHistoryPayloadRedacted]: {
    reason_code: REASON_CODES.projectHistoryPayloadRedacted,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Project History Payload Redacted',
    headline: 'History payload was redacted',
    detail: 'A project history fact is available only through redacted detail because sensitive content was removed.',
    expected_transition: 'No automatic transition; redacted detail is the durable history contract'
  },
  [REASON_CODES.projectHistoryPayloadTruncated]: {
    reason_code: REASON_CODES.projectHistoryPayloadTruncated,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Project History Payload Truncated',
    headline: 'History payload was truncated',
    detail: 'A project history fact is available only through bounded detail because the original payload exceeded excerpt limits.',
    expected_transition: 'No automatic transition; truncated detail is the durable history contract'
  },
  [REASON_CODES.workerEventPressure]: {
    reason_code: REASON_CODES.workerEventPressure,
    classification: 'stalled_waiting',
    actionability: 'recommended',
    recommended_actions: ['Inspect worker-event pressure diagnostics before relying on shell access'],
    label: 'Worker Event Pressure',
    headline: 'Worker event pressure observed',
    detail: 'Multiple active workers are emitting waiting, heartbeat, planning, or rate-limit events while control-plane reads remain bounded.',
    expected_transition: 'State, diagnostics, and SSE snapshots remain available with compact worker-pressure diagnostics'
  },
  [REASON_CODES.liveTokenFallbackNotOnHotPath]: {
    reason_code: REASON_CODES.liveTokenFallbackNotOnHotPath,
    classification: 'failed',
    actionability: 'recommended',
    recommended_actions: ['Inspect worker token telemetry sources or issue-detail diagnostics instead of blocking state polling'],
    label: 'Live Token Fallback Not On Hot Path',
    headline: 'Live token fallback skipped for responsiveness',
    detail:
      'The control-plane projection found missing live token totals but did not synchronously read Codex home state from the request path.',
    expected_transition: 'State and diagnostics remain available while token enrichment is marked degraded'
  },
  [REASON_CODES.stateProjectionUnavailable]: {
    reason_code: REASON_CODES.stateProjectionUnavailable,
    classification: 'failed',
    actionability: 'recommended',
    recommended_actions: ['Inspect control-plane diagnostics and runtime logs for the state projection failure'],
    label: 'State Projection Unavailable',
    headline: 'State projection unavailable',
    detail: 'Diagnostics could not project the current state snapshot and returned degraded enrichment metadata instead.',
    expected_transition: 'Diagnostics remain available while state projection is degraded'
  },
  [REASON_CODES.runtimeUpdateQuiescenceRequired]: {
    reason_code: REASON_CODES.runtimeUpdateQuiescenceRequired,
    classification: 'stalled_waiting',
    actionability: 'required',
    recommended_actions: ['Wait for Drain Mode quiescence before applying the update'],
    label: 'Runtime Update Quiescence Required',
    headline: 'Runtime update is waiting for quiescence',
    detail: 'The guided runtime update refused to apply because blockers still make restart unsafe.',
    expected_transition: 'Apply can be retried after quiescence reports safe_to_shutdown'
  },
  [REASON_CODES.runtimeUpdateDrainModeRequired]: {
    reason_code: REASON_CODES.runtimeUpdateDrainModeRequired,
    classification: 'stalled_waiting',
    actionability: 'required',
    recommended_actions: ['Prepare the guided runtime update so Drain Mode stops new dispatch first'],
    label: 'Runtime Update Drain Mode Required',
    headline: 'Runtime update is waiting for Drain Mode',
    detail: 'The guided runtime update refused to apply because Drain Mode is not active.',
    expected_transition: 'Apply can be retried after Prepare update enters Drain Mode and quiescence is safe'
  },
  [REASON_CODES.runtimeUpdateNotActionable]: {
    reason_code: REASON_CODES.runtimeUpdateNotActionable,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Runtime Update Not Actionable',
    headline: 'Runtime update is not needed',
    detail: 'The guided runtime update refused because readiness is current or otherwise does not require an update action.',
    expected_transition: 'No update transition is needed while readiness remains non-actionable'
  },
  [REASON_CODES.runtimeUpdateNotPrepared]: {
    reason_code: REASON_CODES.runtimeUpdateNotPrepared,
    classification: 'stalled_waiting',
    actionability: 'required',
    recommended_actions: ['Prepare the guided runtime update before applying it'],
    label: 'Runtime Update Not Prepared',
    headline: 'Runtime update has not been prepared',
    detail: 'The guided runtime update refused apply because no actionable prepared update is available in this process.',
    expected_transition: 'Apply can be retried after Prepare update accepts an actionable readiness state'
  },
  [REASON_CODES.runtimeUpdateRepositoryUnavailable]: {
    reason_code: REASON_CODES.runtimeUpdateRepositoryUnavailable,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Inspect runtime update repository configuration'],
    label: 'Runtime Update Repository Unavailable',
    headline: 'Runtime update repository is unavailable',
    detail: 'The guided runtime update could not resolve a safe local repository root for fetch, pull, install, and build.',
    expected_transition: 'Update detection can resume after repository configuration is corrected'
  },
  [REASON_CODES.runtimeUpdateGithubEligibilityRequired]: {
    reason_code: REASON_CODES.runtimeUpdateGithubEligibilityRequired,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Verify GitHub checks or explicitly configure raw git update trust'],
    label: 'Runtime Update GitHub Eligibility Required',
    headline: 'Runtime update candidate is not GitHub verified',
    detail:
      'The guided runtime update refused because the candidate commit is not verified by the configured GitHub eligibility policy.',
    expected_transition:
      'GitHub eligibility becomes verified, checks are explicitly allowed absent, or raw git update trust is configured'
  },
  [REASON_CODES.runtimeUpdateCandidateChanged]: {
    reason_code: REASON_CODES.runtimeUpdateCandidateChanged,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Run Prepare update again to review and accept the new remote candidate'],
    label: 'Runtime Update Candidate Changed',
    headline: 'Runtime update candidate changed after prepare',
    detail:
      'The guided runtime update refused to apply because the fetched remote candidate no longer matches the candidate accepted during Prepare.',
    expected_transition: 'A new Prepare update cycle pins the current remote candidate before Apply can mutate the checkout'
  },
  [REASON_CODES.runtimeUpdateRestartWrapperUnavailable]: {
    reason_code: REASON_CODES.runtimeUpdateRestartWrapperUnavailable,
    classification: 'awaiting_input',
    actionability: 'required',
    recommended_actions: ['Restart Symphony with the provided manual restart command'],
    label: 'Runtime Update Restart Wrapper Unavailable',
    headline: 'Manual restart is required',
    detail: 'The guided runtime update prepared and built the new checkout, but no local restart wrapper is configured.',
    expected_transition: 'The new runtime identity appears after Symphony restarts externally'
  },
  [REASON_CODES.runtimeUpdateRestartSupervisorAvailable]: {
    reason_code: REASON_CODES.runtimeUpdateRestartSupervisorAvailable,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Runtime Update Supervisor Available',
    headline: 'Supervised restart is available',
    detail: 'The local supervisor owns the dashboard child process and can restart it after a guided runtime update.',
    expected_transition: 'Apply update requests a supervisor-backed restart after quiescence'
  },
  [REASON_CODES.runtimeUpdateRestartRequested]: {
    reason_code: REASON_CODES.runtimeUpdateRestartRequested,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Runtime Update Restart Requested',
    headline: 'Supervised restart requested',
    detail: 'The guided runtime update reached the safe boundary and requested child process replacement from the supervisor.',
    expected_transition: 'The supervisor stops the old child and starts a new child from the updated checkout'
  },
  [REASON_CODES.runtimeUpdateRestartDuplicate]: {
    reason_code: REASON_CODES.runtimeUpdateRestartDuplicate,
    classification: 'awaiting_input',
    actionability: 'none',
    recommended_actions: [],
    label: 'Runtime Update Restart Duplicate',
    headline: 'Restart request already in progress',
    detail: 'A duplicate restart request was ignored because the current restart attempt is already active.',
    expected_transition: 'The original restart attempt completes or fails'
  },
  [REASON_CODES.runtimeUpdateRestartSupervisorRefused]: {
    reason_code: REASON_CODES.runtimeUpdateRestartSupervisorRefused,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Restart Symphony manually with npm run start:dashboard'],
    label: 'Runtime Update Restart Supervisor Refused',
    headline: 'Supervised restart was refused',
    detail: 'The supervisor rejected the restart request before replacing the dashboard child process.',
    expected_transition: 'Manual recovery starts Symphony from the updated checkout'
  },
  [REASON_CODES.runtimeUpdateRestartStarted]: {
    reason_code: REASON_CODES.runtimeUpdateRestartStarted,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Runtime Update Restart Started',
    headline: 'Supervised restart started',
    detail: 'The supervisor accepted the restart request and the old child is exiting at the safe boundary.',
    expected_transition: 'A new child starts from the updated checkout'
  },
  [REASON_CODES.runtimeUpdateRestartCompleted]: {
    reason_code: REASON_CODES.runtimeUpdateRestartCompleted,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Runtime Update Restart Completed',
    headline: 'Supervised restart completed',
    detail: 'The replacement child started and exposed the updated runtime identity.',
    expected_transition: 'The dashboard reconnects and shows the runtime as current'
  },
  [REASON_CODES.runtimeUpdateRestartFailed]: {
    reason_code: REASON_CODES.runtimeUpdateRestartFailed,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Restart Symphony manually with npm run start:dashboard and inspect supervisor logs'],
    label: 'Runtime Update Restart Failed',
    headline: 'Supervised restart failed',
    detail: 'The supervisor could not complete child process replacement within the bounded restart contract.',
    expected_transition: 'Manual recovery starts Symphony from the updated checkout'
  },
  [REASON_CODES.runtimeUpdateRestartIdentityMismatch]: {
    reason_code: REASON_CODES.runtimeUpdateRestartIdentityMismatch,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Restart Symphony manually with npm run start:dashboard and verify the checkout commit'],
    label: 'Runtime Update Restart Identity Mismatch',
    headline: 'Restarted runtime does not match update target',
    detail: 'The replacement child started, but its running build identity does not match the guided update target commit.',
    expected_transition: 'Manual recovery starts Symphony from the updated checkout and verifies the runtime identity'
  },
  [REASON_CODES.runtimeUpdateDashboardAssetsVerified]: {
    reason_code: REASON_CODES.runtimeUpdateDashboardAssetsVerified,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Runtime Update Dashboard Assets Verified',
    headline: 'Dashboard assets verified after restart',
    detail: 'The replacement child served the expected dashboard HTML, JavaScript, and CSS asset revision.',
    expected_transition: 'The browser can load the updated dashboard without a manual cache bypass'
  },
  [REASON_CODES.runtimeUpdateDashboardAssetVerificationFailed]: {
    reason_code: REASON_CODES.runtimeUpdateDashboardAssetVerificationFailed,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Restart Symphony manually with npm run start:dashboard and verify dashboard asset responses'],
    label: 'Runtime Update Dashboard Asset Verification Failed',
    headline: 'Restarted dashboard assets did not verify',
    detail: 'The replacement child started, but the local dashboard did not serve the expected asset revision/cache contract.',
    expected_transition: 'Manual recovery verifies the server is serving the updated dashboard build'
  },
  [REASON_CODES.runtimeUpdateReconnectObserved]: {
    reason_code: REASON_CODES.runtimeUpdateReconnectObserved,
    classification: 'healthy',
    actionability: 'none',
    recommended_actions: [],
    label: 'Runtime Update Reconnect Observed',
    headline: 'Dashboard reconnected after restart',
    detail: 'A dashboard event stream connection was observed after supervised restart.',
    expected_transition: 'The restart attempt is complete from the operator perspective'
  },
  [REASON_CODES.unknownRuntimeReason]: {
    reason_code: REASON_CODES.unknownRuntimeReason,
    classification: 'failed',
    actionability: 'required',
    recommended_actions: ['Inspect runtime details and add a canonical reason-code mapping if this is a new known path'],
    label: 'Unknown Runtime Reason',
    headline: 'Run failed',
    detail: 'The runtime emitted a reason that is not in the canonical registry.',
    expected_transition: null
  }
} as const satisfies Record<ReasonCode, ReasonCodeDefinition>;

export function isReasonCode(value: string | null | undefined): value is ReasonCode {
  return Boolean(value && Object.prototype.hasOwnProperty.call(CANONICAL_REASON_CODE_REGISTRY, value));
}

export function getReasonCodeDefinition(value: string | null | undefined): ReasonCodeDefinition | null {
  return isReasonCode(value) ? CANONICAL_REASON_CODE_REGISTRY[value] : null;
}

export function requireReasonCodeDefinition(value: string | null | undefined): ReasonCodeDefinition {
  return getReasonCodeDefinition(value) ?? CANONICAL_REASON_CODE_REGISTRY[REASON_CODES.unknownRuntimeReason];
}

export function listReasonCodeDefinitions(): ReasonCodeDefinition[] {
  return Object.values(CANONICAL_REASON_CODE_REGISTRY).map((definition) => ({ ...definition }));
}

export function listActionRequiredReasonCodes(): ReasonCode[] {
  return listReasonCodeDefinitions()
    .filter((definition) => definition.actionability === 'required')
    .map((definition) => definition.reason_code as ReasonCode);
}
