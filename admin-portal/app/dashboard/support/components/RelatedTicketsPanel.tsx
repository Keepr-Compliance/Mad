'use client';

/**
 * RelatedTicketsPanel - Support Ticket Detail Sidebar
 *
 * Collapsible section showing two categories of related tickets:
 * 1. Manually linked tickets (agent-created bidirectional links)
 * 2. Auto-related tickets (same requester email)
 *
 * Includes inline search to link additional tickets with type selection.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { Link2, X, Plus, Loader2 } from 'lucide-react';
import {
  getRelatedTickets,
  linkTickets,
  unlinkTickets,
  searchTicketsForLink,
} from '@/lib/support-queries';
import type {
  RelatedTicket,
  RelatedTicketsResponse,
  TicketLinkSearchResult,
  TicketLinkType,
  TicketStatus,
} from '@/lib/support-types';
import { StatusBadge } from './StatusBadge';

interface RelatedTicketsPanelProps {
  ticketId: string;
  onTicketUpdated: () => void;
}

const LINK_TYPE_LABELS: Record<TicketLinkType, string> = {
  related: 'Related',
  duplicate: 'Duplicate',
  parent: 'Parent',
  child: 'Child',
};

function formatShortDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export function RelatedTicketsPanel({ ticketId, onTicketUpdated }: RelatedTicketsPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<RelatedTicketsResponse>({ auto_related: [], manual_links: [] });

  // Link search state
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<TicketLinkSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [linkType, setLinkType] = useState<TicketLinkType>('related');
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<string | null>(null);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const totalCount = data.manual_links.length + data.auto_related.length;

  const fetchRelated = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getRelatedTickets(ticketId);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load related tickets');
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    fetchRelated();
  }, [fetchRelated]);

  // Debounced search
  useEffect(() => {
    if (!searchQuery || searchQuery.length < 1) {
      setSearchResults([]);
      return;
    }

    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }

    searchTimerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await searchTicketsForLink(searchQuery, ticketId);
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, [searchQuery, ticketId]);

  // Focus search input when search is opened
  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  async function handleLink(targetTicketId: string) {
    setLinking(true);
    try {
      await linkTickets(ticketId, targetTicketId, linkType);
      setSearchQuery('');
      setSearchResults([]);
      setShowSearch(false);
      await fetchRelated();
      onTicketUpdated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('unique') || msg.includes('duplicate')) {
        setError('These tickets are already linked');
      } else {
        setError(msg || 'Failed to link ticket');
      }
    } finally {
      setLinking(false);
    }
  }

  async function handleUnlink(linkedTicketId: string) {
    setUnlinking(linkedTicketId);
    try {
      await unlinkTickets(ticketId, linkedTicketId);
      await fetchRelated();
      onTicketUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlink ticket');
    } finally {
      setUnlinking(null);
    }
  }

  function renderTicketRow(ticket: RelatedTicket, isManual: boolean) {
    return (
      <div key={ticket.id} className="group flex items-start gap-2 py-1.5">
        {isManual && (
          <Link2 className="h-3.5 w-3.5 text-blue-400 shrink-0 mt-0.5" />
        )}
        <div className="min-w-0 flex-1">
          <Link
            href={`/dashboard/support/${ticket.id}`}
            className="block text-sm text-gray-700 hover:text-primary-600 truncate"
          >
            #{ticket.ticket_number} {ticket.subject}
          </Link>
          <div className="flex items-center gap-2 mt-0.5">
            <StatusBadge status={ticket.status as TicketStatus} />
            {isManual && ticket.link_type && ticket.link_type !== 'related' && (
              <span className="text-xs text-gray-400">
                {LINK_TYPE_LABELS[ticket.link_type]}
              </span>
            )}
            <span className="text-xs text-gray-400">
              {formatShortDate(ticket.created_at)}
            </span>
          </div>
        </div>
        {isManual && (
          <button
            onClick={(e) => {
              e.preventDefault();
              handleUnlink(ticket.id);
            }}
            disabled={unlinking === ticket.id}
            className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-red-500 transition-opacity"
            title="Unlink ticket"
          >
            {unlinking === ticket.id ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <X className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
          Related Tickets ({totalCount})
        </span>
        <span className="text-xs text-gray-400">
          {expanded ? '\u25B2' : '\u25BC'}
        </span>
      </button>

      {expanded && (
        <div className="mt-2">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading...
            </div>
          ) : error ? (
            <p className="text-xs text-red-500 py-1">{error}</p>
          ) : (
            <>
              {/* Manual links first */}
              {data.manual_links.length > 0 && (
                <div className="space-y-0.5">
                  {data.manual_links.map((ticket) => renderTicketRow(ticket, true))}
                </div>
              )}

              {/* Divider between manual and auto if both exist */}
              {data.manual_links.length > 0 && data.auto_related.length > 0 && (
                <div className="text-xs text-gray-400 text-center my-2">
                  &mdash; same requester &mdash;
                </div>
              )}

              {/* Auto-related tickets */}
              {data.auto_related.length > 0 && (
                <div className="space-y-0.5">
                  {data.auto_related.map((ticket) => renderTicketRow(ticket, false))}
                </div>
              )}

              {/* Empty state */}
              {totalCount === 0 && !showSearch && (
                <p className="text-xs text-gray-400 py-1">No related tickets</p>
              )}

              {/* Link Ticket button */}
              {!showSearch ? (
                <button
                  onClick={() => setShowSearch(true)}
                  className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium mt-2"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Link Ticket
                </button>
              ) : (
                <div className="mt-3 space-y-2">
                  {/* Search input */}
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search by # or subject..."
                    className="w-full text-sm text-gray-900 bg-white border border-gray-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />

                  {/* Link type selector */}
                  <select
                    value={linkType}
                    onChange={(e) => setLinkType(e.target.value as TicketLinkType)}
                    className="w-full text-xs text-gray-900 border border-gray-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    {(Object.entries(LINK_TYPE_LABELS) as [TicketLinkType, string][]).map(
                      ([value, label]) => (
                        <option key={value} value={value}>
                          Type: {label}
                        </option>
                      )
                    )}
                  </select>

                  {/* Search results */}
                  {searching && (
                    <div className="flex items-center gap-2 text-xs text-gray-400 py-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Searching...
                    </div>
                  )}

                  {!searching && searchResults.length > 0 && (
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {searchResults.map((result) => (
                        <button
                          key={result.id}
                          onClick={() => handleLink(result.id)}
                          disabled={linking}
                          className="w-full text-left px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-50 rounded-md disabled:opacity-50 transition-colors"
                        >
                          <div className="truncate">
                            #{result.ticket_number} {result.subject}
                          </div>
                          <div className="text-xs text-gray-400 truncate">
                            {result.requester_name}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  {!searching && searchQuery.length >= 1 && searchResults.length === 0 && (
                    <p className="text-xs text-gray-400 py-1">No tickets found</p>
                  )}

                  {/* Cancel button */}
                  <button
                    onClick={() => {
                      setShowSearch(false);
                      setSearchQuery('');
                      setSearchResults([]);
                    }}
                    className="text-xs text-gray-500 hover:text-gray-700"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
