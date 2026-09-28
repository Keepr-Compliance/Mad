'use client';

/**
 * StatusHistory Component
 *
 * Displays a timeline of status changes for a submission.
 * When a resubmission exists, shows only the current round by default
 * with previous history collapsed behind a toggle.
 *
 * BACKLOG-3477: checklist changes (typed entries) are grouped under the status
 * change they preceded, behind a collapsed "N checklist changes" disclosure;
 * those after the latest status change form their own group. The current
 * round shows its most recent 4 top-level lines, the rest behind
 * "Show full history". Display only: stored entries are untouched.
 */

import { useId, useState } from 'react';
import Link from 'next/link';
import { formatDate } from '@/lib/utils';
import {
  checklistChangesLabel,
  describeTypedEntry,
  groupHistory,
  isStatusEntry,
  isTypedEntry,
  VISIBLE_HISTORY_ITEMS,
  type HistoryItem,
  type StatusHistoryEntry,
} from '@/lib/submissions/history';

export type { StatusHistoryEntry };

interface StatusHistoryProps {
  history: StatusHistoryEntry[];
  currentStatus: string;
  submittedAt?: string;
  /**
   * BACKLOG-3080: the route "View previous version" links under, or null for
   * no link. A path, not a function: server pages render this client
   * component, and a function prop cannot cross that boundary. Defaults to the
   * broker review page, so the broker view is unchanged.
   */
  previousVersionBasePath?: string | null;
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
  previousVersionBasePath = '/dashboard/submissions',
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

  // BACKLOG-3477 (founder decision, pm_comments 795ff7c5): typed entries (a
  // reviewer tick, a checklist added) are grouped under the NEXT status change
  // they preceded; those after the latest status change form a trailing group.
  // Grouping happens BEFORE the round split, so ticks made between "Changes
  // requested" and the resubmission attach to "Resubmitted" (current round).
  const items = groupHistory(timelineEntries);
  const hasStatusItem = items.some((item) => item.kind === 'status');

  // Find the last "resubmitted" item to split previous vs current round
  const lastResubmitIdx = items.reduce(
    (acc, item, idx) => (item.kind === 'status' && item.entry.status === 'resubmitted' ? idx : acc),
    -1
  );

  const hasPreviousHistory = lastResubmitIdx > 0;
  const previousItems = hasPreviousHistory ? items.slice(0, lastResubmitIdx) : [];
  const currentItems = hasPreviousHistory ? items.slice(lastResubmitIdx) : items;

  // Get the parent submission ID from the resubmitted entry for linking
  const resubmitItem = hasPreviousHistory ? items[lastResubmitIdx] : null;
  const parentSubmissionId = resubmitItem?.kind === 'status' ? resubmitItem.entry.parentSubmissionId : undefined;
  const previousHref =
    parentSubmissionId && previousVersionBasePath ? `${previousVersionBasePath}/${parentSubmissionId}` : null;

  // Only a status entry can be "Current" — never a typed entry or a group.
  const lastStatusIdx = currentItems.reduce(
    (acc, item, idx) => (item.kind === 'status' && isStatusEntry(item.entry) ? idx : acc),
    -1
  );

  const [showPrevious, setShowPrevious] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const olderCount = Math.max(0, currentItems.length - VISIBLE_HISTORY_ITEMS);
  const firstVisible = showFull ? 0 : olderCount;
  const fullHistoryId = useId();

  return (
    <div className="bg-white shadow-sm border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900">Status History</h2>
      </div>

      <div className="px-6 py-4">
        {items.length === 0 ? (
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
                    <Chevron open={showPrevious} />
                    {showPrevious ? 'Hide' : 'Show'} previous review ({previousItems.length} steps)
                  </button>
                  {previousHref && (
                    <Link
                      href={previousHref}
                      className="text-sm text-primary-600 hover:text-primary-700 underline"
                    >
                      View previous version
                    </Link>
                  )}
                </div>

                {showPrevious && (
                  <div className="ml-1 pl-3 border-l-2 border-gray-200">
                    <ul className="-mb-8">
                      {previousItems.map((item, idx) => (
                        <HistoryItemRow
                          key={`prev-${idx}`}
                          item={item}
                          isLast={idx === previousItems.length - 1}
                          isCurrent={false}
                          hasStatusItem={hasStatusItem}
                          dimmed
                        />
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* Older items of the current round, behind "Show full history" */}
            {olderCount > 0 && (
              <div className="mb-4">
                <button
                  type="button"
                  onClick={() => setShowFull(!showFull)}
                  aria-expanded={showFull}
                  aria-controls={fullHistoryId}
                  data-testid="show-full-history"
                  className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
                >
                  <Chevron open={showFull} />
                  {showFull ? 'Show recent history only' : 'Show full history'}
                </button>
              </div>
            )}

            {/* Current round */}
            <ul className="-mb-8" id={fullHistoryId}>
              {currentItems.slice(firstVisible).map((item, i) => {
                const idx = firstVisible + i;
                return (
                  <HistoryItemRow
                    key={`curr-${idx}`}
                    item={item}
                    isLast={idx === currentItems.length - 1}
                    isCurrent={
                      idx === lastStatusIdx && item.kind === 'status' && item.entry.status === currentStatus
                    }
                    hasStatusItem={hasStatusItem}
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

function Chevron({ open, className = 'h-3.5 w-3.5' }: { open: boolean; className?: string }) {
  return (
    <svg
      className={`${className} transition-transform ${open ? 'rotate-90' : ''}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

/** One top-level line: a status entry (with its group) or the trailing group. */
function HistoryItemRow({
  item,
  isLast,
  isCurrent,
  hasStatusItem,
  dimmed = false,
}: {
  item: HistoryItem;
  isLast: boolean;
  isCurrent: boolean;
  hasStatusItem: boolean;
  dimmed?: boolean;
}) {
  if (item.kind === 'status') {
    return <TimelineEntry entry={item.entry} changes={item.changes} isLast={isLast} isCurrent={isCurrent} dimmed={dimmed} />;
  }
  return <PendingGroupEntry changes={item.changes} isLast={isLast} sinceLastReview={hasStatusItem} dimmed={dimmed} />;
}

/**
 * A disclosure listing the typed entries of one group, oldest first, each with
 * its existing label, person and time. Collapsed by default; state per group.
 */
function ChecklistChangesGroup({ changes, suffix = '' }: { changes: StatusHistoryEntry[]; suffix?: string }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className="mt-2" data-testid="checklist-changes-group">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={listId}
        className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
      >
        <Chevron open={open} className="h-3 w-3" />
        {checklistChangesLabel(changes.length)}
        {suffix}
      </button>
      {open && (
        <ul id={listId} className="mt-2 -mb-8">
          {changes.map((entry, idx) => (
            <TypedTimelineEntry key={idx} entry={entry} isLast={idx === changes.length - 1} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The typed entries made after the latest status change. */
function PendingGroupEntry({
  changes,
  isLast,
  sinceLastReview,
  dimmed = false,
}: {
  changes: StatusHistoryEntry[];
  isLast: boolean;
  sinceLastReview: boolean;
  dimmed?: boolean;
}) {
  return (
    <li className={dimmed ? 'opacity-60' : ''} data-testid="pending-history-group">
      <div className="relative pb-8">
        {!isLast && (
          <span className="absolute left-4 top-4 -ml-px h-full w-0.5 bg-gray-200" aria-hidden="true" />
        )}
        <div className="relative flex items-start space-x-3">
          <div className="flex h-8 w-8 items-center justify-center">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-100 ring-8 ring-white">
              <svg className="h-3 w-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </span>
          </div>
          <div className="min-w-0 flex-1 -mt-2">
            <ChecklistChangesGroup changes={changes} suffix={sinceLastReview ? ' since the last review' : ''} />
          </div>
        </div>
      </div>
    </li>
  );
}

function TimelineEntry({
  entry,
  changes = [],
  isLast,
  isCurrent,
  dimmed = false,
}: {
  entry: StatusHistoryEntry;
  changes?: StatusHistoryEntry[];
  isLast: boolean;
  isCurrent: boolean;
  dimmed?: boolean;
}) {
  if (isTypedEntry(entry)) {
    return <TypedTimelineEntry entry={entry} isLast={isLast} dimmed={dimmed} />;
  }
  const statusInfo = getStatusInfo(entry.status ?? '');

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

            {changes.length > 0 && <ChecklistChangesGroup changes={changes} />}
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * A non-status line (BACKLOG-3477, ruling 3767e481): muted icon, the change,
 * who, when. Smaller than a status entry and never marked "Current".
 */
function TypedTimelineEntry({
  entry,
  isLast,
  dimmed = false,
}: {
  entry: StatusHistoryEntry;
  isLast: boolean;
  dimmed?: boolean;
}) {
  return (
    <li className={dimmed ? 'opacity-60' : ''} data-testid="typed-history-entry" data-entry-type={entry.type}>
      <div className="relative pb-8">
        {!isLast && (
          <span className="absolute left-4 top-4 -ml-px h-full w-0.5 bg-gray-200" aria-hidden="true" />
        )}
        <div className="relative flex items-start space-x-3">
          <div className="flex h-8 w-8 items-center justify-center">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-100 ring-8 ring-white">
              <svg className="h-3 w-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm text-gray-600">{describeTypedEntry(entry)}</p>
                {entry.checklist_name && entry.type === 'checklist_review' && (
                  <p className="mt-0.5 text-xs text-gray-400">{entry.checklist_name}</p>
                )}
                {entry.changed_by && <p className="mt-0.5 text-xs text-gray-500">by {entry.changed_by}</p>}
              </div>
              <time className="whitespace-nowrap text-sm text-gray-400">{formatDate(entry.changed_at)}</time>
            </div>
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
