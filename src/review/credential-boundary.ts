export const SUPERVISOR_REVIEWER_ENV_NAMES = [
  'SYMPHONY_REVIEWER_APP_ID',
  'SYMPHONY_REVIEWER_INSTALLATION_ID',
  'SYMPHONY_REVIEWER_PRIVATE_KEY',
  'SYMPHONY_REVIEWER_PRIVATE_KEY_PATH'
] as const;

export function stripReviewerCredentials(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  for (const name of SUPERVISOR_REVIEWER_ENV_NAMES) delete sanitized[name];
  return sanitized;
}
