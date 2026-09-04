/**
 * Every whitelisted column name, as SQL text — BACKLOG-3085.
 *
 * ## The problem this solves
 *
 * Five writers build `UPDATE <table> SET a = ?, b = ?` from the columns actually
 * supplied, so the column NAMES are chosen at runtime. A column name is an
 * IDENTIFIER: SQLite cannot bind one, so it has to reach the statement as text, and
 * the `sql` tag refuses to splice a `string` — correctly, because it cannot tell a
 * column name from a value.
 *
 * The answer this epic has reached four times is not to escape the splice but to
 * make the wrong thing unrepresentable. Here that means: **the only column names
 * that exist as SQL are the ones on the whitelist**, and they are enumerated, once.
 *
 * ## Why this cannot drift from the schema
 *
 * The `satisfies` below is the whole guarantee. `AnyWhitelistedColumn` is derived
 * from `TABLE_FIELDS`, which `sqlFieldWhitelist.schemaParity.test.ts` derives from
 * `PRAGMA table_info`. So:
 *
 *   - a column added to the schema and to the whitelist and NOT added here is a
 *     COMPILE ERROR, not a runtime surprise;
 *   - a key here that is not a real column is a COMPILE ERROR too;
 *   - and `__tests__/columnSql.test.ts` asserts every value's characters equal its
 *     own key, so an entry cannot silently name a different column than it is filed
 *     under.
 *
 * That is three different failures closed by construction rather than by review.
 *
 * ## What this is NOT
 *
 * It is not a replacement for `validateFields`. That function's runtime loop exists
 * for names arriving from OUTSIDE the type system — an IPC payload, a cast, a
 * `Record<string, unknown>` — and this map cannot see those: a caller that widens a
 * name to `string` before indexing gets `undefined`, not a rejection. The two are
 * complementary and both call sites keep both. See `sqlFieldWhitelist.ts`'s header.
 */
import { joinFragments } from "./sqlFragments";
import { sql, type SafeSql } from "./sqlText";
import { type ColumnOf, type ValidatableTable } from "../../../utils/sqlFieldWhitelist";

/** Every column on any whitelisted table. */
export type AnyWhitelistedColumn = ColumnOf<ValidatableTable>;

/**
 * The enumeration. Keyed by column name across ALL whitelisted tables — names that
 * appear on several tables (`id`, `user_id`, `created_at`) are one entry, because
 * the SQL text of a bare column name does not depend on which table it came from.
 */
export const COLUMN_SQL = {
  access_token: sql`access_token`,
  ai_detection_enabled: sql`ai_detection_enabled`,
  attachment_count: sql`attachment_count`,
  avatar_url: sql`avatar_url`,
  buyer_agent_id: sql`buyer_agent_id`,
  closed_at: sql`closed_at`,
  closing_date_confidence: sql`closing_date_confidence`,
  closing_date_verified: sql`closing_date_verified`,
  closing_deadline: sql`closing_deadline`,
  company: sql`company`,
  confidence_score: sql`confidence_score`,
  connected_email_address: sql`connected_email_address`,
  contact_id: sql`contact_id`,
  created_at: sql`created_at`,
  default_role: sql`default_role`,
  detection_confidence: sql`detection_confidence`,
  detection_method: sql`detection_method`,
  detection_source: sql`detection_source`,
  detection_status: sql`detection_status`,
  display_name: sql`display_name`,
  earnest_money_amount: sql`earnest_money_amount`,
  email: sql`email`,
  email_id: sql`email_id`,
  email_onboarding_completed_at: sql`email_onboarding_completed_at`,
  escrow_officer_id: sql`escrow_officer_id`,
  export_count: sql`export_count`,
  export_format: sql`export_format`,
  export_status: sql`export_status`,
  financing_deadline: sql`financing_deadline`,
  first_exported_at: sql`first_exported_at`,
  first_name: sql`first_name`,
  id: sql`id`,
  inspection_deadline: sql`inspection_deadline`,
  inspector_id: sql`inspector_id`,
  is_active: sql`is_active`,
  is_imported: sql`is_imported`,
  is_primary: sql`is_primary`,
  job_title: sql`job_title`,
  last_activity_at: sql`last_activity_at`,
  last_cloud_sync_at: sql`last_cloud_sync_at`,
  last_exported_at: sql`last_exported_at`,
  last_exported_on: sql`last_exported_on`,
  last_inbound_at: sql`last_inbound_at`,
  last_login_at: sql`last_login_at`,
  last_name: sql`last_name`,
  last_outbound_at: sql`last_outbound_at`,
  last_pending_scan_at: sql`last_pending_scan_at`,
  last_review_notes: sql`last_review_notes`,
  last_sync_at: sql`last_sync_at`,
  last_sync_error: sql`last_sync_error`,
  license_type: sql`license_type`,
  link_confidence: sql`link_confidence`,
  link_source: sql`link_source`,
  linked_at: sql`linked_at`,
  listing_price: sql`listing_price`,
  mailbox_connected: sql`mailbox_connected`,
  match_reason: sql`match_reason`,
  message_count: sql`message_count`,
  message_id: sql`message_id`,
  metadata: sql`metadata`,
  mobile_phone_type: sql`mobile_phone_type`,
  mutual_acceptance_date: sql`mutual_acceptance_date`,
  notes: sql`notes`,
  notification_preferences: sql`notification_preferences`,
  oauth_id: sql`oauth_id`,
  oauth_provider: sql`oauth_provider`,
  organization_id: sql`organization_id`,
  other_contacts: sql`other_contacts`,
  permissions_granted_at: sql`permissions_granted_at`,
  privacy_policy_accepted_at: sql`privacy_policy_accepted_at`,
  privacy_policy_version_accepted: sql`privacy_policy_version_accepted`,
  property_address: sql`property_address`,
  property_city: sql`property_city`,
  property_coordinates: sql`property_coordinates`,
  property_state: sql`property_state`,
  property_street: sql`property_street`,
  property_zip: sql`property_zip`,
  provider: sql`provider`,
  purpose: sql`purpose`,
  refresh_token: sql`refresh_token`,
  rejection_reason: sql`rejection_reason`,
  removed_at: sql`removed_at`,
  removed_reason: sql`removed_reason`,
  representation_start_confidence: sql`representation_start_confidence`,
  representation_start_date: sql`representation_start_date`,
  reviewed_at: sql`reviewed_at`,
  role: sql`role`,
  role_category: sql`role_category`,
  sale_price: sql`sale_price`,
  scopes_granted: sql`scopes_granted`,
  seller_agent_id: sql`seller_agent_id`,
  skip_address_filter: sql`skip_address_filter`,
  source: sql`source`,
  specific_role: sql`specific_role`,
  stage: sql`stage`,
  stage_confidence: sql`stage_confidence`,
  stage_source: sql`stage_source`,
  stage_updated_at: sql`stage_updated_at`,
  started_at: sql`started_at`,
  status: sql`status`,
  submission_id: sql`submission_id`,
  submission_status: sql`submission_status`,
  submitted_at: sql`submitted_at`,
  subscription_status: sql`subscription_status`,
  subscription_tier: sql`subscription_tier`,
  suggested_contacts: sql`suggested_contacts`,
  tags: sql`tags`,
  terms_accepted_at: sql`terms_accepted_at`,
  terms_version_accepted: sql`terms_version_accepted`,
  text_thread_count: sql`text_thread_count`,
  theme: sql`theme`,
  thread_id: sql`thread_id`,
  timezone: sql`timezone`,
  title: sql`title`,
  token_expires_at: sql`token_expires_at`,
  token_last_refreshed_at: sql`token_last_refreshed_at`,
  token_refresh_failed_count: sql`token_refresh_failed_count`,
  total_messages: sql`total_messages`,
  transaction_id: sql`transaction_id`,
  transaction_type: sql`transaction_type`,
  trial_ends_at: sql`trial_ends_at`,
  updated_at: sql`updated_at`,
  user_id: sql`user_id`,} satisfies Record<AnyWhitelistedColumn, SafeSql>;

/**
 * `a, b, c` — a bare column list, for an INSERT's column names.
 */
export function columnList(columns: readonly AnyWhitelistedColumn[]): SafeSql {
  return joinFragments(
    columns.map((c) => COLUMN_SQL[c]),
    sql`, `,
  );
}

/**
 * `a = ?, b = ?` — the SET clause of an UPDATE, one bound parameter per column, in
 * the order given. Replaces `fields.push(`${key} = ?`)` followed by
 * `fields.join(", ")`, and emits the same characters that pair emitted.
 */
export function assignmentList(columns: readonly AnyWhitelistedColumn[]): SafeSql {
  return joinFragments(
    columns.map((c) => sql`${COLUMN_SQL[c]} = ?`),
    sql`, `,
  );
}
