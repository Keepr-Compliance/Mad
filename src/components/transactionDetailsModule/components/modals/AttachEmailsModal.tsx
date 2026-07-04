/**
 * AttachEmailsModal Component
 * Modal for browsing and attaching unlinked emails to a transaction.
 * BACKLOG-504: Now displays emails grouped by thread for consistency with the Emails tab.
 * TASK-1993: Server-side search with debounce, date filter, and provider-level load more.
 */
import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { ResponsiveModal } from "../../../common/ResponsiveModal";
import {
  processEmailThreads,
} from "../EmailThreadCard";
import type { EmailThread } from "../EmailThreadCard";
import { EmailThreadViewModal } from "./EmailThreadViewModal";
import type { Communication } from "../../types";
import { useAuth } from "../../../../contexts";
import { formatDateRange } from "../../../../utils/dateRangeUtils";
import { filterSelfFromParticipants, formatParticipants } from "../../../../utils/emailParticipantUtils";
import { getEmailAvatarInitial } from "../../../../utils/avatarUtils";
import { useContactNameMap } from "../../../../hooks/useContactNameMap";

interface AttachEmailsModalProps {
  /** User ID to fetch unlinked emails for */
  userId: string;
  /** Transaction ID to attach emails to */
  transactionId: string;
  /** Optional property address for display */
  propertyAddress?: string;
  /** Audit period start date (ISO string) for date filtering */
  auditStartDate?: string;
  /** Audit period end date (ISO string) for date filtering */
  auditEndDate?: string;
  /** Callback when modal is closed */
  onClose: () => void;
  /** Callback when emails are successfully attached */
  onAttached: () => void;
}

interface EmailInfo {
  id: string;
  subject: string | null;
  sender: string | null;
  sent_at: string | null;
  body_preview?: string | null;
  // BACKLOG-1707: full body fields so the preview pane renders content
  // before the email is attached to the transaction.
  body_plain?: string | null;
  body_html?: string | null;
  thread_id?: string | null;
  has_attachments?: boolean;
}

/**
 * Convert EmailInfo to Communication format for thread processing.
 * Preserves body_preview for display in thread cards.
 *
 * BACKLOG-1707: also pass through body_plain + body_html so
 * EmailThreadViewModal's preview pane renders the full body BEFORE attach
 * (cached-emails IPC now returns these fields — see getCachedEmails SELECT).
 */
function emailInfoToCommunication(email: EmailInfo): Communication & { body_preview?: string | null } {
  // Prefer real body fields when present; fall back to the snippet preview
  // for provider-only results that have not been cached yet.
  const bodyText = email.body_plain ?? email.body_preview ?? undefined;
  const bodyHtml = email.body_html ?? undefined;
  return {
    id: email.id,
    subject: email.subject || undefined,
    sender: email.sender || undefined,
    sent_at: email.sent_at || undefined,
    communication_type: "email",
    thread_id: email.thread_id || undefined,
    body_preview: email.body_preview,
    body_text: bodyText,
    body_plain: email.body_plain || undefined,
    body_html: bodyHtml,
    has_attachments: email.has_attachments || false,
  } as Communication & { body_preview?: string | null };
}

// Pagination constants to prevent UI freeze from rendering too many items
const THREADS_PER_PAGE = 25;
const MAX_THREADS = 1000;
const DEFAULT_MAX_RESULTS = 500;
const LOAD_MORE_INCREMENT = 200;

export function AttachEmailsModal({
  userId,
  transactionId,
  propertyAddress,
  auditStartDate,
  auditEndDate,
  onClose,
  onAttached,
}: AttachEmailsModalProps): React.ReactElement {
  const { currentUser } = useAuth();

  // BACKLOG-1762: address -> contact display_name map, resolves participant
  // names from Contacts when the email header carries no name.
  const nameMap = useContactNameMap(currentUser?.id);

  // Emails list state (raw from API)
  const [emails, setEmails] = useState<EmailInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selection state - tracks selected THREAD IDs
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<string>>(new Set());

  // View thread state
  const [viewingThread, setViewingThread] = useState<EmailThread | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [attaching, setAttaching] = useState(false);

  // Date filter state - pre-populate from audit period if available
  const [afterDate, setAfterDate] = useState(
    auditStartDate ? auditStartDate.split("T")[0] : ""
  );
  const [beforeDate, setBeforeDate] = useState(
    auditEndDate ? auditEndDate.split("T")[0] : ""
  );

  // Pagination state
  const [displayCount, setDisplayCount] = useState(THREADS_PER_PAGE);
  const [hasMoreFromProvider, setHasMoreFromProvider] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Track whether this is the initial load (for showing full-screen spinner vs inline)
  const isInitialLoad = useRef(true);

  // Background refresh: "checking for new emails" → "you're up to date"
  const [checkingForNew, setCheckingForNew] = useState(false);
  const [upToDate, setUpToDate] = useState(false);

  // Infinite scroll sentinel ref
  const scrollSentinelRef = useRef<HTMLDivElement>(null);

  // Debounce search query (500ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 500);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch emails from provider (server-side search)
  const fetchEmails = useCallback(async (
    query: string,
    after: string,
    before: string,
    maxResults: number,
    isLoadMore: boolean = false,
    skip: number = 0,
  ) => {
    if (isLoadMore) {
      setLoadingMore(true);
    } else if (isInitialLoad.current) {
      setLoading(true);
    } else {
      setSearching(true);
    }
    setError(null);

    try {
      const options: {
        query?: string;
        after?: string;
        before?: string;
        maxResults?: number;
        skip?: number;
        transactionId?: string;
      } = { maxResults };

      if (query) options.query = query;
      if (after) options.after = new Date(after).toISOString();
      if (before) options.before = new Date(before).toISOString();
      if (skip > 0) options.skip = skip;
      options.transactionId = transactionId;

      const result = await window.api.transactions.getUnlinkedEmails(
        userId,
        options,
      ) as { success?: boolean; emails?: EmailInfo[]; error?: string; fromCache?: boolean };

      if (result.success && result.emails) {
        if (isLoadMore) {
          // BACKLOG-711: Append new emails to existing list
          setEmails(prev => {
            return [...prev, ...result.emails!];
          });
          // Show more threads to make newly appended emails visible
          setDisplayCount(prev => prev + THREADS_PER_PAGE);
        } else {
          setEmails(result.emails);
        }
        // If fewer results returned than requested, provider has no more
        setHasMoreFromProvider(result.emails.length >= maxResults);

        // BACKLOG-1559: If result came from cache, always do a background refresh from provider
        if (result.fromCache && !isLoadMore) {
          setCheckingForNew(true);
          window.api.transactions.getUnlinkedEmails(userId, {
            ...options,
            skip: undefined,
            _skipCache: true,
          } as Record<string, unknown>).then((freshResult: { success?: boolean; emails?: EmailInfo[] }) => {
            if (freshResult.success && freshResult.emails) {
              setEmails(freshResult.emails);
              setHasMoreFromProvider(freshResult.emails.length >= maxResults);
            }
          }).catch(() => {
            // Silent fail — user already has cached results
          }).finally(() => {
            setCheckingForNew(false);
            setUpToDate(true);
            setTimeout(() => setUpToDate(false), 3000);
          });
        }
      } else {
        setError(result.error || "Failed to load emails");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load emails");
    } finally {
      setLoading(false);
      setSearching(false);
      setLoadingMore(false);
      isInitialLoad.current = false;
    }
  }, [userId]);

  // Fetch on mount and when search/filter params change
  useEffect(() => {
    // Reset to default maxResults and pagination when search params change
    setDisplayCount(THREADS_PER_PAGE);
    setHasMoreFromProvider(true);
    fetchEmails(debouncedQuery, afterDate, beforeDate, DEFAULT_MAX_RESULTS);
  }, [debouncedQuery, afterDate, beforeDate, fetchEmails]);

  // Convert emails to threads using the same logic as TransactionEmailsTab
  const emailThreads = useMemo(() => {
    const communications = emails.map(emailInfoToCommunication);
    return processEmailThreads(communications);
  }, [emails]);

  // Paginated threads - only render displayCount items to prevent UI freeze
  const displayedThreads = useMemo(() => {
    return emailThreads.slice(0, displayCount);
  }, [emailThreads, displayCount]);

  // Check if there are more threads to display locally or from provider
  const hasMoreLocal = displayCount < emailThreads.length;
  const hasMoreThreads = hasMoreLocal || hasMoreFromProvider;

  // Calculate total selected email count
  const selectedEmailCount = useMemo(() => {
    let count = 0;
    emailThreads.forEach(thread => {
      if (selectedThreadIds.has(thread.id)) {
        count += thread.emails.length;
      }
    });
    return count;
  }, [emailThreads, selectedThreadIds]);

  // Get all selected email IDs (for the API call)
  const selectedEmailIds = useMemo(() => {
    const ids: string[] = [];
    emailThreads.forEach(thread => {
      if (selectedThreadIds.has(thread.id)) {
        thread.emails.forEach(email => ids.push(email.id));
      }
    });
    return ids;
  }, [emailThreads, selectedThreadIds]);

  const handleLoadMore = useCallback(() => {
    if (hasMoreLocal) {
      // Show more of the already-fetched results
      setDisplayCount((prev) => Math.min(prev + THREADS_PER_PAGE, MAX_THREADS));
    } else if (hasMoreFromProvider) {
      // BACKLOG-711: Use skip-based pagination — only fetch the NEXT batch, not everything again
      fetchEmails(debouncedQuery, afterDate, beforeDate, LOAD_MORE_INCREMENT, true, emails.length);
    }
  }, [hasMoreLocal, hasMoreFromProvider, displayCount, emailThreads.length, emails.length, debouncedQuery, afterDate, beforeDate, fetchEmails]);

  // Infinite scroll: trigger handleLoadMore when sentinel enters viewport
  useEffect(() => {
    const sentinel = scrollSentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loadingMore && !loading) {
          handleLoadMore();
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [handleLoadMore, loadingMore, loading]);

  const handleToggleThread = (threadId: string) => {
    setSelectedThreadIds((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedThreadIds.size === emailThreads.length) {
      setSelectedThreadIds(new Set());
    } else {
      setSelectedThreadIds(new Set(emailThreads.map((t) => t.id)));
    }
  };

  const handleAttach = async () => {
    if (selectedEmailIds.length === 0) return;

    setAttaching(true);
    setError(null);
    try {
      const result = await window.api.transactions.linkEmails(
        selectedEmailIds,
        transactionId
      );

      if (result.success) {
        onAttached();
        onClose();
      } else {
        setError(result.error || "Failed to attach emails");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to attach emails");
    } finally {
      setAttaching(false);
    }
  };

  const isSearchActive = debouncedQuery || afterDate || beforeDate;

  return (
    <>
    <ResponsiveModal onClose={onClose} zIndex="z-[70]" testId="attach-emails-modal" panelClassName="max-w-3xl sm:max-h-[80vh]">
        {/* Header */}
        <div className="flex-shrink-0 bg-gradient-to-r from-blue-500 to-indigo-600 px-3 sm:px-6 pt-6 sm:pt-4 pb-3 sm:pb-4 sm:rounded-t-xl shadow-lg">
          {/* Mobile */}
          <div className="sm:hidden flex items-center justify-between">
            <button
              onClick={onClose}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 py-2 transition-all flex items-center gap-1 font-medium text-sm"
              data-testid="close-modal-button"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back
            </button>
            <h3 className="text-lg font-bold text-white">Attach Emails</h3>
          </div>
          {/* Desktop */}
          <div className="hidden sm:flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-white">Attach Emails</h3>
              <p className="text-blue-100 text-sm">
                {propertyAddress
                  ? `Select emails to link to ${propertyAddress}`
                  : "Select emails to attach to this transaction"}
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-all"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Search Bar + Date Filter */}
        <div className="flex-shrink-0 p-4 border-b border-gray-200">
          <div className="relative">
            <input
              type="text"
              placeholder="Search by name, email, subject, or content..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-10 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900 bg-white min-h-[44px]"
              data-testid="search-input"
            />
            {/* Search icon or loading spinner */}
            {searching ? (
              <div className="absolute left-3 top-0 bottom-0 flex items-center" data-testid="search-spinner">
                <svg
                  className="w-5 h-5 animate-spin text-blue-600"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              </div>
            ) : (
              <svg
                className="w-5 h-5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            )}
          </div>

          {/* Date Filter */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 mt-3" data-testid="date-filter">
            <label className="text-sm text-gray-600 whitespace-nowrap hidden sm:inline">Date range:</label>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <input
                type="date"
                value={afterDate}
                onChange={(e) => setAfterDate(e.target.value)}
                className="flex-1 sm:flex-none px-2 sm:px-3 py-2 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 text-gray-900 bg-white min-h-[44px]"
                data-testid="after-date-input"
              />
              <span className="text-gray-400 text-sm">to</span>
              <input
                type="date"
                value={beforeDate}
                onChange={(e) => setBeforeDate(e.target.value)}
                className="flex-1 sm:flex-none px-2 sm:px-3 py-2 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 text-gray-900 bg-white min-h-[44px]"
                data-testid="before-date-input"
              />
            </div>
            {(auditStartDate || auditEndDate) && (
              <button
                onClick={() => {
                  setAfterDate(auditStartDate ? auditStartDate.split("T")[0] : "");
                  setBeforeDate(auditEndDate ? auditEndDate.split("T")[0] : "");
                }}
                className="px-2 py-1 text-xs bg-blue-50 text-blue-600 rounded hover:bg-blue-100"
                data-testid="audit-period-button"
              >
                Audit Period
              </button>
            )}
          </div>

          {!loading && emailThreads.length > 0 && (
            <div className="flex items-center justify-between mt-2">
              <p className="text-sm text-gray-600">
                {emailThreads.length} conversation{emailThreads.length !== 1 ? "s" : ""}
                {emails.length !== emailThreads.length && (
                  <span className="ml-1">({emails.length} emails total)</span>
                )}
              </p>
              <button
                onClick={handleSelectAll}
                className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                data-testid="select-all-button"
              >
                {selectedThreadIds.size === emailThreads.length ? "Deselect All" : "Select All"}
              </button>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* Initial Loading */}
          {loading && (
            <div className="text-center py-12">
              <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto"></div>
              <p className="text-gray-500 mt-4">Loading emails...</p>
            </div>
          )}

          {/* Error */}
          {error && !loading && (
            <div className="text-center py-12">
              <svg className="w-16 h-16 text-red-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-red-600 mb-2">{error}</p>
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && emailThreads.length === 0 && (
            <div className="text-center py-12">
              <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <p className="text-gray-600 mb-2">
                {isSearchActive ? "No emails matching your search" : "No unlinked emails available"}
              </p>
              <p className="text-sm text-gray-500">
                {isSearchActive
                  ? "Try different search terms or adjust the date range"
                  : "All emails are already linked to transactions"}
              </p>
            </div>
          )}

          {/* Background refresh indicator */}
          {checkingForNew && (
            <div className="flex items-center gap-2 px-3 py-1.5 mb-2 text-xs text-blue-600 bg-blue-50 rounded-md">
              <div className="w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
              Checking for new emails...
            </div>
          )}
          {upToDate && !checkingForNew && (
            <div className="flex items-center gap-2 px-3 py-1.5 mb-2 text-xs text-green-600 bg-green-50 rounded-md">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              You&apos;re up to date
            </div>
          )}

          {/* Thread list - using displayedThreads (paginated) to prevent UI freeze */}
          {!loading && !error && emailThreads.length > 0 && (
            <div className="space-y-3">
              {displayedThreads.map((thread) => {
                const isSelected = selectedThreadIds.has(thread.id);
                const firstEmail = thread.emails[0];
                const isMultipleEmails = thread.emailCount > 1;
                const threadHasAttachments = thread.emails.some(e => e.has_attachments);
                // Filter out the user's own email from participants
                const otherParticipants = filterSelfFromParticipants(thread.participants, currentUser?.email);
                // Avatar: use first non-user participant, otherwise fallback to sender
                const avatarInitial = otherParticipants.length > 0
                  ? getEmailAvatarInitial(otherParticipants[0])
                  : getEmailAvatarInitial(firstEmail?.sender);
                // Get body preview from the most recent email in the thread
                const lastEmail = thread.emails[thread.emails.length - 1];
                // TASK-1998: body preview from most recent email, fall back to first, then subject
                const bodyPreview = (lastEmail as Communication & { body_preview?: string | null })?.body_preview
                  || (firstEmail as Communication & { body_preview?: string | null })?.body_preview
                  || null;

                return (
                  <div
                    key={thread.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleToggleThread(thread.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleToggleThread(thread.id);
                      }
                    }}
                    className={`rounded-lg border-2 transition-all cursor-pointer overflow-hidden ${
                      isSelected
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200 bg-white hover:border-blue-300"
                    }`}
                    data-testid={`thread-${thread.id}`}
                  >
                    {/* Thread card layout matching EmailThreadCard style */}
                    <div className="px-4 py-3 flex items-start justify-between">
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        {/* Checkbox */}
                        <div
                          className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
                            isSelected ? "bg-blue-500 border-blue-500" : "border-gray-300 bg-white"
                          }`}
                        >
                          {isSelected && (
                            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>

                        {/* Avatar - Blue for email, hidden on mobile */}
                        <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full items-center justify-center text-white font-semibold text-sm flex-shrink-0 hidden sm:flex">
                          {avatarInitial}
                        </div>

                        {/* Thread info: Subject, participants, and preview */}
                        <div className="min-w-0 flex-1">
                          <span className="font-semibold text-gray-900 block truncate">
                            {thread.subject || "(No Subject)"}
                          </span>
                          <span className="font-normal text-gray-500 text-sm block truncate">
                            {formatParticipants(otherParticipants, 2, nameMap)}
                            {isMultipleEmails && (
                              <span className="ml-2 text-gray-400">
                                ({thread.emailCount} emails)
                              </span>
                            )}
                          </span>
                          {bodyPreview && (
                            <span className="text-xs text-gray-400 block truncate mt-0.5">
                              {bodyPreview.length > 120 ? bodyPreview.substring(0, 120) + "..." : bodyPreview}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Attachment icon, date range, and View button */}
                      <div className="flex items-center gap-4 flex-shrink-0 mt-0.5">
                        {threadHasAttachments && (
                          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                          </svg>
                        )}
                        <span className="text-sm text-gray-500 hidden sm:inline">
                          {formatDateRange(thread.startDate, thread.endDate)}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setViewingThread(thread);
                          }}
                          className="text-sm font-medium text-blue-600 hover:text-blue-800 transition-colors whitespace-nowrap"
                          data-testid="view-thread-button"
                        >
                          {isMultipleEmails ? "View Thread \u2192" : "View"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Infinite scroll sentinel */}
              {hasMoreThreads && (
                <div
                  ref={scrollSentinelRef}
                  className="text-center py-4"
                  data-testid="scroll-sentinel"
                >
                  {loadingMore && (
                    <span className="flex items-center gap-2 justify-center text-sm text-gray-500">
                      <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                      Loading more...
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-3 sm:px-6 py-3 sm:py-4 bg-gray-50 rounded-b-xl flex items-center gap-3 justify-end sm:justify-between border-t border-gray-200">
          <span className="text-sm text-gray-600 hidden sm:inline">
            {selectedThreadIds.size > 0
              ? `${selectedThreadIds.size} selected`
              : "Select conversations to attach"}
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              disabled={attaching}
              className="hidden sm:block px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg font-medium transition-all disabled:opacity-50"
              data-testid="cancel-button"
            >
              Cancel
            </button>
            <button
              onClick={handleAttach}
              disabled={selectedEmailIds.length === 0 || attaching}
              className={`px-6 py-2 rounded-lg font-semibold transition-all flex items-center gap-2 ${
                selectedEmailIds.length === 0 || attaching
                  ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                  : "bg-gradient-to-r from-blue-500 to-indigo-600 text-white hover:from-blue-600 hover:to-indigo-700 shadow-md hover:shadow-lg"
              }`}
              data-testid="attach-button"
            >
              {attaching ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Attaching...
                </>
              ) : (
                <>Attach {selectedEmailCount > 0 && `(${selectedEmailCount} email${selectedEmailCount !== 1 ? "s" : ""})`}</>
              )}
            </button>
          </div>
        </div>
    </ResponsiveModal>

    {/* Thread view modal */}
    {viewingThread && (
      <EmailThreadViewModal
        thread={viewingThread}
        onClose={() => setViewingThread(null)}
        userEmail={currentUser?.email}
        nameMap={nameMap}
      />
    )}
    </>
  );
}
