/**
 * Expected document types for a checklist item — BACKLOG-3474.
 *
 * Same ten values, in the same order, as the CHECK
 * `checklist_template_items_expected_document_type_check` in
 * supabase/migrations/20260921101757_backlog_3473_transaction_checklists.sql
 * and the desktop's `ChecklistDocumentTypeSchema` (electron/schemas/checklist.ts).
 * A parity test reads the migration so the three cannot drift.
 *
 * NULL in the database means "any document type"; the editor shows it as ''.
 */

export const CHECKLIST_DOCUMENT_TYPES = [
  'offer',
  'inspection',
  'disclosure',
  'contract',
  'appraisal',
  'amendment',
  'addendum',
  'title',
  'closing',
  'other',
] as const;

export type ChecklistDocumentType = (typeof CHECKLIST_DOCUMENT_TYPES)[number];

export const CHECKLIST_DOCUMENT_TYPE_LABELS: Record<ChecklistDocumentType, string> = {
  offer: 'Offer',
  inspection: 'Inspection',
  disclosure: 'Disclosure',
  contract: 'Contract',
  appraisal: 'Appraisal',
  amendment: 'Amendment',
  addendum: 'Addendum',
  title: 'Title',
  closing: 'Closing',
  other: 'Other',
};

export const ANY_DOCUMENT_TYPE_LABEL = 'Any document type';

export function isChecklistDocumentType(value: unknown): value is ChecklistDocumentType {
  return typeof value === 'string' && (CHECKLIST_DOCUMENT_TYPES as readonly string[]).includes(value);
}
