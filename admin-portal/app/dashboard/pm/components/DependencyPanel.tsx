'use client';

/**
 * DependencyPanel - PM Item Detail Sidebar
 *
 * Shows "Depends On" and "Blocks" sections for a backlog item.
 * Supports adding/removing dependencies with circular dependency
 * validation feedback from the RPC.
 */

import { useState, useRef } from 'react';
import Link from 'next/link';
import { X, Plus, Loader2, AlertCircle } from 'lucide-react';
import {
  addDependency,
  removeDependency,
} from '@/lib/pm-queries';
import type { PmDependency } from '@/lib/pm-types';
import { useItemSearch } from '@/hooks/useItemSearch';

interface DependencyPanelProps {
  itemId: string;
  dependencies: PmDependency[];
  onUpdate: () => void;
}

/**
 * Simple helper to render a dependency row.
 * In a real scenario with fully joined data, the dependency would include
 * target title/legacy_id. For now, we show the target_id or source_id.
 */

export function DependencyPanel({ itemId, dependencies, onUpdate }: DependencyPanelProps) {
  const [expanded, setExpanded] = useState(true);

  // Search state for adding new dependencies
  const [addingType, setAddingType] = useState<'depends_on' | 'blocks' | null>(null);
  const [linking, setLinking] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { query: searchQuery, setQuery: setSearchQuery, results: searchResults, searching, error: searchError, reset: resetSearch } = useItemSearch({ excludeId: itemId });
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Split dependencies into depends_on and blocks
  const dependsOn = dependencies.filter(
    (d) => d.dependency_type === 'depends_on' && d.source_id === itemId
  );
  const blocks = dependencies.filter(
    (d) => d.dependency_type === 'blocks' && d.source_id === itemId
  );
  // Also show reverse: items that depend on this one / block this one
  const dependedOnBy = dependencies.filter(
    (d) => d.dependency_type === 'depends_on' && d.target_id === itemId
  );
  const blockedBy = dependencies.filter(
    (d) => d.dependency_type === 'blocks' && d.target_id === itemId
  );

  const totalCount = dependsOn.length + blocks.length + dependedOnBy.length + blockedBy.length;

  // Focus search input when search type is selected
  // (setTimeout to wait for DOM render)
  const prevAddingType = useRef(addingType);
  if (addingType !== prevAddingType.current) {
    prevAddingType.current = addingType;
    if (addingType) {
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }

  async function handleAdd(targetId: string) {
    if (!addingType) return;
    setLinking(true);
    setError(null);
    try {
      await addDependency(itemId, targetId, addingType);
      resetSearch();
      setAddingType(null);
      onUpdate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('circular') || msg.includes('cycle')) {
        setError('Cannot add: this would create a circular dependency');
      } else {
        setError(msg || 'Failed to add dependency');
      }
    } finally {
      setLinking(false);
    }
  }

  async function handleRemove(dependencyId: string) {
    setRemoving(dependencyId);
    setError(null);
    try {
      await removeDependency(dependencyId);
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove dependency');
    } finally {
      setRemoving(null);
    }
  }

  function renderDepRow(dep: PmDependency, targetId: string) {
    const displayLabel = dep.related_title
      ? `${dep.related_item_number ? `#${dep.related_item_number} ` : ''}${dep.related_title}`
      : targetId.slice(0, 8) + '...';

    return (
      <div key={dep.id} className="group flex items-center gap-2 py-1">
        <Link
          href={`/dashboard/pm/tasks/${targetId}`}
          className="text-sm text-gray-700 hover:text-primary-600 truncate flex-1"
          title={displayLabel}
        >
          {displayLabel}
        </Link>
        {dep.related_status && (
          <span className="text-xs text-gray-400 capitalize shrink-0">
            {dep.related_status.replaceAll('_', ' ')}
          </span>
        )}
        <button
          onClick={() => handleRemove(dep.id)}
          disabled={removing === dep.id}
          className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-red-500 transition-opacity"
          title="Remove dependency"
        >
          {removing === dep.id ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <X className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    );
  }

  function renderSearchUI() {
    return (
      <div className="mt-2 space-y-2">
        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search items..."
          className="w-full text-sm text-gray-900 bg-white border border-gray-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-500"
        />

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
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {searchResults.map((result) => (
              <button
                key={result.id}
                onClick={() => handleAdd(result.id)}
                disabled={linking}
                className="w-full text-left px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-50 rounded-md disabled:opacity-50 transition-colors"
              >
                <div className="truncate">
                  {result.title}
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
            setAddingType(null);
            resetSearch();
            setError(null);
          }}
          className="text-xs text-gray-500 hover:text-gray-700"
        >
          Cancel
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
          Dependencies ({totalCount})
        </span>
        <span className="text-xs text-gray-400">
          {expanded ? '\u25B2' : '\u25BC'}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-3">
          {error && (
            <div className="flex items-start gap-1.5 text-xs text-red-600 py-1">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              {error}
            </div>
          )}

          {/* Depends On section */}
          <div>
            <h4 className="text-xs font-medium text-gray-500 mb-1">Depends On</h4>
            {dependsOn.length > 0 ? (
              <div className="space-y-0.5">
                {dependsOn.map((dep) => renderDepRow(dep, dep.target_id))}
              </div>
            ) : (
              <p className="text-xs text-gray-400">None</p>
            )}
            {addingType === 'depends_on' ? (
              renderSearchUI()
            ) : (
              <button
                onClick={() => setAddingType('depends_on')}
                className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium mt-1"
              >
                <Plus className="h-3 w-3" />
                Add dependency
              </button>
            )}
          </div>

          {/* Blocks section */}
          <div>
            <h4 className="text-xs font-medium text-gray-500 mb-1">Blocks</h4>
            {blocks.length > 0 ? (
              <div className="space-y-0.5">
                {blocks.map((dep) => renderDepRow(dep, dep.target_id))}
              </div>
            ) : (
              <p className="text-xs text-gray-400">None</p>
            )}
            {addingType === 'blocks' ? (
              renderSearchUI()
            ) : (
              <button
                onClick={() => setAddingType('blocks')}
                className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium mt-1"
              >
                <Plus className="h-3 w-3" />
                Add blocker
              </button>
            )}
          </div>

          {/* Blocked By section (read-only, reverse of "blocks") */}
          {blockedBy.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-red-500 mb-1">Blocked By</h4>
              <div className="space-y-0.5">
                {blockedBy.map((dep) => {
                  const label = dep.related_title
                    ? `${dep.related_item_number ? `#${dep.related_item_number} ` : ''}${dep.related_title}`
                    : dep.source_id.slice(0, 8) + '...';
                  return (
                    <div key={dep.id} className="py-1 flex items-center gap-2">
                      <Link
                        href={`/dashboard/pm/tasks/${dep.source_id}`}
                        className="text-sm text-gray-700 hover:text-primary-600 truncate flex-1"
                        title={label}
                      >
                        {label}
                      </Link>
                      {dep.related_status && (
                        <span className="text-xs text-gray-400 capitalize shrink-0">
                          {dep.related_status.replaceAll('_', ' ')}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Depended on by section (read-only) */}
          {dependedOnBy.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-gray-500 mb-1">Depended On By</h4>
              <div className="space-y-0.5">
                {dependedOnBy.map((dep) => {
                  const label = dep.related_title
                    ? `${dep.related_item_number ? `#${dep.related_item_number} ` : ''}${dep.related_title}`
                    : dep.source_id.slice(0, 8) + '...';
                  return (
                    <div key={dep.id} className="py-1 flex items-center gap-2">
                      <Link
                        href={`/dashboard/pm/tasks/${dep.source_id}`}
                        className="text-sm text-gray-700 hover:text-primary-600 truncate flex-1"
                        title={label}
                      >
                        {label}
                      </Link>
                      {dep.related_status && (
                        <span className="text-xs text-gray-400 capitalize shrink-0">
                          {dep.related_status.replaceAll('_', ' ')}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
