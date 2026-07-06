'use client';

/**
 * Ticket Detail Page - Agent Dashboard
 *
 * Two-column layout: conversation thread (left) + sidebar (right).
 * Shows ticket detail, messages, attachments, reply composer,
 * status/assignment controls, participants, and events.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Hash, Eye, EyeOff, Trash2 } from 'lucide-react';
import { Button } from '@keepr/design-system';
import { usePermissions } from '@/components/providers/PermissionsProvider';
import { PERMISSIONS } from '@/lib/permissions';
import { getTicketDetail, getTicketDiagnostics, deleteTicket } from '@/lib/support-queries';
import type { TicketDetailResponse } from '@/lib/support-types';
import { StatusBadge } from '../components/StatusBadge';
import { TicketDescription } from '../components/ConversationThread';
import { ActivityTimeline } from '../components/ActivityTimeline';
import { ReplyComposer } from '../components/ReplyComposer';
import { TicketSidebar } from '../components/TicketSidebar';
import { DiagnosticsPanel } from '../components/DiagnosticsPanel';

export default function TicketDetailPage() {
  const params = useParams();
  const router = useRouter();
  const ticketId = params.id as string;

  const { hasPermission } = usePermissions();

  const [detail, setDetail] = useState<TicketDetailResponse | null>(null);
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAttachments, setShowAttachments] = useState(true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);

  const loadDetail = useCallback(async () => {
    try {
      const data = await getTicketDetail(ticketId);
      setDetail(data);
      setError(null);

      // Load diagnostics from attachment (best-effort, never blocks UI)
      getTicketDiagnostics(ticketId, data.attachments)
        .then(setDiagnostics)
        .catch(() => setDiagnostics(null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ticket');
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  function handleMessageSent() {
    loadDetail().then(() => {
      // Scroll to bottom after new message
      setTimeout(() => {
        threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    });
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteTicket(ticketId);
      router.push('/dashboard/support');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete ticket');
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-64 mb-6" />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-4">
              <div className="h-32 bg-gray-200 rounded" />
              <div className="h-32 bg-gray-200 rounded" />
            </div>
            <div className="h-96 bg-gray-200 rounded" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="max-w-7xl mx-auto">
        <button
          onClick={() => router.push('/dashboard/support')}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Queue
        </button>
        <div className="bg-white rounded-lg border border-red-200 p-8 text-center">
          <p className="text-red-600 text-sm">{error || 'Ticket not found'}</p>
        </div>
      </div>
    );
  }

  const { ticket, messages, attachments, participants, events } = detail;

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <button
          onClick={() => router.push('/dashboard/support')}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-3"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Queue
        </button>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-gray-400">
              <Hash className="h-5 w-5" />
              <span className="text-lg font-mono">{ticket.ticket_number}</span>
            </div>
            <h1 className="text-xl font-bold text-gray-900">{ticket.subject}</h1>
            <StatusBadge status={ticket.status} />
          </div>
          <div className="flex items-center gap-3">
            {attachments.length > 0 && (
              <button
                onClick={() => setShowAttachments(!showAttachments)}
                className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
              >
                {showAttachments ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {showAttachments ? 'Hide' : 'Show'} attachments
                <span className="text-gray-400">({attachments.length})</span>
              </button>
            )}
            {hasPermission(PERMISSIONS.SUPPORT_ADMIN) && (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="inline-flex items-center gap-1.5 text-xs text-red-500 hover:text-red-700 transition-colors"
                title="Delete ticket"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Description → Composer → Timeline (newest first) */}
        <div className="lg:col-span-2 space-y-4">
          {/* 1. Original ticket description (pinned) */}
          <TicketDescription
            description={ticket.description}
            requesterName={ticket.requester_name}
            requesterEmail={ticket.requester_email}
            createdAt={ticket.created_at}
            attachments={attachments.filter((a) => !a.message_id)}
            showAttachments={showAttachments}
          />

          {/* 2. Reply Composer — below description */}
          <ReplyComposer
            ticketId={ticket.id}
            onMessageSent={handleMessageSent}
            requesterName={ticket.requester_name}
            ticketNumber={ticket.ticket_number}
            ticketSubject={ticket.subject}
            requesterEmail={ticket.requester_email}
          />

          {/* 3. Activity Timeline — messages + events, newest first */}
          <ActivityTimeline
            messages={messages}
            events={events}
            attachments={attachments}
            showAttachments={showAttachments}
            onTimelineChanged={loadDetail}
          />

          <div ref={threadEndRef} />
        </div>

        {/* Right: Sidebar */}
        <div className="space-y-4">
          <TicketSidebar
            ticket={ticket}
            participants={participants}
            onTicketUpdated={loadDetail}
          />
          <DiagnosticsPanel diagnostics={diagnostics} />
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg border border-gray-200 shadow-xl p-6 max-w-sm mx-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Delete Ticket #{ticket.ticket_number}?</h3>
            <p className="text-sm text-gray-500 mb-4">
              This will permanently delete this ticket, all messages, attachments, and history. This action cannot be undone.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors"
              >
                Cancel
              </button>
              <Button variant="danger" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete Ticket'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
