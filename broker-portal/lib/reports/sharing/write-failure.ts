/**
 * The sentence a REFUSED shared-report write shows (BACKLOG-3513).
 *
 * COPIED from admin-portal/lib/reports/report-views.ts `writeFailureMessage`
 * (BACKLOG-3450). Moved here from lib/reports/saved-views/ when that panel left
 * the broker reports UI (BACKLOG-3513 PR-3c). Both shapes are handled: a
 * PostgrestError (an Error) and a bare `{ message }` object.
 */
export function writeFailureMessage(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string'
        ? (err as { message: string }).message
        : '';
  const message = raw.trim();
  return message.length > 0 ? message : 'That change could not be saved.';
}
