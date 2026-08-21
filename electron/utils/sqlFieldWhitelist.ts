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
 *
 * ===========================================================================
 * WHY THIS FILE LOOKS THE WAY IT DOES — BACKLOG-2739 (epic BACKLOG-2738)
 * ===========================================================================
 *
 * **The lists below are ARRAYS, not Sets, and that is load-bearing.**
 *
 * This file previously wrapped each table in `new Set([...])`. The trailing
 * `as const` on the object looked like it preserved the column names as literal
 * types, but `new Set([...])` erases them: what survived was `Set<string>`, and
 * `validateFields(table, fields: string[])` took plain strings. Proven by
 * execution before the change — with tsconfig.json's own settings,
 * `npm run type-check` exited 0 on a file containing:
 *
 *     validateFields("transactions", ["totally_made_up_field"]);
 *     TABLE_FIELDS.transactions.has("this_column_does_not_exist_anywhere");
 *
 * An `as const` array keeps the literals, so `TABLE_FIELDS[T][number]` is a
 * union of real column names and both lines above are now compile errors.
 *
 * **The runtime lookup is still O(1).** `FIELD_SETS` below builds one `Set` per
 * table at module load. The TYPE comes from the array; the LOOKUP comes from the
 * Set. Do not "simplify" `validateFields` to `TABLE_FIELDS[table].includes(...)`
 * — that turns a hot update path into a linear scan over 58 strings.
 *
 * ===========================================================================
 * THE LISTS ARE ENUMERATED FROM A MIGRATED DATABASE, NOT WRITTEN BY HAND
 * ===========================================================================
 *
 * They were, once, and they drifted: **31 of these names existed in no table**
 * (20 on `communications`, 11 on `transactions`) and **8 real columns were
 * absent**. The phantoms were duplicated into `transactionDbService.ts` and
 * `models.ts`, so four artefacts agreed with each other and all four disagreed
 * with the database.
 *
 * The lists below were replaced with the output of `PRAGMA table_info` run
 * against a database built by the app's own init path — `runMigrations()`, i.e.
 * `schema.sql` followed by the full versioned chain — because parts of the DDL
 * are built dynamically inside migrations and are invisible to a text read of
 * `schema.sql`.
 *
 * `sqlFieldWhitelist.schemaParity.test.ts` re-runs that enumeration and fails on
 * any drift in either direction, so the next person does not have to trust this
 * comment. **Do not edit a list here by hand; change the schema and let the
 * parity test tell you what the column set became.**
 *
 * ===========================================================================
 * WHAT THIS FILE STILL DOES NOT DO — Phase 2, BACKLOG-2738
 * ===========================================================================
 *
 * A union of column names catches a MISSPELLED name. It cannot catch an
 * OMITTED one: a writer that lists 13 of 58 columns is a perfectly valid
 * `TransactionColumn[]` while silently discarding an entire feature (that is
 * BACKLOG-2737, and BACKLOG-2558 downstream of it). Making each writer declare
 * an exhaustive `Record<Column, Decision>` is Phase 2 and deliberately not in
 * this file's change.
 */

/**
 * Valid field names for each table that supports dynamic updates.
 * These are the ONLY field names that can be used in SET clauses.
 *
 * Order is physical column order (`PRAGMA table_info` cid order), so a diff
 * against the schema reads straight down.
 *
 * ENUMERATED, NOT AUTHORED. See the header. Regenerate with the parity test.
 */
export const TABLE_FIELDS = {
  users_local: [
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
    // License fields (BACKLOG-426)
    "license_type",
    "ai_detection_enabled",
    "organization_id",
    "email_onboarding_completed_at",
    "last_cloud_sync_at",
  ],

  oauth_tokens: [
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
  ],

  contacts: [
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
    // BACKLOG-2365 tombstones (migration v56). Were MISSING from this list;
    // written today only by hand-built UPDATEs in contactDbService.ts that
    // bypass validateFields entirely.
    "removed_at",
    "removed_reason",
  ],

  transactions: [
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
    // Real column; was MISSING from this list and has no writer at all.
    "representation_start_date",
    "closing_date_verified",
    "representation_start_confidence",
    "closing_date_confidence",
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
    // BACKLOG-396. Was MISSING from this list; written by a hand-built
    // `UPDATE transactions SET text_thread_count = ?` in communicationDbService.
    "text_thread_count",
    "export_status",
    "export_format",
    "export_count",
    "last_exported_at",
    "last_exported_on",
    "first_exported_at",
    // AI detection fields (Migration 11)
    "detection_source",
    "detection_status",
    "detection_confidence",
    "detection_method",
    "suggested_contacts",
    "reviewed_at",
    "rejection_reason",
    "buyer_agent_id",
    "seller_agent_id",
    "escrow_officer_id",
    "inspector_id",
    "other_contacts",
    // B2B Submission Tracking (BACKLOG-390)
    "submission_status",
    "submission_id",
    "submitted_at",
    "last_review_notes",
    // BACKLOG-1364: Address filter toggle
    "skip_address_filter",
    "metadata",
    "created_at",
    "updated_at",
  ],

  /**
   * `communications` is a JUNCTION table — 11 columns, no content.
   *
   * This list previously carried 20 further names (`subject`, `body`, `sender`,
   * `recipients`, `sent_at`, …) under a "Legacy content fields" heading. The
   * table has not had them for a long time; message content lives in `emails` /
   * `messages` and this table only records the link. Every one of those 20 was
   * a phantom.
   */
  communications: [
    "id",
    "user_id",
    "transaction_id",
    // TASK-975: Junction table fields
    "message_id",
    // Real columns; both were MISSING from this list.
    "email_id",
    "thread_id",
    "link_source",
    "link_confidence",
    "linked_at",
    "created_at",
    // BACKLOG-2319: why the email is attached (Needs review vs Linked)
    "match_reason",
  ],

  transaction_contacts: [
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
    // BACKLOG-2366 tombstones. Were MISSING from this list.
    "removed_at",
    "removed_reason",
  ],
} as const;

/**
 * Type for valid table names that can be validated
 */
export type ValidatableTable = keyof typeof TABLE_FIELDS;

/**
 * The union of real column names for a table.
 *
 * This is the type the whole file exists to produce. It is derived from the
 * arrays above, which are derived from `PRAGMA table_info` — so it cannot drift
 * from the schema without the parity test going red.
 */
export type ColumnOf<T extends ValidatableTable> = (typeof TABLE_FIELDS)[T][number];

export type UsersLocalColumn = ColumnOf<"users_local">;
export type OauthTokenColumn = ColumnOf<"oauth_tokens">;
export type ContactColumn = ColumnOf<"contacts">;
export type TransactionColumn = ColumnOf<"transactions">;
export type CommunicationColumn = ColumnOf<"communications">;
export type TransactionContactColumn = ColumnOf<"transaction_contacts">;

/**
 * What `validateFields` accepts for a table: a bare column name, or the
 * `"column = ?"` SET-clause form the callers build.
 *
 * Only the exact `"<column> = ?"` spelling is expressible as a type. Whitespace
 * variants (`"company=?"`, `"  display_name  = ?"`) are still accepted AT
 * RUNTIME — the parser below splits on `=` and trims — they simply cannot be
 * spelled as a literal type. Callers that build such a string at runtime pass a
 * `string[]` and cast; see the five call sites.
 */
export type FieldExpression<C extends string> = C | `${C} = ?`;

/**
 * O(1) membership, one Set per table, built once at module load.
 *
 * `satisfies` makes a missing table a compile error here, so adding a table to
 * `TABLE_FIELDS` cannot silently skip its lookup Set.
 */
const FIELD_SETS = {
  users_local: new Set<string>(TABLE_FIELDS.users_local),
  oauth_tokens: new Set<string>(TABLE_FIELDS.oauth_tokens),
  contacts: new Set<string>(TABLE_FIELDS.contacts),
  transactions: new Set<string>(TABLE_FIELDS.transactions),
  communications: new Set<string>(TABLE_FIELDS.communications),
  transaction_contacts: new Set<string>(TABLE_FIELDS.transaction_contacts),
} satisfies Record<ValidatableTable, ReadonlySet<string>>;

/**
 * Validates that all field names are in the whitelist for the given table.
 *
 * Both a compile-time and a runtime gate, and they catch different things. The
 * TYPE catches a name this codebase spells wrong. The RUNTIME CHECK catches a
 * name that arrived from outside the type system — an IPC payload, a cast, a
 * `Record<string, unknown>` — which is the injection case this function was
 * written for. Neither replaces the other; do not delete the runtime loop
 * because "the types cover it".
 *
 * @param table - The table name to validate fields against
 * @param fields - Field expressions (e.g. ["display_name = ?", "company = ?"] or ["display_name", "company"])
 * @throws Error if any field is not in the whitelist
 *
 * @example
 * validateFields("contacts", ["display_name = ?", "company = ?"]);
 *
 * @example
 * validateFields("contacts", ["display_name", "company"]);
 */
export function validateFields<T extends ValidatableTable>(
  table: T,
  fields: ReadonlyArray<FieldExpression<ColumnOf<T>>>,
): void {
  const validFields: ReadonlySet<string> = FIELD_SETS[table];

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
 * BACKLOG-2741 — THIS FUNCTION IS NEVER CALLED, AND THAT IS THE POINT.
 *
 * ===========================================================================
 * WHAT WENT WRONG
 * ===========================================================================
 * BACKLOG-2739 added an `@ts-expect-error` to prove that a made-up column name
 * is rejected. It pins the `FieldExpression<ColumnOf<T>>` TYPE ALIAS. It does
 * NOT pin `validateFields`' PARAMETER — which is the thing callers actually
 * meet. Measured by SR review of PR #2322: widening the parameter back to
 * `ReadonlyArray<string>` — undoing that PR's entire point — left
 * `npm run type-check` at exit 0, `npm run type-check:tests` at zero errors,
 * and the whitelist suite 28/28 green.
 *
 * A guard that cannot observe its own removal is a convention, not a guard —
 * the same defect class the epic exists to close, in the epic's own first
 * deliverable.
 *
 * ===========================================================================
 * WHY THIS SHAPE
 * ===========================================================================
 * `runtimeName` is typed `string`, not a literal — a plain string is exactly
 * what a widened signature would start accepting. Under the correct (narrow)
 * signature the call is an error, the directive below is used, and the build is
 * green. Widen the parameter and the call becomes legal, so the directive
 * becomes UNNECESSARY — and an unnecessary `@ts-expect-error` is itself a
 * compile error (TS2578). That is what makes the technique self-verifying:
 * the guard fails loudly when the thing it guards is removed.
 *
 * Do not "clean up" this function, do not call it, and do not replace the
 * `string` annotation with a literal.
 */
export function validateFieldsSignatureGuard(): void {
  const runtimeName: string = "a_name_that_arrived_from_outside_the_type_system";
  // @ts-expect-error — validateFields must NOT accept a plain `string`. If this
  // directive ever reports as unused, the parameter has been widened and the
  // compile-time half of the whitelist has stopped working.
  validateFields("transactions", [runtimeName]);
}

/**
 * Checks if a field is valid for a given table without throwing.
 *
 * **Takes `string` on purpose.** This function exists to interrogate a name
 * whose validity is NOT yet known — narrowing the parameter to `ColumnOf<T>`
 * would mean the caller had already proved the thing being asked. It returns a
 * type predicate instead, so a `string` that passes is narrowed to the column
 * union for everything downstream. The compile-time gate lives on
 * `validateFields` and on `TABLE_FIELDS` itself.
 *
 * @param table - The table name to check against
 * @param fieldName - The field name to check
 * @returns true if the field is valid for the table
 */
export function isValidField<T extends ValidatableTable>(
  table: T,
  fieldName: string,
): fieldName is ColumnOf<T> {
  return FIELD_SETS[table].has(fieldName);
}

/**
 * Gets all valid fields for a table.
 *
 * @param table - The table name
 * @returns The table's column names, typed as the column union
 */
export function getValidFields<T extends ValidatableTable>(
  table: T,
): ReadonlyArray<ColumnOf<T>> {
  return TABLE_FIELDS[table];
}
