/**
 * Zod schemas for Transaction-related types.
 *
 * These mirror the interfaces in electron/types/models.ts.
 */
import { z } from 'zod/v4';
import { TimestampSchema, OptionalTimestamp, UuidSchema } from './common';

// ============================================
// ENUM SCHEMAS
// ============================================

export const TransactionTypeSchema = z.enum(['purchase', 'sale', 'other']);
export const TransactionStatusSchema = z.enum(['pending', 'active', 'closed', 'rejected']);
export const ExportStatusSchema = z.enum(['not_exported', 'exported', 're_export_needed']);
export const TransactionStageSchema = z.enum([
  'intro', 'showing', 'offer', 'inspections', 'escrow', 'closing', 'post_closing',
]);
export const SubmissionStatusSchema = z.enum([
  'not_submitted', 'submitted', 'under_review', 'needs_changes',
  'resubmitted', 'approved', 'rejected',
]);
/** Mirrors the `export_format` CHECK in schema.sql's transactions DDL. */
export const ExportFormatSchema = z.enum([
  'pdf', 'csv', 'json', 'txt_eml', 'excel', 'folder',
]);

// ============================================
// TRANSACTION SCHEMA
// ============================================

/**
 * The shape of a `transactions` row as the read paths return it.
 *
 * BACKLOG-2559 — TWO RULES, AND BOTH FAIL SILENTLY IF BROKEN.
 *
 * 1. EVERY COLUMN OF `transactions` MUST BE DECLARED HERE.
 *    `validateResponse` (schemas/validate.ts) parses with a plain, non-strict
 *    `z.object`, which STRIPS unknown keys and returns the stripped copy on
 *    success. An undeclared column is therefore deleted from every row that
 *    validates cleanly, with no error anywhere — the BACKLOG-2532 mechanism
 *    that blanked `removed_reason` until PR #2211 declared it. Measured on
 *    develop @ 0acaa7881, this schema was missing 17 live columns, including
 *    `last_exported_on` (the column the export handlers actually write —
 *    BACKLOG-2109) and `last_pending_scan_at` (the Needs-Review delta
 *    watermark — BACKLOG-2791).
 *
 * 2. NO DECLARATION MAY BE STRICTER THAN ITS COLUMN.
 *    If a column accepts a value that this schema rejects, `safeParse` FAILS,
 *    and `validateResponse` then returns the row unvalidated. Nothing is
 *    stripped and nothing looks wrong — validation has just been switched off
 *    for that row, and only a log line says so. Read the domain off the DDL,
 *    never off what the writers happen to send.
 *
 * ENFORCEMENT — and it is PARTIAL, so read what it does and does not cover.
 * `electron/schemas/__tests__/transactionSchemaParity.test.ts` runs the app's
 * own `runMigrations()` against a real file-backed database and asserts:
 *   - declared keys == `PRAGMA table_info(transactions)`, as exact SETS, in
 *     both directions (rule 1);
 *   - NULL is accepted for every column the database lets be NULL;
 *   - every value a column's CHECK admits is accepted here, and a closed value
 *     domain is declared ONLY where the column actually has a CHECK, with the
 *     enum members equal to the CHECK list as sets;
 *   - a fractional value is accepted for every REAL column.
 *
 * NOT covered: string and numeric REFINEMENTS beyond those probes — a `.min()`,
 * a `.max()`, a length or format constraint would be stricter than its column
 * and nothing here would go red. Do not add one without adding a probe for it.
 *
 * NOTE: this schema is currently wired to NO boundary. `getTransactionByIdSync`
 * returns raw `SELECT t.*` with no validation. That is deliberate — wiring it
 * is a separate, riskier change. The declarations below exist so that whoever
 * does wire it does not amputate the rows.
 */
export const TransactionSchema = z.object({
  id: UuidSchema,
  user_id: UuidSchema,

  // Property Information
  property_address: z.string(),
  property_street: z.string().nullable().optional(),
  property_city: z.string().nullable().optional(),
  property_state: z.string().nullable().optional(),
  property_zip: z.string().nullable().optional(),
  property_coordinates: z.string().nullable().optional(), // JSON

  // Transaction Type & Status
  transaction_type: TransactionTypeSchema.nullable().optional(),
  // `status TEXT DEFAULT 'active' CHECK (...)` — a DEFAULT is not NOT NULL, and
  // an explicit NULL write is legal. Required-and-non-null here would fail
  // safeParse and disable validation for the whole row (rule 2 above).
  status: TransactionStatusSchema.nullable(),

  // Key Dates
  started_at: OptionalTimestamp,
  closed_at: OptionalTimestamp,
  last_activity_at: OptionalTimestamp,
  representation_start_date: OptionalTimestamp, // DATE, nullable
  // `INTEGER DEFAULT 0` used as a boolean. Same union idiom as ContactSchema's
  // `is_message_derived`: SQLite hands back 0/1, callers may set true/false.
  closing_date_verified: z.union([z.number(), z.boolean()]).nullable().optional(),

  // Date Confidence
  representation_start_confidence: z.number().int().nullable().optional(),
  closing_date_confidence: z.number().int().nullable().optional(),

  // Confidence
  confidence_score: z.number().nullable().optional(),

  // Stage
  // `stage TEXT` — NO CHECK in the DDL, so the database can hand back any
  // string. Declared as a plain string rather than TransactionStageSchema
  // (BACKLOG-2559, SR review of PR #2364): this is a READ boundary describing
  // what the database can PRODUCE, not a policy on what writers may store. A
  // 7-value enum here would turn one unexpected stage into a whole-row
  // validation bypass across all 59 fields — strictly worse than accepting the
  // unexpected string. TransactionStageSchema stays exported and is still the
  // right shape for INPUT validation; giving `stage` a real closed domain means
  // adding a CHECK, which is a migration and out of scope here.
  stage: z.string().nullable().optional(),
  stage_source: z.string().nullable().optional(),
  stage_confidence: z.number().nullable().optional(),
  stage_updated_at: OptionalTimestamp,

  // Financial Data
  listing_price: z.number().nullable().optional(),
  sale_price: z.number().nullable().optional(),
  earnest_money_amount: z.number().nullable().optional(),

  // Key Dates (auto-extracted)
  mutual_acceptance_date: OptionalTimestamp,
  inspection_deadline: OptionalTimestamp,
  financing_deadline: OptionalTimestamp,
  closing_deadline: OptionalTimestamp,

  // Stats
  // message_count / attachment_count / export_count are `INTEGER DEFAULT 0`,
  // i.e. nullable columns — see rule 2.
  message_count: z.number().int().nullable(),
  attachment_count: z.number().int().nullable(),
  text_thread_count: z.number().int().nullable().optional(),
  // NOT a column. Computed by the read path — a COUNT(DISTINCT c.email_id)
  // subquery aliased `email_count` in getTransactionByIdSync and the list
  // SELECT (transactionDbService.ts). Removing it would strip the count the
  // detail view renders, so the parity test allow-lists it BY NAME.
  //
  // `text_count` used to sit here and was removed by BACKLOG-2559: it is
  // neither a column nor computed on any read path, so it could never hold a
  // value. (electron/types/models.ts still declares it as an optional field;
  // the renderer passes it into BulkSubmitModal, which never renders it. Dead
  // plumbing, out of scope here.)
  email_count: z.number().int().nullable().optional(),

  // Export Tracking
  // `export_status TEXT DEFAULT 'not_exported' CHECK (...)` — nullable in DDL.
  export_status: ExportStatusSchema.nullable(),
  export_format: ExportFormatSchema.nullable().optional(),
  export_count: z.number().int().nullable(),
  last_exported_at: OptionalTimestamp, // declared but NOT written by the export path
  // BACKLOG-2109: the column the export handlers actually write and the list
  // SELECT returns. `last_exported_at` above is the decoy. Leaving this
  // undeclared is the concrete harm BACKLOG-2559 was filed for — wiring the
  // schema would blank the real export timestamp on every valid row.
  last_exported_on: OptionalTimestamp,
  first_exported_at: OptionalTimestamp, // BACKLOG-2013: freeze marker (first export)

  // Metadata
  metadata: z.string().nullable().optional(), // JSON
  created_at: TimestampSchema.nullable(), // DATETIME DEFAULT CURRENT_TIMESTAMP, nullable
  updated_at: TimestampSchema.nullable(), // DATETIME DEFAULT CURRENT_TIMESTAMP, nullable

  // AI Detection Fields
  detection_source: z.enum(['manual', 'auto', 'hybrid']).nullable().optional(),
  detection_status: z.enum(['pending', 'confirmed', 'rejected']).nullable().optional(),
  detection_confidence: z.number().nullable().optional(),
  detection_method: z.string().nullable().optional(),
  suggested_contacts: z.string().nullable().optional(), // JSON
  reviewed_at: OptionalTimestamp,
  rejection_reason: z.string().nullable().optional(),

  // Agent/Contact References — plain nullable TEXT holding contact IDs
  buyer_agent_id: z.string().nullable().optional(),
  seller_agent_id: z.string().nullable().optional(),
  escrow_officer_id: z.string().nullable().optional(),
  inspector_id: z.string().nullable().optional(),
  other_contacts: z.string().nullable().optional(), // JSON array of contact IDs

  // B2B Submission Tracking (BACKLOG-390)
  submission_status: SubmissionStatusSchema.nullable().optional(),
  submission_id: z.string().nullable().optional(), // UUID ref to cloud submissions
  submitted_at: OptionalTimestamp,
  last_review_notes: z.string().nullable().optional(),

  // Email Auto-Link Settings (BACKLOG-1364) — `INTEGER DEFAULT 0` as a boolean
  skip_address_filter: z.union([z.number(), z.boolean()]).nullable().optional(),

  // BACKLOG-2791: Needs-Review delta watermark, added by migration v65. Losing
  // it on the read path makes every transaction open re-examine the full
  // window forever — the BACKLOG-2620 non-convergence shape.
  last_pending_scan_at: OptionalTimestamp,
});

export type ValidatedTransaction = z.infer<typeof TransactionSchema>;

// ============================================
// TRANSACTION INPUT SCHEMA (for IPC handler validation)
// ============================================

export const CreateTransactionInputSchema = z.object({
  property_address: z.string().min(1, 'Property address is required'),
  transaction_type: TransactionTypeSchema.optional(),
  status: TransactionStatusSchema.optional(),
  started_at: z.string().optional(),
  listing_price: z.number().optional(),
  sale_price: z.number().optional(),
});

export type CreateTransactionInput = z.infer<typeof CreateTransactionInputSchema>;
