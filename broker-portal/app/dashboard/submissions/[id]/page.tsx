import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { formatCurrency, formatDate, getStatusColor, formatStatus } from '@/lib/utils';
import { MessageList } from '@/components/submission/MessageList';
import { ReviewActions } from '@/components/submission/ReviewActions';
import { AttachmentList } from '@/components/submission/AttachmentList';
import { ExcludedFilesNotice } from '@/components/submission/ExcludedFilesNotice';
import { buildAttachmentSources, readExcludedFiles } from '@/lib/submissions/attachmentSources';
import { groupAttachmentsByMessage } from '@/lib/submissions/attachmentKinds';
import { StatusHistory } from '@/components/submission/StatusHistory';
import { ChecklistReview } from '@/components/submission/ChecklistReview';
import { getDataClient } from '@/lib/impersonation-guards';
import { getOrgFeatures, isFeatureEnabled, isFeatureEnabledFailClosed } from '@/lib/feature-gate';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireFullPortalAccess } from '@/lib/auth/portalAccess';
import { CHECKLIST_FEATURE_KEY } from '@/lib/checklist-access';
import { resolveHistoryActors, type StatusHistoryEntry } from '@/lib/submissions/history';
import { resolveUserNames } from '@/lib/submissions/names';
import { loadAddableTemplates, loadSubmissionChecklists } from '@/lib/submissions/checklists';
import { markAsUnderReview } from '@/lib/submissions/markUnderReview';
import { NO_CAPABILITIES, getReviewCapabilities } from '@/lib/submissions/reviewAccess';
import {
  linkedEvidenceCounts,
  type ChecklistSectionView,
  type SupersededBy,
  type TemplateOption,
} from '@/lib/submissions/checklistModel';
import { loadVersionChain } from '@/lib/submissions/versions';
import { readAllRows } from '@/lib/supabase/readAllRows';
import { SubmissionVersions } from '@/components/submission/SubmissionVersions';
import { actualCell, offeredCell, readCommission } from '@/lib/submissions/commission';

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
  /** The desktop's id for the message (BACKLOG-3607 counts). */
  local_message_id?: string | null;
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
  /** The desktop's id for the file (BACKLOG-3607 counts: one file, one document). */
  local_attachment_id?: string | null;
  /** BACKLOG-3682: the submission_messages row the file came from (null before 2.39). */
  message_id?: string | null;
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

async function getMessages(submissionId: string, client: SupabaseClient): Promise<Message[]> {
  // BACKLOG-3607 N-3: every row, not the first PostgREST block — the Remove
  // confirmation counts linked emails from these rows.
  const { data, error } = await readAllRows<Message>((from, to) =>
    client
      .from('submission_messages')
      .select('*', { count: 'exact' })
      .eq('submission_id', submissionId)
      .order('sent_at', { ascending: false })
      .order('id')
      .range(from, to)
  );

  if (error) {
    console.error('Error fetching messages:', error);
    return [];
  }

  return data;
}

async function getAttachments(submissionId: string, client: SupabaseClient): Promise<Attachment[]> {
  const { data, error } = await readAllRows<Attachment>((from, to) =>
    client
      .from('submission_attachments')
      .select('*', { count: 'exact' })
      .eq('submission_id', submissionId)
      .order('id')
      .range(from, to)
  );

  if (error) {
    console.error('Error fetching attachments:', error);
    return [];
  }

  return data;
}

type HistoryEntry = StatusHistoryEntry;

/**
 * Walk the parent_submission_id chain to collect the full status history
 * across all versions. Tags "resubmitted" entries with the parent submission
 * ID for linking. changed_by stays a raw id; the page resolves names once,
 * through public.users, for the history and the checklists together
 * (BACKLOG-3477).
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

  return { history: allEntries, rootCreatedAt };
}

/**
 * BACKLOG-3596: whether a newer version of this submission exists, in ANY
 * status. Unlike loadVersionChain (which skips a version still uploading),
 * a version being sent counts: the tick RPC refuses this version as soon as a
 * child row exists, so the checkboxes close then too. A failed read answers
 * null (the RPC still refuses, and the refusal is shown in plain words).
 */
async function getSupersededBy(submissionId: string, client: SupabaseClient): Promise<SupersededBy> {
  const { data, error } = await client
    .from('transaction_submissions')
    .select('status')
    .eq('parent_submission_id', submissionId);
  if (error || !Array.isArray(data) || data.length === 0) return null;
  return (data as { status: string | null }[]).some((r) => r.status !== 'uploading') ? 'newer' : 'uploading';
}

export default async function SubmissionDetailPage({ params }: PageProps) {
  const { id } = await params;
  const { client, impersonation } = await getDataClient();
  const isImpersonating = !!impersonation;

  // BACKLOG-3080: the review surface is for the full portal only. Refused
  // before the submission is read and before it is marked under review.
  if (!isImpersonating && !(await requireFullPortalAccess())) {
    redirect('/dashboard');
  }

  const [submission, messages, attachments] = await Promise.all([
    getSubmission(id, client),
    getMessages(id, client),
    getAttachments(id, client),
  ]);

  // BACKLOG-3403: a submission still 'uploading' is not finished; it opens as
  // not found, before anything below reads it or marks it under review.
  if (!submission || submission.status === 'uploading') {
    notFound();
  }

  // Build full status history by walking the parent submission chain
  const { history: rawHistory, rootCreatedAt } = await getFullStatusHistory(submission, client);

  // BACKLOG-3597: the deal's other versions (previous ones, and the newest when
  // this is not it). The list shows only the newest; older ones are reached here.
  const versions = await loadVersionChain(client, submission);

  // BACKLOG-3477: what this viewer may do (lib/submissions/reviewAccess.ts is
  // the one place). Support sessions are read-only and get nothing.
  const capabilities = isImpersonating
    ? NO_CAPABILITIES
    : await getReviewCapabilities(submission.organization_id);

  // Mark as under_review when broker first opens (don't await - fire and forget)
  // This prevents agent from resubmitting while broker is reviewing
  // Skipped during impersonation (read-only) and for a tick-only reviewer.
  markAsUnderReview(submission, { isImpersonating, canDecide: capabilities.canDecide }).catch((e) => {
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

  // BACKLOG-3682: each file's source message (from gated messages only, so a
  // hidden channel never shows its sender or subject) and the files the agent
  // left out (submission_metadata.excluded_files, absent before 2.39).
  const attachmentSources = buildAttachmentSources(attachments, gatedMessages);
  const excludedFiles = readExcludedFiles(submission.submission_metadata);

  // BACKLOG-3748: files shown inside their message's bubble, joined on
  // message_id over the gated messages, under the same either-flag rule
  // (showAttachments) as the rest of the page — AttachmentList (above) and
  // the checklist file list use it too; no product reason for a stricter
  // per-channel rule here (SR review, pm_comments efcb3cec on BACKLOG-3748).
  const attachmentsByMessage = groupAttachmentsByMessage(attachments, gatedMessages, showAttachments);

  // BACKLOG-3477: the Checklists area, fail-closed on the submission's org.
  // Not shown during impersonation: the scoped support client does not admit
  // the checklist copy tables.
  const showChecklists =
    !isImpersonating && (await isFeatureEnabledFailClosed(submission.organization_id, CHECKLIST_FEATURE_KEY));
  let checklistSections: ChecklistSectionView[] = [];
  let checklistsLoaded = false;
  let addableTemplates: TemplateOption[] = [];
  let supersededBy: SupersededBy = null;
  if (showChecklists) {
    const [loaded, templates, superseded] = await Promise.all([
      loadSubmissionChecklists(client, submission.id),
      capabilities.canTick ? loadAddableTemplates(client, submission.organization_id) : Promise.resolve([]),
      getSupersededBy(submission.id, client),
    ]);
    checklistsLoaded = loaded.ok;
    checklistSections = loaded.ok ? loaded.sections : [];
    addableTemplates = templates;
    supersededBy = superseded;
  }

  // BACKLOG-3607: what the Remove confirmation states per checklist, counted by
  // the remove RPC's rule from the UNGATED rows (a plan that hides emails does
  // not make them any less linked).
  const localIdByAttachment = new Map(attachments.map((a) => [a.id, a.local_attachment_id ?? null]));
  const localIdByMessage = new Map(messages.map((m) => [m.id, m.local_message_id ?? null]));
  const linkedCounts = Object.fromEntries(
    checklistSections.map((s) => [s.id, linkedEvidenceCounts(s, localIdByAttachment, localIdByMessage)])
  );

  // BACKLOG-3477: names from public.users (same-org members), not profiles
  // (self-read only). Unresolved = no longer a member = "a former member".
  // During impersonation names are not looked up at all, so nobody is
  // mislabelled a former member.
  const viewerId = isImpersonating ? null : (await client.auth.getUser()).data.user?.id ?? null;
  const actorIds = [
    ...rawHistory.map((e) => e.changed_by),
    ...checklistSections.flatMap((s) => [
      s.addedAtReviewBy,
      s.removedAtReviewBy ?? null,
      ...s.items.map((i) => i.reviewerCheckedBy),
    ]),
    viewerId,
  ];
  const names = isImpersonating ? null : await resolveUserNames(client, actorIds);
  const fullHistory = resolveHistoryActors(rawHistory, names);

  // BACKLOG-3521: commission figures the agent entered, shown in the header
  // (read-only). Every submission before 2026-09-29 has none.
  const commission = readCommission(submission);

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-52 md:pb-24">
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
          {/* BACKLOG-3521: commission replaces the Messages/Attachments counts,
              which the Messages/Attachments section titles still show. */}
          <DetailItem label="Commission Offered" value={offeredCell(commission)} />
          <DetailItem label="Commission Actual" value={actualCell(commission)} />
          <DetailItem label="Submitted" value={formatDate(submission.created_at)} />
        </div>

      </div>

      {/* BACKLOG-3597: newer-version notice and previous versions.
          BACKLOG-3605: while the page is open the notice polls for a newer
          version (not in a support session). Keyed by id so moving to another
          version never carries one page's notice onto the next. */}
      <SubmissionVersions
        key={submission.id}
        previous={versions.previous}
        newest={versions.newest}
        currentId={submission.id}
        poll={!isImpersonating}
      />

      {/* Review Actions - hidden during impersonation (read-only) */}
      {/* BACKLOG-899: isImpersonating prop provides defense-in-depth write guard */}
      {!isImpersonating && capabilities.canDecide && (
        <ReviewActions
          submission={{
            id: submission.id,
            status: submission.status,
            organization_id: submission.organization_id,
          }}
          disabled={submission.status === 'approved' || submission.status === 'rejected'}
          isImpersonating={isImpersonating}
          canDecide={capabilities.canDecide}
          showChecklistHint={showChecklists && capabilities.canTick}
        />
      )}

      {/* Status History Timeline */}
      <StatusHistory
        history={fullHistory}
        currentStatus={submission.status}
        submittedAt={rootCreatedAt}
      />

      {/* BACKLOG-3477: Checklists, between Status History and Messages/Attachments */}
      {showChecklists && (
        <ChecklistReview
          submissionId={submission.id}
          status={submission.status}
          sections={checklistSections}
          loaded={checklistsLoaded}
          names={names ? Object.fromEntries(names) : null}
          canTick={capabilities.canTick}
          canDecide={!isImpersonating && capabilities.canDecide}
          templates={addableTemplates}
          messages={showMessages ? gatedMessages : []}
          attachments={showAttachments ? attachments : []}
          supersededBy={supersededBy}
          versionHistory={submission.status_history}
          version={typeof submission.version === 'number' ? submission.version : null}
          linkedCounts={linkedCounts}
          attachmentsByMessage={showMessages ? attachmentsByMessage : undefined}
        />
      )}

      {/* Messages with filter tabs - gated by broker_text_view / broker_email_view (TASK-2158) */}
      {showMessages && (
        <MessageList messages={gatedMessages} attachmentsByMessage={attachmentsByMessage} />
      )}

      {/* Attachments with viewer - gated by broker_text_attachments / broker_email_attachments (TASK-2158) */}
      {showAttachments && (
        <AttachmentList attachments={attachments} sources={attachmentSources} />
      )}

      {/* BACKLOG-3682: files the agent did not include. Last on the page; hidden when empty. */}
      {showAttachments && (
        <ExcludedFilesNotice
          files={excludedFiles}
          showTextLabels={textEnabled}
          showEmailLabels={emailEnabled}
        />
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
