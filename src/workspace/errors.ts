export class WorkspaceError extends Error {
  readonly code:
    | 'workspace_not_contained'
    | 'workspace_non_directory_collision'
    | 'workspace_cwd_mismatch'
    | 'workspace_hook_failed'
    | 'workspace_hook_timeout'
    | 'workspace_provision_failed'
    | 'workspace_unprovisioned_conflict'
    | 'workspace_integrity_reconcile_failed'
    | 'workspace_sensitive_file_detected'
    | 'workspace_copy_ignored_invalid_config'
    | 'workspace_copy_ignored_denied_path'
    | 'workspace_copy_ignored_limits_exceeded'
    | 'workspace_copy_ignored_source_not_found';

  constructor(
    code:
      | 'workspace_not_contained'
      | 'workspace_non_directory_collision'
      | 'workspace_cwd_mismatch'
      | 'workspace_hook_failed'
      | 'workspace_hook_timeout'
      | 'workspace_provision_failed'
      | 'workspace_unprovisioned_conflict'
      | 'workspace_integrity_reconcile_failed'
      | 'workspace_sensitive_file_detected'
      | 'workspace_copy_ignored_invalid_config'
      | 'workspace_copy_ignored_denied_path'
      | 'workspace_copy_ignored_limits_exceeded'
      | 'workspace_copy_ignored_source_not_found',
    message: string
  ) {
    super(message);
    this.code = code;
  }
}
