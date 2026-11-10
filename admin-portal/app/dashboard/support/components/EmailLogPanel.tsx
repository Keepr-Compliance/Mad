'use client';

/**
 * EmailLogPanel - Support Ticket Detail Sidebar
 *
 * Collapsible section showing email delivery attempts for a given
 * recipient. Queries the email_delivery_log table and displays
 * type, status (color-coded badge), timestamp, and error message.
 *
 * BACKLOG-1567: Email Delivery Observability
 */

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Mail } from 'lucide-react';
import { getEmailDeliveryLogs } from '@/lib/support-queries';
import type { EmailDeliveryLogRow } from '@/lib/support-queries';

interface EmailLogPanelProps {
  recipientEmail: string;
}

const STATUS_STYLES: Record<string, string> = {
  sent: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  skipped: 'bg-yellow-100 text-yellow-700',
  attempted: 'bg-blue-100 text-blue-700',
  // BACKLOG-4011: first attempt failed and the send was moved to the retry queue.
  queued: 'bg-indigo-100 text-indigo-700',
};

const TYPE_LABELS: Record<string, string> = {
  invite: 'Invite',
  ticket_notification: 'Notification',
  ticket_confirmation: 'Confirmation',
  ticket_reply: 'Reply',
  ticket_resolved: 'Resolved',
  receipt: 'Receipt',
  other: 'Other',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function EmailLogPanel({ recipientEmail }: EmailLogPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<EmailDeliveryLogRow[]>([]);
  const [fetched, setFetched] = useState(false);

  const fetchLogs = useCallback(async () => {
    if (!recipientEmail) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getEmailDeliveryLogs(recipientEmail);
      setLogs(result);
      setFetched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load email logs');
    } finally {
      setLoading(false);
    }
  }, [recipientEmail]);

  // Lazy-load: only fetch when expanded for the first time
  useEffect(() => {
    if (expanded && !fetched) {
      fetchLogs();
    }
  }, [expanded, fetched, fetchLogs]);

  return (
    <div className="px-4 py-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
          <Mail className="h-3.5 w-3.5" />
          Email Log {fetched ? `(${logs.length})` : ''}
        </span>
        <span className="text-xs text-gray-400">
          {expanded ? '\u25B2' : '\u25BC'}
        </span>
      </button>

      {expanded && (
        <div className="mt-2">
          {error && (
            <p className="text-xs text-red-500 py-1">{error}</p>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading...
            </div>
          ) : (
            <>
              {logs.length === 0 && (
                <p className="text-xs text-gray-400 py-1">No email delivery logs found</p>
              )}

              {logs.length > 0 && (
                <div className="space-y-2">
                  {logs.map((log) => (
                    <div key={log.id} className="py-1.5 border-b border-gray-100 last:border-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-gray-700">
                          {TYPE_LABELS[log.email_type] || log.email_type}
                        </span>
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_STYLES[log.status] || 'bg-gray-100 text-gray-600'}`}
                        >
                          {log.status}
                        </span>
                        <span className="ml-auto text-[10px] text-gray-400">
                          {formatTime(log.created_at)}
                        </span>
                      </div>
                      {log.error_message && (
                        <p className="text-[11px] text-red-600 mt-0.5 truncate" title={log.error_message}>
                          {log.error_message}
                        </p>
                      )}
                      {(() => {
                        const subject = log.metadata?.subject;
                        if (!subject) return null;
                        const s = String(subject);
                        return (
                          <p className="text-[11px] text-gray-500 mt-0.5 truncate" title={s}>
                            {s}
                          </p>
                        );
                      })()}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
