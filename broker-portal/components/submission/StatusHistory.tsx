'use client';

/**
 * StatusHistory Component
 *
 * Displays a timeline of status changes for a submission.
 * When a resubmission exists, shows only the current round by default
 * with previous history collapsed behind a toggle.
 */

import { useState } from 'react';
import Link from 'next/link';
import { formatDate } from '@/lib/utils';

interface StatusHistoryEntry {
  status: string;
  changed_at: string;
  changed_by?: string;
  notes?: string;
  parentSubmissionId?: string;
}

interface StatusHistoryProps {
  history: StatusHistoryEntry[];
  currentStatus: string;
  submittedAt?: string;
}

function getStatusInfo(status: string): { label: string; color: string; bgColor: string; icon: string } {
  const statusMap: Record<string, { label: string; color: string; bgColor: string; icon: string }> = {
    submitted: {
      label: 'Submitted',
      color: 'text-blue-600',
      bgColor: 'bg-blue-100',
      icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
    },
    under_review: {
      label: 'Review Started',
      color: 'text-yellow-600',
      bgColor: 'bg-yellow-100',
      icon: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z',
    },
    needs_changes: {
      label: 'Changes Requested',
      color: 'text-orange-600',
      bgColor: 'bg-orange-100',
      icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
    },
    resubmitted: {
      label: 'Resubmitted',
      color: 'text-purple-600',
      bgColor: 'bg-purple-100',
      icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
    },
    approved: {
      label: 'Approved',
      color: 'text-green-600',
      bgColor: 'bg-green-100',
      icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
    },
    rejected: {
      label: 'Rejected',
      color: 'text-red-600',
      bgColor: 'bg-red-100',
      icon: 'M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z',
    },
  };

  return statusMap[status] || {
    label: status,
    color: 'text-gray-600',
    bgColor: 'bg-gray-100',
    icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  };
}

export function StatusHistory({
  history,
  currentStatus,
  submittedAt,
}: StatusHistoryProps) {
  // Build full timeline
  const timelineEntries: StatusHistoryEntry[] = [];

  if (submittedAt) {
    timelineEntries.push({
      status: 'submitted',
      changed_at: submittedAt,
    });
  }

  const sorted = [...history].sort(
    (a, b) => new Date(a.changed_at).getTime() - new Date(b.changed_at).getTime()
  );
  for (const entry of sorted) {
    if (entry.status === 'submitted' && timelineEntries.length > 0) continue;
    timelineEntries.push(entry);
  }

  // Find the last "resubmitted" entry to split previous vs current round
  const lastResubmitIdx = timelineEntries.reduce(
    (acc, entry, idx) => (entry.status === 'resubmitted' ? idx : acc),
    -1
  );

  const hasPreviousHistory = lastResubmitIdx > 0;
  const previousEntries = hasPreviousHistory ? timelineEntries.slice(0, lastResubmitIdx) : [];
  const currentEntries = hasPreviousHistory ? timelineEntries.slice(lastResubmitIdx) : timelineEntries;

  // Get the parent submission ID from the resubmitted entry for linking
  const resubmitEntry = hasPreviousHistory ? timelineEntries[lastResubmitIdx] : null;
  const parentSubmissionId = resubmitEntry?.parentSubmissionId;

  const [showPrevious, setShowPrevious] = useState(false);

  return (
    <div className="bg-white shadow-sm border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900">Status History</h2>
      </div>

      <div className="px-6 py-4">
        {timelineEntries.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-4">
            No history available
          </p>
        ) : (
          <div className="flow-root">
            {/* Collapsible previous history */}
            {hasPreviousHistory && (
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <button
                    onClick={() => setShowPrevious(!showPrevious)}
                    className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
                  >
                    <svg
                      className={`h-3.5 w-3.5 transition-transform ${showPrevious ? 'rotate-90' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    {showPrevious ? 'Hide' : 'Show'} previous review ({previousEntries.length} steps)
                  </button>
                  {parentSubmissionId && (
                    <Link
                      href={`/dashboard/submissions/${parentSubmissionId}`}
                      className="text-sm text-primary-600 hover:text-primary-700 underline"
                    >
                      View previous version
                    </Link>
                  )}
                </div>

                {showPrevious && (
                  <div className="ml-1 pl-3 border-l-2 border-gray-200">
                    <ul className="-mb-8">
                      {previousEntries.map((entry, idx) => (
                        <TimelineEntry
                          key={`prev-${idx}`}
                          entry={entry}
                          isLast={idx === previousEntries.length - 1}
                          isCurrent={false}
                          dimmed
                        />
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* Current round */}
            <ul className="-mb-8">
              {currentEntries.map((entry, idx) => {
                const isLast = idx === currentEntries.length - 1;
                const isCurrent = isLast && entry.status === currentStatus;

                return (
                  <TimelineEntry
                    key={`curr-${idx}`}
                    entry={entry}
                    isLast={isLast}
                    isCurrent={isCurrent}
                  />
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineEntry({
  entry,
  isLast,
  isCurrent,
  dimmed = false,
}: {
  entry: StatusHistoryEntry;
  isLast: boolean;
  isCurrent: boolean;
  dimmed?: boolean;
}) {
  const statusInfo = getStatusInfo(entry.status);

  return (
    <li className={dimmed ? 'opacity-60' : ''}>
      <div className="relative pb-8">
        {!isLast && (
          <span
            className="absolute left-4 top-4 -ml-px h-full w-0.5 bg-gray-200"
            aria-hidden="true"
          />
        )}

        <div className="relative flex items-start space-x-3">
          <div>
            <span
              className={`h-8 w-8 rounded-full flex items-center justify-center ring-8 ring-white ${statusInfo.bgColor}`}
            >
              <svg
                className={`h-4 w-4 ${statusInfo.color}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d={statusInfo.icon}
                />
              </svg>
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-900">
                  {statusInfo.label}
                  {isCurrent && (
                    <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">
                      Current
                    </span>
                  )}
                </p>
                {entry.changed_by && (
                  <p className="mt-0.5 text-sm text-gray-500">
                    by {entry.changed_by}
                  </p>
                )}
              </div>
              <time className="text-sm text-gray-400">
                {formatDate(entry.changed_at)}
              </time>
            </div>

            {entry.notes && (
              <CollapsibleNote note={entry.notes} defaultOpen={isCurrent} />
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

function CollapsibleNote({ note, defaultOpen = false }: { note: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
      >
        <svg
          className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        {open ? 'Hide note' : 'Show note'}
      </button>
      {open && (
        <div className="mt-1.5 text-sm text-gray-600 bg-gray-50 rounded-md p-3">
          {note}
        </div>
      )}
    </div>
  );
}
