/**
 * Submission-side row builders — BACKLOG-3080 (My Transactions).
 *
 * SHAPE transcribed from production, VALUES invented. Not a test file (the
 * portal's testMatch needs `.test.` / `.spec.` in the name).
 *
 * Sources (read-only, Supabase MCP, 2026-09-25):
 *   - column lists: `select table_name, column_name from information_schema.columns
 *     where table_schema = 'public' and table_name in ('transaction_submissions',
 *     'submission_messages', 'submission_attachments') order by ordinal_position`
 *     -> 26, 14 and 10 columns, listed below in that order;
 *   - status_history elements: trigger function `track_submission_status_changes`
 *     (`jsonb_build_object('status', NEW.status, 'changed_at', NOW(),
 *     'changed_by', NEW.reviewed_by, 'notes', NEW.review_notes)`), and an
 *     aggregate over production rows: every element has exactly the keys
 *     changed_at, changed_by, notes, status;
 *   - submission_metadata keys: aggregate, every row has exactly
 *     desktop_version, detection_confidence, detection_source;
 *   - status values: the produced set submitted, under_review, needs_changes,
 *     approved, rejected, resubmitted (+ uploading, which the pages filter out);
 *   - attachment storage_path: producer shape `${orgId}/${submissionId}/${file}`
 *     (electron/services/supabaseStorageService.ts), and NULL for a
 *     metadata-only row (electron/services/submissionService.ts).
 *
 * Every id is invented; none comes from a live row.
 */

import type { Row } from './postgrestEmulator';

export const SUBMISSION_COLUMNS = [
  'id',
  'organization_id',
  'submitted_by',
  'local_transaction_id',
  'property_address',
  'property_city',
  'property_state',
  'property_zip',
  'transaction_type',
  'listing_price',
  'sale_price',
  'started_at',
  'closed_at',
  'status',
  'reviewed_by',
  'reviewed_at',
  'review_notes',
  'version',
  'parent_submission_id',
  'review_deadline',
  'message_count',
  'attachment_count',
  'submission_metadata',
  'created_at',
  'updated_at',
  'status_history',
] as const;

export const MESSAGE_COLUMNS = [
  'id',
  'submission_id',
  'local_message_id',
  'channel',
  'direction',
  'subject',
  'body_text',
  'participants',
  'sent_at',
  'thread_id',
  'has_attachments',
  'attachment_count',
  'created_at',
  'message_type',
] as const;

export const ATTACHMENT_COLUMNS = [
  'id',
  'submission_id',
  'message_id',
  'filename',
  'mime_type',
  'file_size_bytes',
  'storage_path',
  'document_type',
  'created_at',
  'local_attachment_id',
] as const;

export const STATUS_HISTORY_KEYS = ['changed_at', 'changed_by', 'notes', 'status'] as const;
export const SUBMISSION_METADATA_KEYS = ['desktop_version', 'detection_confidence', 'detection_source'] as const;

export interface HistoryEntry {
  status: string;
  changed_at: string;
  changed_by: string | null;
  notes: string | null;
}

export function historyEntry(status: string, notes: string | null = null, changedBy: string | null = null): HistoryEntry {
  return { status, changed_at: '2026-09-02T00:00:00Z', changed_by: changedBy, notes };
}

export function submissionRow(input: {
  id: string;
  organizationId: string;
  submittedBy: string;
  status?: string;
  address?: string;
  parentSubmissionId?: string | null;
  statusHistory?: HistoryEntry[];
  createdAt?: string;
}): Row {
  return {
    id: input.id,
    organization_id: input.organizationId,
    submitted_by: input.submittedBy,
    local_transaction_id: `local-${input.id}`,
    property_address: input.address ?? `${input.id} Fixture Street`,
    property_city: 'Fixture City',
    property_state: 'CA',
    property_zip: '90000',
    transaction_type: 'purchase',
    listing_price: 500000,
    sale_price: 490000,
    started_at: '2026-08-01T00:00:00Z',
    closed_at: null,
    status: input.status ?? 'submitted',
    reviewed_by: null,
    reviewed_at: null,
    review_notes: null,
    version: 1,
    parent_submission_id: input.parentSubmissionId ?? null,
    review_deadline: null,
    message_count: 1,
    attachment_count: 1,
    submission_metadata: { desktop_version: '2.38.0', detection_confidence: 0.9, detection_source: 'manual' },
    created_at: input.createdAt ?? '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    status_history: input.statusHistory ?? [],
  };
}

export function messageRow(input: { id: string; submissionId: string; channel?: string; subject: string }): Row {
  const channel = input.channel ?? 'email';
  return {
    id: input.id,
    submission_id: input.submissionId,
    local_message_id: `local-${input.id}`,
    channel,
    direction: 'inbound',
    subject: input.subject,
    body_text: `body of ${input.subject}`,
    participants: { from: 'sender@fixture.example.test', to: ['agent@fixture.example.test'] },
    sent_at: '2026-09-01T10:00:00Z',
    thread_id: `thread-${input.id}`,
    has_attachments: false,
    attachment_count: 0,
    created_at: '2026-09-01T10:00:00Z',
    message_type: channel === 'email' ? 'email' : 'text',
  };
}

export function attachmentRow(input: {
  id: string;
  submissionId: string;
  organizationId: string;
  filename: string;
  mimeType: string;
  /** false -> the metadata-only shape, storage_path NULL. */
  stored?: boolean;
}): Row {
  return {
    id: input.id,
    submission_id: input.submissionId,
    message_id: null,
    filename: input.filename,
    mime_type: input.mimeType,
    file_size_bytes: 1024,
    storage_path: input.stored === false ? null : `${input.organizationId}/${input.submissionId}/${input.filename}`,
    document_type: null,
    created_at: '2026-09-01T10:00:00Z',
    local_attachment_id: `local-${input.id}`,
  };
}
