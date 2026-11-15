/**
 * BACKLOG-4179: the one-brokerage guard's refusal (public._one_brokerage_per_member, trigger
 * single_brokerage_guard): `RAISE EXCEPTION 'already_placed' USING ERRCODE = 'P0001'`.
 * Code AND message, as isBrokerageSuspendedError.
 *
 * Mirror: supabase/functions/scim/shared/alreadyPlaced.ts (the SCIM Edge Function cannot import
 * from broker-portal).
 */
export const ALREADY_PLACED_ERROR = 'already_placed';

export function isAlreadyPlacedError(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && error.code === 'P0001' && error.message === ALREADY_PLACED_ERROR;
}
