/**
 * SQL Field Whitelist
 *
 * Centralized validation for field names used in dynamic SQL construction.
 * This provides defense-in-depth against SQL injection if untrusted field names
 * were ever introduced into update operations.
 *
 * Usage:
 *   validateFields("contacts", ["display_name = ?", "company = ?"]);
 *   // or
 *   validateFields("contacts", ["display_name", "company"]);
 */

/**
 * Valid field names for each table that supports dynamic updates.
 * These are the ONLY field names that can be used in SET clauses.
 */
export const TABLE_FIELDS = {
  users_local: new Set([
    "id",
    "email",
    "first_name",
    "last_name",
    "display_name",
    "avatar_url",
    "oauth_provider",
    "oauth_id",
    "subscription_tier",
    "subscription_status",
    "trial_ends_at",
    "is_active",
    "created_at",
    "updated_at",
    "last_login_at",
    "terms_accepted_at",
    "terms_version_accepted",
    "privacy_policy_accepted_at",
    "privacy_policy_version_accepted",
    "timezone",
    "theme",
    "notification_preferences",
    "company",
    "job_title",
    "mobile_phone_type",
    "last_cloud_sync_at",
    "email_onboarding_completed_at",
    // License fields (BACKLOG-426)
    "license_type",
    "ai_detection_enabled",
    "organization_id",
  ]),

  oauth_tokens: new Set([
    "id",
    "user_id",
    "provider",
    "purpose",
    "access_token",
    "refresh_token",
    "token_expires_at",
    "scopes_granted",
    "connected_email_address",
    "mailbox_connected",
    "permissions_granted_at",
    "token_last_refreshed_at",
    "token_refresh_failed_count",
    "last_sync_at",
    "last_sync_error",
    "is_active",
    "created_at",
    "updated_at",
  ]),

  contacts: new Set([
    "id",
    "user_id",
    "display_name",
    "company",
    "title",
    "source",
    "last_inbound_at",
    "last_outbound_at",
    "total_messages",
    "tags",
    "is_imported",
    "default_role",
    "metadata",
    "created_at",
    "updated_at",
  ]),

  transactions: new Set([
    "id",
    "user_id",
    "property_address",
    "property_street",
    "property_city",
    "property_state",
    "property_zip",
    "property_coordinates",
    "transaction_type",
    "status",
    "started_at",
    "closed_at",
    "last_activity_at",
    "confidence_score",
    "stage",
    "stage_source",
    "stage_confidence",
    "stage_updated_at",
    "listing_price",
    "sale_price",
    "earnest_money_amount",
    "mutual_acceptance_date",
    "inspection_deadline",
    "financing_deadline",
    "closing_deadline",
    "message_count",
    "attachment_count",
    "export_status",
    "export_count",
    "last_exported_at",
    "first_exported_at",
    "metadata",
    "created_at",
    "updated_at",
    // Extended fields used in application (from migrations/updates)
    "closing_date_verified",
    "representation_start_confidence",
    "closing_date_confidence",
    "buyer_agent_id",
    "seller_agent_id",
    "escrow_officer_id",
    "inspector_id",
    "other_contacts",
    "export_generated_at",
    "export_format",
    "last_exported_on",
    "communications_scanned",
    "extraction_confidence",
    "first_communication_date",
    "last_communication_date",
    "total_communications_count",
    "earnest_money_delivered_date",
    "other_parties",
    "offer_count",
    "failed_offers_count",
    "key_dates",
    // AI detection fields (Migration 11)
    "detection_source",
    "detection_status",
    "detection_confidence",
    "detection_method",
    "suggested_contacts",
    "reviewed_at",
    "rejection_reason",
    // B2B Submission Tracking (BACKLOG-390)
    "submission_status",
    "submission_id",
    "submitted_at",
    "last_review_notes",
    // BACKLOG-1364: Address filter toggle
    "skip_address_filter",
  ]),

  communications: new Set([
    "id",
    "user_id",
    "transaction_id",
    // TASK-975: Junction table fields
    "message_id",
    "link_source",
    "link_confidence",
    "linked_at",
    // Legacy content fields
    "communication_type",
    "source",
    "sender",
    "recipients",
    "cc",
    "bcc",
    "subject",
    "body",
    "body_plain",
    "sent_at",
    "received_at",
    "has_attachments",
    "attachment_count",
    "attachment_metadata",
    "keywords_detected",
    "parties_involved",
    "communication_category",
    "relevance_score",
    "is_compliance_related",
    "flagged_for_review",
    "created_at",
  ]),

  transaction_contacts: new Set([
    "id",
    "transaction_id",
    "contact_id",
    "role",
    "role_category",
    "specific_role",
    "is_primary",
    "notes",
    "created_at",
    "updated_at",
  ]),
} as const;

/**
 * Type for valid table names that can be validated
 */
export type ValidatableTable = keyof typeof TABLE_FIELDS;

/**
 * Validates that all field names are in the whitelist for the given table.
 *
 * @param table - The table name to validate fields against
 * @param fields - Array of field expressions (e.g., ["display_name = ?", "company = ?"] or ["display_name", "company"])
 * @throws Error if any field is not in the whitelist
 *
 * @example
 * // Validates field names from SET clause expressions
 * validateFields("contacts", ["display_name = ?", "company = ?"]);
 *
 * @example
 * // Validates plain field names
 * validateFields("contacts", ["display_name", "company"]);
 */
export function validateFields(
  table: ValidatableTable,
  fields: string[],
): void {
  const validFields = TABLE_FIELDS[table];

  for (const field of fields) {
    // Extract field name from "field = ?" pattern or use as-is
    const fieldName = field.split(/\s*=/)[0].trim();

    if (!validFields.has(fieldName)) {
      throw new Error(
        `Invalid field "${fieldName}" for table "${table}". ` +
          `This field is not in the allowed whitelist.`,
      );
    }
  }
}

/**
 * Checks if a field is valid for a given table without throwing.
 *
 * @param table - The table name to check against
 * @param fieldName - The field name to check
 * @returns true if the field is valid, false otherwise
 */
export function isValidField(
  table: ValidatableTable,
  fieldName: string,
): boolean {
  return TABLE_FIELDS[table].has(fieldName);
}

/**
 * Gets all valid fields for a table.
 *
 * @param table - The table name
 * @returns Array of valid field names
 */
export function getValidFields(table: ValidatableTable): string[] {
  return Array.from(TABLE_FIELDS[table]);
}
