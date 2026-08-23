import type { IncomingMessage } from 'node:http';

import { LocalApiError } from '../errors';

export interface OperatorActionBody {
  actor?: string;
  reason_note?: string;
  confirmed?: boolean;
  resume_override_reason?: string;
  cancel_reason?: string;
}

export async function readOptionalJsonObject(
  request: IncomingMessage,
  errorCode: string
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const payloadText = Buffer.concat(chunks).toString('utf8').trim();
  if (!payloadText) {
    return {};
  }
  try {
    const parsed = JSON.parse(payloadText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LocalApiError(errorCode, 'Request body must be a JSON object', 400);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof LocalApiError) {
      throw error;
    }
    throw new LocalApiError(errorCode, 'Request body must be valid JSON', 400);
  }
}

export function parseOperatorActionBody(payload: Record<string, unknown>): OperatorActionBody {
  return {
    actor: typeof payload.actor === 'string' ? payload.actor.trim() : undefined,
    reason_note: typeof payload.reason_note === 'string' ? payload.reason_note.trim() : undefined,
    confirmed: typeof payload.confirmed === 'boolean' ? payload.confirmed : undefined,
    resume_override_reason: typeof payload.resume_override_reason === 'string'
      ? payload.resume_override_reason.trim()
      : undefined,
    cancel_reason: typeof payload.cancel_reason === 'string' ? payload.cancel_reason.trim() : undefined
  };
}

export function requireOperatorReasonNote(parsed: OperatorActionBody): string {
  if (!parsed.reason_note) {
    throw new LocalApiError('reason_note_required', 'reason_note is required', 400);
  }
  return parsed.reason_note;
}

export function statusForOperatorActionFailure(code: string): number {
  if (code === 'reason_note_required') {
    return 400;
  }
  if (code === 'issue_not_found' || code === 'issue_not_blocked' || code === 'issue_not_automation_fault') {
    return 404;
  }
  if (
    code === 'confirmation_required' ||
    code === 'issue_not_active' ||
    code === 'unsupported_transition' ||
    code === 'automation_fault_active'
  ) {
    return 409;
  }
  if (code.endsWith('_unavailable')) {
    return 503;
  }
  return 422;
}
