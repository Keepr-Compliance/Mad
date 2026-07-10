/**
 * Zod schemas for Contact-related types.
 *
 * These mirror the interfaces in electron/types/models.ts.
 */
import { z } from 'zod/v4';
import { TimestampSchema, OptionalTimestamp, UuidSchema } from './common';

// ============================================
// ENUM SCHEMAS
// ============================================

export const ContactSourceSchema = z.enum([
  // BACKLOG-1900 (P0.1): distinct per-origin contact sources (adds iphone, android_sync).
  'manual', 'email', 'sms', 'messages', 'contacts_app', 'inferred', 'outlook', 'google_contacts', 'iphone', 'android_sync',
]);

export const ContactInfoSourceSchema = z.enum(['import', 'manual', 'inferred']);

// ============================================
// CONTACT SCHEMA
// ============================================

export const ContactSchema = z.object({
  id: UuidSchema,
  user_id: UuidSchema,

  // Display Info
  display_name: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  title: z.string().nullable().optional(),

  // Source
  source: ContactSourceSchema,

  // Engagement Metrics
  last_inbound_at: OptionalTimestamp,
  last_outbound_at: OptionalTimestamp,
  total_messages: z.number().nullable().optional(),
  tags: z.string().nullable().optional(), // JSON array

  // Auto-role (BACKLOG-1355)
  default_role: z.string().nullable().optional(),

  // Metadata
  metadata: z.string().nullable().optional(), // JSON
  created_at: TimestampSchema,
  updated_at: TimestampSchema,

  // Import status
  is_message_derived: z.union([z.number(), z.boolean()]).nullable().optional(),
  last_communication_at: z.string().nullable().optional(),

  // Array fields (for display -- populated by JOIN)
  allEmails: z.array(z.string()).optional(),
  allPhones: z.array(z.string()).optional(),

  // Legacy fields
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  is_imported: z.union([z.boolean(), z.number()]).nullable().optional(),
});

export type ValidatedContact = z.infer<typeof ContactSchema>;

// ============================================
// CONTACT EMAIL SCHEMA
// ============================================

export const ContactEmailSchema = z.object({
  id: UuidSchema,
  contact_id: UuidSchema,
  email: z.string(),
  is_primary: z.union([z.boolean(), z.number()]),
  label: z.string().nullable().optional(),
  source: ContactInfoSourceSchema.nullable().optional(),
  created_at: TimestampSchema,
});

export type ValidatedContactEmail = z.infer<typeof ContactEmailSchema>;

// ============================================
// CONTACT PHONE SCHEMA
// ============================================

export const ContactPhoneSchema = z.object({
  id: UuidSchema,
  contact_id: UuidSchema,
  phone_e164: z.string(),
  phone_display: z.string().nullable().optional(),
  is_primary: z.union([z.boolean(), z.number()]),
  label: z.string().nullable().optional(),
  source: ContactInfoSourceSchema.nullable().optional(),
  created_at: TimestampSchema,
});

export type ValidatedContactPhone = z.infer<typeof ContactPhoneSchema>;

// ============================================
// CONTACT INPUT SCHEMA (for IPC handler validation)
// ============================================

export const CreateContactInputSchema = z.object({
  display_name: z.string().min(1, 'Contact name is required'),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  source: ContactSourceSchema.optional(),
});

export type CreateContactInput = z.infer<typeof CreateContactInputSchema>;
