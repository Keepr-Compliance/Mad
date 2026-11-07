/**
 * BACKLOG-4175 (K1): email addresses of contacts on the user's NON-rejected
 * deals, for the sender filter's keep rules. Shared by Learn (baselineRunner,
 * learn:score), the address pass (reviewStateService) and the detector
 * (transactionService), so none of them imports another's module.
 */
import { dbAll } from "./core/dbConnection";
import { sql } from "./core/sqlText";

/**
 * K1: email addresses of contacts on the user's NON-rejected
 * deals. A contact removed from a deal (`removed_at` set) does not count for
 * that deal. Bound: user id.
 */
export const DEAL_CONTACT_EMAILS_SQL = sql`
  SELECT DISTINCT ce.email AS email
  FROM transaction_contacts tc
  JOIN transactions t ON t.id = tc.transaction_id
  JOIN contact_emails ce ON ce.contact_id = tc.contact_id
  WHERE t.user_id = ? AND tc.removed_at IS NULL
    AND NOT (COALESCE(t.status, 'active') = 'rejected' OR COALESCE(t.detection_status, 'confirmed') = 'rejected')
`;

/** Contact emails on the user's non-rejected deals (removed contacts excluded). */
export function listDealContactEmails(userId: string): string[] {
  return dbAll<{ email: string }>(DEAL_CONTACT_EMAILS_SQL, [userId]).map((r) => r.email);
}
