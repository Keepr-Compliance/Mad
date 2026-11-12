/**
 * Removes Keepr OAuth credentials from text (BACKLOG-4238).
 *
 * Matches 'kpr_' + at|rt|ac|bd + '_' + 43 base64url characters. Loaded by the
 * edge Sentry config, so it must not use Node APIs.
 */

const KPR_CREDENTIAL = /kpr_(?:at|rt|ac|bd)_[A-Za-z0-9_-]{43}/g;

export const REDACTED = '[redacted]';

export function redactKpr(text: string): string {
  return text.replace(KPR_CREDENTIAL, REDACTED);
}
