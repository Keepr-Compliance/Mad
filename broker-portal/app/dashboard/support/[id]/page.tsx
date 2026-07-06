'use client';

/**
 * Ticket Detail Page - Broker Portal Dashboard
 *
 * Two-column layout: conversation thread (left) + sidebar (right).
 * Shows ticket detail with conversation thread and reply form.
 * Internal notes are filtered out. Customers cannot change status/assignment.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Eye, EyeOff, Hash } from 'lucide-react';
import { ConfirmationDialog, Skeleton } from '@keepr/ui';
import { getTicketDetail, closeTicketByRequester } from '@/lib/support-queries';
import type { TicketDetailResponse } from '@/lib/support-types';
import { CustomerTicketDescription, CustomerMessageList } from '@/app/support/components/CustomerConversation';
import { CustomerReplyForm } from '@/app/support/components/CustomerReplyForm';
import { CustomerTicketSidebar } from '@/app/support/components/CustomerTicketSidebar';

export default function DashboardTicketDetailPage() {
  const params = useParams();
  const ticketId = params.id as string;

  const [detail, setDetail] = useState<TicketDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAttachments, setShowAttachments] = useState(true);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [closing, setClosing] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);

  const loadDetail = useCallback(async () => {
    try {
      const data = await getTicketDetail(ticketId);
      setDetail(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ticket');
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  function handleReplySent() {
    loadDetail().then(() => {
      setTimeout(() => {
        threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    });
  }

  async function handleCloseTicket() {
    setClosing(true);
    try {
      await closeTicketByRequester(ticketId);
      setShowCloseConfirm(false);
      await loadDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to close ticket');
    } finally {
      setClosing(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto">
        <Skeleton className="h-6 w-48 mb-6" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="max-w-7xl mx-auto">
        <Link
          href="/dashboard/support"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700 mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Support
        </Link>
        <div className="bg-white rounded-lg shadow-sm border border-red-200 p-8 text-center">
          <p className="text-red-600 text-sm">{error || 'Ticket not found'}</p>
        </div>
      </div>
    );
  }

  const { ticket, messages, attachments } = detail;
  const isClosed = ticket.status === 'closed';
  const isResolved = ticket.status === 'resolved';

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/dashboard/support"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700 mb-3"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Support
        </Link>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-gray-400">
              <Hash className="h-5 w-5" />
              <span className="text-lg font-mono">{ticket.ticket_number}</span>
            </div>
            <h1 className="text-2xl font-bold text-gray-900">{ticket.subject}</h1>
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
            {ticket.status !== 'closed' && (
              <button
                onClick={() => setShowCloseConfirm(true)}
                className="inline-flex items-center gap-1.5 text-xs text-red-500 hover:text-red-700 transition-colors"
              >
                Close Ticket
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Description + Composer + Messages */}
        <div className="lg:col-span-2 space-y-4">
          {/* 1. Original description (pinned) */}
          <CustomerTicketDescription
            description={ticket.description}
            requesterName={ticket.requester_name}
            createdAt={ticket.created_at}
            attachments={attachments.filter((a) => !a.message_id)}
            showAttachments={showAttachments}
          />

          {/* 2. Reply form or status message */}
          {isClosed ? (
            <div className="text-center py-4 text-gray-500 bg-gray-50 rounded-lg border border-gray-200">
              This ticket is closed.
            </div>
          ) : isResolved ? (
            <>
              <div className="text-center py-3 text-amber-700 bg-amber-50 rounded-lg border border-amber-200 text-sm">
                This ticket has been resolved. Reply below to reopen it.
              </div>
              <CustomerReplyForm
                ticketId={ticket.id}
                requesterEmail={ticket.requester_email}
                requesterName={ticket.requester_name}
                onReplySent={handleReplySent}
              />
            </>
          ) : (
            <CustomerReplyForm
              ticketId={ticket.id}
              requesterEmail={ticket.requester_email}
              requesterName={ticket.requester_name}
              onReplySent={handleReplySent}
            />
          )}

          {/* 3. Messages -- newest first */}
          <CustomerMessageList
            messages={messages}
            attachments={attachments}
            requesterEmail={ticket.requester_email}
            showAttachments={showAttachments}
          />
          <div ref={threadEndRef} />
        </div>

        {/* Right: Sidebar */}
        <div>
          <CustomerTicketSidebar ticket={ticket} />
        </div>
      </div>

      {/* Close Ticket Confirmation Dialog */}
      <ConfirmationDialog
        open={showCloseConfirm}
        isDestructive
        title="Close this ticket?"
        description="Are you sure you want to close this ticket? You can reopen it later by replying."
        confirmLabel={closing ? 'Closing...' : 'Close Ticket'}
        cancelLabel="Cancel"
        loading={closing}
        onConfirm={handleCloseTicket}
        onCancel={() => setShowCloseConfirm(false)}
      />
    </div>
  );
}
