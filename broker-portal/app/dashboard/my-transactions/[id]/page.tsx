/**
 * My Transactions, one submission — BACKLOG-3080.
 *
 * The agent's OWN submission, read-only: header, status, status history and
 * review notes, messages and attachments. No review actions, and nothing here
 * writes (the broker page marks a submission under review on open; this one
 * never does).
 *
 * Order of reads, and why it is fixed:
 *   1. lib/my-transactions-access.ts decides. null -> notFound(); upsell -> the
 *      plan message, the same for every id, with nothing read and the id never
 *      shown.
 *   2. The submission, by id AND `submitted_by = the agent` AND
 *      `organization_id = the brokerage the key was checked on`. Nothing -> a
 *      colleague's id, another brokerage's id and a missing id all look the same.
 *   3. Only then its messages and attachments, by the VERIFIED submission id,
 *      never the id from the URL.
 *   4. The previous versions (parent_submission_id), each hop scoped the same
 *      way as step 2. A parent outside that scope ends the walk and gets no link.
 *
 * Session client only (the gate's). Reviewer names are not resolved on this
 * page, so status history entries show no name.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { formatCurrency, formatDate, getStatusColor, formatStatus } from '@/lib/utils';
import { MessageList } from '@/components/submission/MessageList';
import { AttachmentList } from '@/components/submission/AttachmentList';
import { StatusHistory } from '@/components/submission/StatusHistory';
import { UpsellPanel } from '@/components/my-transactions/UpsellPanel';
import { agentChannelVisibility, getMyTransactionsGate } from '@/lib/my-transactions-access';

interface PageProps {
  params: Promise<{ id: string }>;
}

type SessionClient = Extract<Awaited<ReturnType<typeof getMyTransactionsGate>>, { kind: 'admitted' }>['supabase'];

interface HistoryEntry {
  status: string;
  changed_at: string;
  changed_by?: string;
  notes?: string;
  parentSubmissionId?: string;
}

interface OwnSubmission {
  id: string;
  property_address: string;
  property_city: string | null;
  property_state: string | null;
  property_zip: string | null;
  transaction_type: string;
  listing_price: number | null;
  sale_price: number | null;
  started_at: string | null;
  closed_at: string | null;
  status: string;
  parent_submission_id: string | null;
  message_count: number;
  attachment_count: number;
  status_history: HistoryEntry[] | null;
  created_at: string;
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
  message_type: string | null;
  participants: {
    from?: string;
    to?: string | string[];
    cc?: string[];
    bcc?: string[];
    chat_members?: string[];
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

const BASE_PATH = '/dashboard/my-transactions';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PARENT_DEPTH = 10;

const SUBMISSION_COLUMNS =
  'id, property_address, property_city, property_state, property_zip, transaction_type, listing_price, sale_price, started_at, closed_at, status, parent_submission_id, message_count, attachment_count, status_history, created_at';
const PARENT_COLUMNS = 'id, status_history, parent_submission_id, created_at';
const MESSAGE_COLUMNS =
  'id, channel, direction, subject, body_text, sent_at, has_attachments, attachment_count, thread_id, message_type, participants';
const ATTACHMENT_COLUMNS = 'id, filename, mime_type, file_size_bytes, storage_path, document_type';

async function getOwnSubmission(
  supabase: SessionClient,
  id: string,
  userId: string,
  organizationId: string
): Promise<OwnSubmission | null> {
  if (!UUID.test(id)) return null;
  const { data, error } = await supabase
    .from('transaction_submissions')
    .select(SUBMISSION_COLUMNS)
    .eq('id', id)
    .eq('submitted_by', userId)
    .eq('organization_id', organizationId)
    .neq('status', 'uploading')
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as OwnSubmission;
}

async function getMessages(supabase: SessionClient, submissionId: string): Promise<Message[]> {
  const { data, error } = await supabase
    .from('submission_messages')
    .select(MESSAGE_COLUMNS)
    .eq('submission_id', submissionId)
    .order('sent_at', { ascending: false });
  if (error) {
    console.error('Error fetching messages:', error.message);
    return [];
  }
  return (data ?? []) as unknown as Message[];
}

async function getAttachments(supabase: SessionClient, submissionId: string): Promise<Attachment[]> {
  const { data, error } = await supabase
    .from('submission_attachments')
    .select(ATTACHMENT_COLUMNS)
    .eq('submission_id', submissionId);
  if (error) {
    console.error('Error fetching attachments:', error.message);
    return [];
  }
  return (data ?? []) as unknown as Attachment[];
}

/**
 * The status history across previous versions, walking parent_submission_id
 * with the same owner + brokerage scope as the submission itself. Returns the
 * set of parents that passed that scope; only those get a link.
 */
async function getOwnStatusHistory(
  submission: OwnSubmission,
  supabase: SessionClient,
  userId: string,
  organizationId: string
): Promise<{ history: HistoryEntry[]; rootCreatedAt: string; verifiedParentIds: Set<string> }> {
  const parents: { id: string; status_history: HistoryEntry[] | null; created_at: string }[] = [];
  const verifiedParentIds = new Set<string>();
  let parentId = submission.parent_submission_id;

  while (parentId && UUID.test(parentId) && !verifiedParentIds.has(parentId) && parents.length < MAX_PARENT_DEPTH) {
    const { data: parent } = await supabase
      .from('transaction_submissions')
      .select(PARENT_COLUMNS)
      .eq('id', parentId)
      .eq('submitted_by', userId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (!parent) break;
    const row = parent as unknown as {
      id: string;
      status_history: HistoryEntry[] | null;
      parent_submission_id: string | null;
      created_at: string;
    };
    parents.push(row);
    verifiedParentIds.add(row.id);
    parentId = row.parent_submission_id;
  }

  const entries: HistoryEntry[] = [];
  let rootCreatedAt = submission.created_at;
  for (const p of [...parents].reverse()) {
    entries.push(...(p.status_history ?? []));
    rootCreatedAt = p.created_at;
  }
  const parentLink =
    submission.parent_submission_id && verifiedParentIds.has(submission.parent_submission_id)
      ? submission.parent_submission_id
      : undefined;
  for (const entry of submission.status_history ?? []) {
    entries.push(entry.status === 'resubmitted' && parentLink ? { ...entry, parentSubmissionId: parentLink } : entry);
  }

  // No reviewer names: `changed_by` is a user id the agent cannot resolve.
  const history = entries.map((entry) => ({ ...entry, changed_by: undefined }));
  return { history, rootCreatedAt, verifiedParentIds };
}

export default async function MyTransactionDetailPage({ params }: PageProps) {
  const gate = await getMyTransactionsGate();
  if (!gate) notFound();
  if (gate.kind === 'upsell') return <UpsellPanel />;

  const { supabase, userId, organizationId } = gate;
  const { id } = await params;

  const submission = await getOwnSubmission(supabase, id, userId, organizationId);
  if (!submission) notFound();

  const [visibility, messages, attachments, { history, rootCreatedAt }] = await Promise.all([
    agentChannelVisibility(organizationId),
    getMessages(supabase, submission.id),
    getAttachments(supabase, submission.id),
    getOwnStatusHistory(submission, supabase, userId, organizationId),
  ]);

  const shownMessages = messages.filter((m) => (m.channel === 'email' ? visibility.email : visibility.text));
  const showMessages = visibility.text || visibility.email;

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-24">
      <Link href={BASE_PATH} className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft className="h-4 w-4 mr-1" />
        Back to My Transactions
      </Link>

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

        <div className="px-6 py-5 grid grid-cols-2 md:grid-cols-4 gap-6">
          <DetailItem label="Transaction Type" value={submission.transaction_type} />
          <DetailItem label="Listing Price" value={formatCurrency(submission.listing_price)} />
          <DetailItem label="Sale Price" value={formatCurrency(submission.sale_price)} />
          <DetailItem label="Started" value={formatDate(submission.started_at)} />
          <DetailItem label="Closed" value={formatDate(submission.closed_at)} />
          <DetailItem label="Messages" value={String(submission.message_count)} />
          <DetailItem label="Attachments" value={String(submission.attachment_count)} />
          <DetailItem label="Submitted" value={formatDate(submission.created_at)} />
        </div>
      </div>

      <StatusHistory
        history={history}
        currentStatus={submission.status}
        submittedAt={rootCreatedAt}
        previousVersionBasePath={BASE_PATH}
      />

      {showMessages && <MessageList messages={shownMessages} />}

      {visibility.attachments && <AttachmentList attachments={attachments} />}
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
