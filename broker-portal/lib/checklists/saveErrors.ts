/**
 * What a failed checklist save tells the user — BACKLOG-3474.
 *
 * save_checklist_template (supabase/migrations/20260924190429_…sql) raises:
 *   42501 not_authorized      caller may not edit this organization's templates
 *   P0001 stale_or_not_found  the template changed since it was read
 *   P0001 item_mismatch       an item id is repeated or not this template's
 *   22023 invalid_items       not an array of 1..200 objects
 *   23514 / 23502             a field breaks a table CHECK / NOT NULL
 * and PostgREST answers PGRST202 while the function does not exist yet.
 * Each gets its own reason, so "not allowed" and "not deployed" never read as
 * "someone else changed this template".
 */

export type SaveFailureReason =
  | 'not_authorized'
  | 'stale'
  | 'unavailable'
  | 'invalid'
  | 'failed';

export interface SaveFailure {
  ok: false;
  reason: SaveFailureReason;
  message: string;
}

export const SAVE_MESSAGES: Record<SaveFailureReason, string> = {
  not_authorized: "You don't have permission to edit checklist templates.",
  stale: 'This template changed since you opened it. Reload the page to see the latest version.',
  unavailable: 'Saving checklist templates is not available yet. Try again later.',
  invalid: 'Some fields could not be saved. Check the template and try again.',
  failed: 'The template could not be saved. Try again.',
};

export function saveFailure(reason: SaveFailureReason): SaveFailure {
  return { ok: false, reason, message: SAVE_MESSAGES[reason] };
}

/** Map a PostgREST error from rpc('save_checklist_template') to a reason. */
export function reasonForRpcError(error: { code?: string; message?: string } | null | undefined): SaveFailureReason {
  const code = error?.code ?? '';
  const message = error?.message ?? '';
  if (code === 'PGRST202') return 'unavailable';
  if (code === '42501') return 'not_authorized';
  if (message === 'stale_or_not_found') return 'stale';
  if (code === '22023' || code === '23514' || code === '23502' || message === 'item_mismatch') return 'invalid';
  return 'failed';
}
