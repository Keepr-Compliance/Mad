/**
 * The sentence a REFUSED saved-view write puts in the Views panel (BACKLOG-3514).
 *
 * COPIED from admin-portal/lib/reports/report-views.ts `writeFailureMessage`
 * (BACKLOG-3450); extract to packages/ui saved-views later with the hook.
 *
 * The server-side pin cap exists for the case the client cannot see (a second
 * tab whose count is stale), so its message is the only thing that explains
 * why a card did not appear. Both shapes are handled: a PostgrestError (an
 * Error) and a bare `{ message }` object.
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
