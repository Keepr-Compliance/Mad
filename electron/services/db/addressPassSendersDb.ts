/**
 * BACKLOG-4175: the From line of the address pass's matched emails, so exact
 * sender seeds can be left out before anything is queued for Needs Review.
 *
 * Reads `emails` only, on the main connection, and only for the ids the
 * matcher already returned (worker or main thread). Kept out of
 * addressMatchCandidatesDb.ts on purpose: that module's importers are pinned
 * (reviewStateService.singleReadPath-2791.test.ts) and this read does not
 * belong on the query worker.
 */
import { dbAll } from "./core/dbConnection";
import { sql } from "./core/sqlText";

/** Bound: user id, JSON array of email ids. */
export const ADDRESS_PASS_SENDERS_SQL = sql`
  SELECT id, sender FROM emails
  WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))
`;

export function readAddressPassSenders(
  userId: string,
  emailIds: readonly string[],
): Array<{ id: string; sender: string | null }> {
  if (emailIds.length === 0) return [];
  return dbAll<{ id: string; sender: string | null }>(ADDRESS_PASS_SENDERS_SQL, [userId, JSON.stringify(emailIds)]);
}
