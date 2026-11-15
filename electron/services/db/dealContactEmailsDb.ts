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

/** BACKLOG-4257: the contact roles whose domains are vendor-role domains (lender, mortgage broker, title, escrow). */
export const VENDOR_ROLES = ["lender", "mortgage_broker", "title_company", "escrow_officer"] as const;

/**
 * BACKLOG-4257 (M3, founder D1): email addresses of contacts holding a vendor
 * role (VENDOR_ROLES) on the user's NON-rejected deals; removed contacts
 * excluded. `role` is normalized from `specific_role` on writes, so either
 * column naming the role counts. Bound: user id.
 */
export const DEAL_VENDOR_ROLE_EMAILS_SQL = sql`
  SELECT DISTINCT ce.email AS email
  FROM transaction_contacts tc
  JOIN transactions t ON t.id = tc.transaction_id
  JOIN contact_emails ce ON ce.contact_id = tc.contact_id
  WHERE t.user_id = ? AND tc.removed_at IS NULL
    AND NOT (COALESCE(t.status, 'active') = 'rejected' OR COALESCE(t.detection_status, 'confirmed') = 'rejected')
    AND (lower(COALESCE(tc.specific_role, '')) IN ('lender', 'mortgage_broker', 'title_company', 'escrow_officer')
         OR lower(COALESCE(tc.role, '')) IN ('lender', 'mortgage_broker', 'title_company', 'escrow_officer'))
`;

/** Vendor-role contact emails on the user's non-rejected deals (the caller drops free-mail hosts). */
export function listDealVendorRoleEmails(userId: string): string[] {
  return dbAll<{ email: string }>(DEAL_VENDOR_ROLE_EMAILS_SQL, [userId]).map((r) => r.email);
}
