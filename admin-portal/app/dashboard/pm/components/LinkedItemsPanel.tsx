'use client';

/**
 * LinkedItemsPanel - PM Item Detail Sidebar
 *
 * Collapsible section showing linked backlog items with link types
 * (blocked_by, blocks, related_to, parent_child, duplicates).
 * Includes inline search to link additional items with type selection.
 *
 * Pattern: Adapted from support/RelatedTicketsPanel.tsx
 */

import { useState, useRef } from 'react';
import Link from 'next/link';
import { Link2, X, Plus, Loader2 } from 'lucide-react';
import {
  linkItems,
  unlinkItems,
} from '@/lib/pm-queries';
import type { PmTaskLink, LinkType } from '@/lib/pm-types';
import { STATUS_COLORS } from '@/lib/pm-types';
import { useItemSearch } from '@/hooks/useItemSearch';

interface LinkedItemsPanelProps {
  itemId: string;
  links: PmTaskLink[];
  onUpdate: () => void;
}

/**
 * Display-level link type that splits 'parent_child' into separate
 * 'parent' and 'child' options so users can choose directionality.
 */
type DisplayLinkType = Exclude<LinkType, 'parent_child'> | 'parent' | 'child';

const DISPLAY_LINK_TYPE_LABELS: Record<DisplayLinkType, string> = {
  blocked_by: 'Blocked By',
  blocks: 'Blocks',
  related_to: 'Related',
  parent: 'Parent of',
  child: 'Child of',
  duplicates: 'Duplicates',
};

/**
 * Resolve the display label for a stored link, taking direction into account
 * so that parent_child links render as "Parent of" or "Child of".
 */
function getLinkDisplayLabel(link: PmTaskLink): string {
  if (link.link_type === 'parent_child') {
    // outgoing = this item is the source (parent), incoming = this item is the child
    return link.direction === 'outgoing' ? 'Parent of' : 'Child of';
  }
  return DISPLAY_LINK_TYPE_LABELS[link.link_type] ?? link.link_type;
}

export function LinkedItemsPanel({ itemId, links, onUpdate }: LinkedItemsPanelProps) {
  const [expanded, setExpanded] = useState(true);

  // Link search state
  const [showSearch, setShowSearch] = useState(false);
  const [linkType, setLinkType] = useState<DisplayLinkType>('related_to');
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { query: searchQuery, setQuery: setSearchQuery, results: searchResults, searching, error: searchError, reset: resetSearch } = useItemSearch({ excludeId: itemId });
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Focus search input when search panel opens
  const prevShowSearch = useRef(showSearch);
  if (showSearch !== prevShowSearch.current) {
    prevShowSearch.current = showSearch;
    if (showSearch) {
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }

  async function handleLink(targetItemId: string) {
    setLinking(true);
    setError(null);
    try {
      if (linkType === 'parent') {
        // "Parent of" => current item is parent (source), target is child
        await linkItems(itemId, targetItemId, 'parent_child');
      } else if (linkType === 'child') {
        // "Child of" => target item is parent (source), current item is child
        await linkItems(targetItemId, itemId, 'parent_child');
      } else {
        await linkItems(itemId, targetItemId, linkType);
      }
      resetSearch();
      setShowSearch(false);
      onUpdate();
    } catch (err) {
      console.error('Failed to link item:', err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('unique') || msg.includes('duplicate')) {
        setError('These items are already linked');
      } else {
        setError(msg || 'Failed to link item');
      }
    } finally {
      setLinking(false);
    }
  }

  async function handleUnlink(linkId: string) {
    setUnlinking(linkId);
    setError(null);
    try {
      await unlinkItems(linkId);
      onUpdate();
    } catch (err) {
      console.error('Failed to unlink item:', err);
      setError(err instanceof Error ? err.message : 'Failed to unlink item');
    } finally {
      setUnlinking(null);
    }
  }

  function getStatusColor(status: string): string {
    return (STATUS_COLORS as Record<string, string>)[status] || 'bg-gray-100 text-gray-800';
  }

  function renderLinkRow(link: PmTaskLink) {
    return (
      <div key={link.link_id} className="group flex items-start gap-2 py-1.5">
        <Link2 className="h-3.5 w-3.5 text-blue-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <Link
            href={`/dashboard/pm/tasks/${link.item_id}`}
            className="block text-sm text-gray-700 hover:text-primary-600 truncate"
          >
            {link.item_title}
          </Link>
          <div className="flex items-center gap-2 mt-0.5">
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${getStatusColor(link.item_status)}`}
            >
              {link.item_status.replace('_', ' ')}
            </span>
            <span className="text-xs text-gray-400">
              {getLinkDisplayLabel(link)}
            </span>
          </div>
        </div>
        <button
          onClick={(e) => {
            e.preventDefault();
            handleUnlink(link.link_id);
          }}
          disabled={unlinking === link.link_id}
          className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-red-500 transition-opacity"
          title="Unlink item"
        >
          {unlinking === link.link_id ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <X className="h-3.5 w-3.5" />
          )}
        </button>
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
          Linked Items ({links.length})
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

          {links.length > 0 && (
            <div className="space-y-0.5">
              {links.map((link) => renderLinkRow(link))}
            </div>
          )}

          {links.length === 0 && !showSearch && (
            <p className="text-xs text-gray-400 py-1">No linked items</p>
          )}

          {!showSearch ? (
            <button
              onClick={() => setShowSearch(true)}
              className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium mt-2"
            >
              <Plus className="h-3.5 w-3.5" />
              Link Item
            </button>
          ) : (
            <div className="mt-3 space-y-2">
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by ID or title..."
                className="w-full text-sm text-gray-900 bg-white border border-gray-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />

              <select
                value={linkType}
                onChange={(e) => setLinkType(e.target.value as DisplayLinkType)}
                className="w-full text-xs text-gray-900 border border-gray-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                {(Object.entries(DISPLAY_LINK_TYPE_LABELS) as [DisplayLinkType, string][]).map(
                  ([value, label]) => (
                    <option key={value} value={value}>
                      Type: {label}
                    </option>
                  )
                )}
              </select>

              {searching && (
                <div className="flex items-center gap-2 text-xs text-gray-400 py-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Searching...
                </div>
              )}

              {searchError && !searching && (
                <p className="text-xs text-red-500 py-1">Search failed: {searchError}</p>
              )}

              {!searching && !searchError && searchResults.length > 0 && (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {searchResults.map((result) => (
                    <button
                      key={result.id}
                      onClick={() => handleLink(result.id)}
                      disabled={linking}
                      className="w-full text-left px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-50 rounded-md disabled:opacity-50 transition-colors"
                    >
                      <div className="truncate">
                        {result.title}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${getStatusColor(result.status)}`}
                        >
                          {result.status.replace('_', ' ')}
                        </span>
                        <span className="text-xs text-gray-400">{result.type}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {!searching && !searchError && searchQuery.length >= 1 && searchResults.length === 0 && (
                <p className="text-xs text-gray-400 py-1">No items found</p>
              )}

              <button
                onClick={() => {
                  setShowSearch(false);
                  resetSearch();
                }}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
