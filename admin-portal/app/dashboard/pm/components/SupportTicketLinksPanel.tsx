'use client';

/**
 * SupportTicketLinksPanel - PM Item Detail Sidebar
 *
 * Collapsible section showing support tickets linked to the current backlog item.
 * Queries support_ticket_backlog_links in reverse (given backlog_item_id, show tickets).
 * Includes inline search to link/unlink tickets with link type selection.
 *
 * Pattern: Adapted from support/BacklogLinksPanel.tsx + pm/LinkedItemsPanel.tsx
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { Ticket, X, Plus, Loader2, Search } from 'lucide-react';
import {
  getTicketLinksForBacklogItem,
  searchTicketsForBacklogLink,
  createBacklogLink,
  removeBacklogLink,
} from '@/lib/support-queries';
import type { TicketLinkRow } from '@/lib/support-queries';

interface SupportTicketLinksPanelProps {
  itemId: string;
  onUpdate?: () => void;
}

const LINK_TYPE_STYLES: Record<string, string> = {
  fix: 'bg-green-100 text-green-700',
  related: 'bg-blue-100 text-blue-700',
  duplicate: 'bg-yellow-100 text-yellow-700',
};

const TICKET_STATUS_STYLES: Record<string, string> = {
  new: 'bg-blue-100 text-blue-700',
  open: 'bg-green-100 text-green-700',
  pending: 'bg-yellow-100 text-yellow-700',
  on_hold: 'bg-orange-100 text-orange-700',
  solved: 'bg-gray-100 text-gray-700',
  closed: 'bg-gray-100 text-gray-500',
};

type BacklogLinkType = 'fix' | 'related' | 'duplicate';

function formatTicketNumber(num: number): string {
  return `TKT-${String(num).padStart(4, '0')}`;
}

export function SupportTicketLinksPanel({ itemId, onUpdate }: SupportTicketLinksPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<TicketLinkRow[]>([]);

  // Search / add state
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ id: string; ticket_number: number; subject: string; status: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [linkType, setLinkType] = useState<BacklogLinkType>('related');
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchLinks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getTicketLinksForBacklogItem(itemId);
      setLinks(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ticket links');
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  useEffect(() => {
    fetchLinks();
  }, [fetchLinks]);

  // Focus search input when panel opens
  const prevShowSearch = useRef(showSearch);
  if (showSearch !== prevShowSearch.current) {
    prevShowSearch.current = showSearch;
    if (showSearch) {
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }

  // Debounced search
  useEffect(() => {
    if (!searchQuery || searchQuery.length < 1) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    let cancelled = false;

    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }

    searchTimerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await searchTicketsForBacklogLink(searchQuery, itemId);
        if (!cancelled) {
          setSearchResults(results);
        }
      } catch (err) {
        console.error('Ticket search failed:', err);
        if (!cancelled) {
          setSearchResults([]);
        }
      } finally {
        if (!cancelled) {
          setSearching(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, [searchQuery, itemId]);

  async function handleLink(ticketId: string) {
    setLinking(true);
    setError(null);
    try {
      await createBacklogLink(ticketId, itemId, linkType);
      setSearchQuery('');
      setSearchResults([]);
      setShowSearch(false);
      fetchLinks();
      onUpdate?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('unique') || msg.includes('duplicate')) {
        setError('This ticket is already linked');
      } else {
        setError(msg || 'Failed to link ticket');
      }
    } finally {
      setLinking(false);
    }
  }

  async function handleUnlink(linkId: string) {
    setUnlinking(linkId);
    setError(null);
    try {
      await removeBacklogLink(linkId);
      fetchLinks();
      onUpdate?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlink ticket');
    } finally {
      setUnlinking(null);
    }
  }

  return (
    <div className="px-4 py-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left"
      >
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
          Support Tickets ({links.length})
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
              {links.length > 0 && (
                <div className="space-y-1.5">
                  {links.map((link) => (
                    <div key={link.id} className="group py-1.5">
                      <div className="flex items-center gap-1.5">
                        <Ticket className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                        <Link
                          href={`/dashboard/support/${link.ticket_id}`}
                          className="text-sm text-gray-700 hover:text-primary-600 font-mono"
                        >
                          {formatTicketNumber(link.ticket_number)}
                        </Link>
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${LINK_TYPE_STYLES[link.link_type] || 'bg-gray-100 text-gray-600'}`}
                        >
                          {link.link_type}
                        </span>
                        <button
                          onClick={() => handleUnlink(link.id)}
                          disabled={unlinking === link.id}
                          className="opacity-0 group-hover:opacity-100 ml-auto p-0.5 text-gray-400 hover:text-red-500 transition-opacity"
                          title="Unlink ticket"
                        >
                          {unlinking === link.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <X className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                      <Link
                        href={`/dashboard/support/${link.ticket_id}`}
                        className="block text-sm text-gray-600 hover:text-primary-600 truncate mt-0.5 pl-5"
                      >
                        {link.subject}
                      </Link>
                      <div className="flex items-center gap-2 mt-0.5 pl-5">
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${TICKET_STATUS_STYLES[link.status] || 'bg-gray-100 text-gray-500'}`}
                        >
                          {link.status.replace('_', ' ')}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {links.length === 0 && !showSearch && (
                <p className="text-xs text-gray-400 py-1">No linked tickets</p>
              )}

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
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search by ticket # or subject..."
                      className="w-full text-sm text-gray-900 bg-white border border-gray-300 rounded-md pl-7 pr-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-500"
                    />
                  </div>

                  <select
                    value={linkType}
                    onChange={(e) => setLinkType(e.target.value as BacklogLinkType)}
                    className="w-full text-xs text-gray-900 border border-gray-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="fix">Type: Fix</option>
                    <option value="related">Type: Related</option>
                    <option value="duplicate">Type: Duplicate</option>
                  </select>

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
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-xs text-gray-500">
                              {formatTicketNumber(result.ticket_number)}
                            </span>
                            <span
                              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${TICKET_STATUS_STYLES[result.status] || 'bg-gray-100 text-gray-500'}`}
                            >
                              {result.status.replace('_', ' ')}
                            </span>
                          </div>
                          <div className="truncate mt-0.5 text-gray-600">
                            {result.subject}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  {!searching && searchQuery.length >= 1 && searchResults.length === 0 && (
                    <p className="text-xs text-gray-400 py-1">No tickets found</p>
                  )}

                  <button
                    onClick={() => {
                      setShowSearch(false);
                      setSearchQuery('');
                      setSearchResults([]);
                      setError(null);
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
