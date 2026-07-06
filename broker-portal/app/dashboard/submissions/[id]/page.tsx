import { createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { formatCurrency, formatDate, getStatusColor, formatStatus } from '@/lib/utils';
import { MessageList } from '@/components/submission/MessageList';
import { ReviewActions } from '@/components/submission/ReviewActions';
import { AttachmentList } from '@/components/submission/AttachmentList';
import { StatusHistory } from '@/components/submission/StatusHistory';
import { getDataClient } from '@/lib/impersonation-guards';
import { getOrgFeatures, isFeatureEnabled } from '@/lib/feature-gate';
import type { SupabaseClient } from '@supabase/supabase-js';

interface PageProps {
  params: Promise<{ id: string }>;
}

interface Message {
  id: string;
  channel: string;
  direction: string;
  subject: string | null;
  body_text: string | null;
  sent_at: string;
  has_attachments: boolean;
  attachment_count: number;
  thread_id: string | null;
  /** Message type: text, voice_message, location, attachment_only, system, unknown */
  message_type: string | null;
  participants: {
    from?: string;
    to?: string | string[];
    cc?: string[];
    bcc?: string[];
    chat_members?: string[];
    // Resolved names from contact lookup
    from_name?: string;
    to_names?: Record<string, string>;
    chat_member_names?: Record<string, string>;
  } | null;
}

interface Attachment {
  id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
  document_type: string | null;
}

async function getSubmission(id: string, client: SupabaseClient) {
  const { data, error } = await client
    .from('transaction_submissions')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    return null;
  }

  return data;
}

/**
 * Mark submission as under_review when broker first opens it.
 * This prevents agent from resubmitting while broker is reviewing.
 * Skipped during impersonation sessions (read-only).
 */
async function markAsUnderReview(submission: { id: string; status: string }, isImpersonating: boolean) {
  // Never write during impersonation
  if (isImpersonating) return;

  // Only transition from 'submitted' or 'resubmitted' to 'under_review'
  if (submission.status !== 'submitted' && submission.status !== 'resubmitted') {
    return;
  }

  const supabase = await createClient();

  const { error } = await supabase
    .from('transaction_submissions')
    .update({
      status: 'under_review',
    })
    .eq('id', submission.id);

  if (error) {
    console.error('Failed to mark submission as under_review:', error.message, { submissionId: submission.id });
  }
}

async function getMessages(submissionId: string, client: SupabaseClient): Promise<Message[]> {
  const { data, error } = await client
    .from('submission_messages')
    .select('*')
    .eq('submission_id', submissionId)
    .order('sent_at', { ascending: false });

  if (error) {
    console.error('Error fetching messages:', error);
    return [];
  }

  return data || [];
}

async function getAttachments(submissionId: string, client: SupabaseClient): Promise<Attachment[]> {
  const { data, error } = await client
    .from('submission_attachments')
    .select('*')
    .eq('submission_id', submissionId);

  if (error) {
    console.error('Error fetching attachments:', error);
    return [];
  }

  return data || [];
}

type HistoryEntry = {
  status: string;
  changed_at: string;
  changed_by?: string;
  notes?: string;
  parentSubmissionId?: string; // links to older submission version
};

/**
 * Walk the parent_submission_id chain to collect the full status history
 * across all versions, then resolve UUIDs to display names.
 * Tags "resubmitted" entries with the parent submission ID for linking.
 */
async function getFullStatusHistory(
  submission: { id: string; parent_submission_id?: string | null; status_history?: HistoryEntry[]; created_at: string },
  client: SupabaseClient,
): Promise<{ history: HistoryEntry[]; rootCreatedAt: string }> {
  const allEntries: HistoryEntry[] = [];
  const supabase = client;
  let rootCreatedAt = submission.created_at;

  // Walk parent chain to collect history from all versions
  const parents: Array<{ id: string; status_history: HistoryEntry[]; created_at: string }> = [];
  let parentId = submission.parent_submission_id;
  const maxDepth = 10;
  let depth = 0;
  while (parentId && depth < maxDepth) {
    const { data: parent } = await supabase
      .from('transaction_submissions')
      .select('id, status_history, parent_submission_id, created_at')
      .eq('id', parentId)
      .single();

    if (!parent) break;
    parents.push(parent);
    parentId = parent.parent_submission_id;
    depth++;
  }

  // Add parent history oldest-first
  for (const p of parents.reverse()) {
    allEntries.push(...(p.status_history || []));
    rootCreatedAt = p.created_at;
  }

  // Append current submission's history, tagging "resubmitted" with parent link
  for (const entry of (submission.status_history || [])) {
    if (entry.status === 'resubmitted' && submission.parent_submission_id) {
      allEntries.push({ ...entry, parentSubmissionId: submission.parent_submission_id });
    } else {
      allEntries.push(entry);
    }
  }

  // Resolve UUIDs to display names
  const userIds = Array.from(new Set(allEntries.map((e) => e.changed_by).filter(Boolean))) as string[];
  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in('id', userIds);

    const nameMap = new Map<string, string>();
    for (const p of profiles || []) {
      if (p.display_name) nameMap.set(p.id, p.display_name);
    }

    return {
      history: allEntries.map((entry) => ({
        ...entry,
        changed_by: entry.changed_by ? nameMap.get(entry.changed_by) || undefined : undefined,
      })),
      rootCreatedAt,
    };
  }

  return { history: allEntries, rootCreatedAt };
}

export default async function SubmissionDetailPage({ params }: PageProps) {
  const { id } = await params;
  const { client, impersonation } = await getDataClient();
  const isImpersonating = !!impersonation;

  const [submission, messages, attachments] = await Promise.all([
    getSubmission(id, client),
    getMessages(id, client),
    getAttachments(id, client),
  ]);

  if (!submission) {
    notFound();
  }

  // Build full status history by walking the parent submission chain
  const { history: fullHistory, rootCreatedAt } = await getFullStatusHistory(submission, client);

  // Mark as under_review when broker first opens (don't await - fire and forget)
  // This prevents agent from resubmitting while broker is reviewing
  // Skipped during impersonation (read-only)
  markAsUnderReview(submission, isImpersonating).catch((e) => {
    console.error('Unhandled error in markAsUnderReview:', e);
  });

  // Fetch org features for feature gating (TASK-2129, TASK-2158)
  // Uses the submission's organization_id to determine plan features
  const orgFeatures = await getOrgFeatures(submission.organization_id);

  // TASK-2158: Gate on broker_portal_access — if disabled, block the entire detail view
  const portalAccessEnabled = isFeatureEnabled(orgFeatures, 'broker_portal_access');
  if (!portalAccessEnabled) {
    return (
      <div className="max-w-7xl mx-auto space-y-6">
        <Link
          href="/dashboard/submissions"
          className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to submissions
        </Link>
        <div className="bg-white shadow-sm border border-gray-200 rounded-lg p-8 text-center">
          <h2 className="text-lg font-semibold text-gray-900">Submission data not available</h2>
          <p className="mt-2 text-sm text-gray-500">
            Submission data is not available for this organization&apos;s plan.
          </p>
        </div>
      </div>
    );
  }

  // Filter messages server-side based on feature gates (TASK-2158: renamed keys)
  // If broker_text_view is disabled, exclude text/SMS/iMessage messages
  // If broker_email_view is disabled, exclude email messages
  const textEnabled = isFeatureEnabled(orgFeatures, 'broker_text_view');
  const emailEnabled = isFeatureEnabled(orgFeatures, 'broker_email_view');
  const gatedMessages = messages.filter((msg) => {
    if (msg.channel === 'email') return emailEnabled;
    // All non-email channels (sms, imessage) are gated by broker_text_view
    return textEnabled;
  });

  // Determine if attachments section should be shown (TASK-2158: renamed keys)
  // Show attachments if either broker_text_attachments or broker_email_attachments is enabled
  const textAttachmentsEnabled = isFeatureEnabled(orgFeatures, 'broker_text_attachments');
  const emailAttachmentsEnabled = isFeatureEnabled(orgFeatures, 'broker_email_attachments');
  const showAttachments = textAttachmentsEnabled || emailAttachmentsEnabled;

  // Determine if messages section should be shown at all
  const showMessages = textEnabled || emailEnabled;

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-24">
      {/* Back Link */}
      <Link
        href="/dashboard/submissions"
        className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700"
      >
        <ArrowLeft className="h-4 w-4 mr-1" />
        Back to submissions
      </Link>

      {/* Header */}
      <div className="bg-white shadow-sm border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-200">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{submission.property_address}</h1>
              <p className="mt-1 text-sm text-gray-500">
                {submission.property_city}, {submission.property_state} {submission.property_zip}
              </p>
            </div>
            <span
              className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(
                submission.status
              )}`}
            >
              {formatStatus(submission.status)}
            </span>
          </div>
        </div>

        {/* Transaction Details */}
        <div className="px-6 py-5 grid grid-cols-2 md:grid-cols-4 gap-6">
          <DetailItem label="Transaction Type" value={submission.transaction_type} />
          <DetailItem label="Listing Price" value={formatCurrency(submission.listing_price)} />
          <DetailItem label="Sale Price" value={formatCurrency(submission.sale_price)} />
          <DetailItem label="Started" value={formatDate(submission.started_at)} />
          <DetailItem label="Closed" value={formatDate(submission.closed_at)} />
          <DetailItem label="Messages" value={submission.message_count.toString()} />
          <DetailItem label="Attachments" value={submission.attachment_count.toString()} />
          <DetailItem label="Submitted" value={formatDate(submission.created_at)} />
        </div>

      </div>

      {/* Review Actions - hidden during impersonation (read-only) */}
      {/* BACKLOG-899: isImpersonating prop provides defense-in-depth write guard */}
      {!isImpersonating && (
        <ReviewActions
          submission={{
            id: submission.id,
            status: submission.status,
            organization_id: submission.organization_id,
          }}
          disabled={submission.status === 'approved' || submission.status === 'rejected'}
          isImpersonating={isImpersonating}
        />
      )}

      {/* Status History Timeline */}
      <StatusHistory
        history={fullHistory}
        currentStatus={submission.status}
        submittedAt={rootCreatedAt}
      />

      {/* Messages with filter tabs - gated by broker_text_view / broker_email_view (TASK-2158) */}
      {showMessages && (
        <MessageList messages={gatedMessages} />
      )}

      {/* Attachments with viewer - gated by broker_text_attachments / broker_email_attachments (TASK-2158) */}
      {showAttachments && (
        <AttachmentList attachments={attachments} />
      )}
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-sm font-medium text-gray-500">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900 capitalize">{value || '-'}</dd>
    </div>
  );
}
