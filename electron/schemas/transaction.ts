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

// ============================================
// TRANSACTION SCHEMA
// ============================================

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
  status: TransactionStatusSchema,

  // Key Dates
  started_at: OptionalTimestamp,
  closed_at: OptionalTimestamp,
  last_activity_at: OptionalTimestamp,

  // Confidence
  confidence_score: z.number().nullable().optional(),

  // Stage
  stage: TransactionStageSchema.nullable().optional(),
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
  message_count: z.number().int(),
  attachment_count: z.number().int(),
  text_thread_count: z.number().int().nullable().optional(),
  email_count: z.number().int().nullable().optional(),
  text_count: z.number().int().nullable().optional(),

  // Export Tracking
  export_status: ExportStatusSchema,
  export_count: z.number().int(),
  last_exported_at: OptionalTimestamp,
  first_exported_at: OptionalTimestamp, // BACKLOG-2013: freeze marker (first export)

  // Metadata
  metadata: z.string().nullable().optional(), // JSON
  created_at: TimestampSchema,
  updated_at: TimestampSchema,

  // AI Detection Fields
  detection_source: z.enum(['manual', 'auto', 'hybrid']).nullable().optional(),
  detection_status: z.enum(['pending', 'confirmed', 'rejected']).nullable().optional(),
  detection_confidence: z.number().nullable().optional(),
  detection_method: z.string().nullable().optional(),
  suggested_contacts: z.string().nullable().optional(), // JSON
  reviewed_at: OptionalTimestamp,
  rejection_reason: z.string().nullable().optional(),
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
