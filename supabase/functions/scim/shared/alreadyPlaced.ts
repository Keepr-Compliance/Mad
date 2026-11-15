/**
 * BACKLOG-4179: the one-brokerage guard's refusal (public._one_brokerage_per_member, trigger
 * single_brokerage_guard): `RAISE EXCEPTION 'already_placed' USING ERRCODE = 'P0001'`.
 * Code AND message.
 *
 * Mirror: broker-portal/lib/auth/alreadyPlaced.ts.
 */
export const ALREADY_PLACED_ERROR = "already_placed";

export function isAlreadyPlacedError(
  err: { code?: string; message?: string } | null | undefined,
): boolean {
  return !!err && err.code === "P0001" && err.message === ALREADY_PLACED_ERROR;
}
