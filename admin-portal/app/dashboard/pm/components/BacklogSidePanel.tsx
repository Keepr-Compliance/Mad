'use client';

/**
 * Collapsible right-side panel showing backlog items not assigned to any sprint.
 * Items are draggable via @dnd-kit so they can be dragged onto the board to assign.
 * Data is received via props -- the parent manages fetching and filtering.
 */

import { useState } from 'react';
import Link from 'next/link';
import { PanelRightClose, PanelRightOpen, Search } from 'lucide-react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { PmBacklogItem } from '@/lib/pm-types';

interface BacklogSidePanelProps {
  isOpen: boolean;
  onToggle: () => void;
  items: PmBacklogItem[];
  loading?: boolean;
  onSearch?: (query: string) => void;
}

export function BacklogSidePanel({
  isOpen,
  onToggle,
  items,
  loading = false,
  onSearch,
}: BacklogSidePanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const { setNodeRef, isOver } = useDroppable({ id: 'backlog-panel' });

  function handleSearch(query: string) {
    setSearchQuery(query);
    onSearch?.(query);
  }

  return (
    <>
      {/* Toggle button when closed */}
      {!isOpen && (
        <button
          onClick={onToggle}
          className="fixed right-0 top-1/2 -translate-y-1/2 bg-white border border-r-0 border-gray-200 rounded-l-lg p-2 shadow-sm hover:bg-gray-50 z-10"
          title="Open backlog panel"
        >
          <PanelRightOpen className="h-4 w-4 text-gray-500" />
        </button>
      )}

      {/* Panel */}
      <div
        className={`transition-all duration-300 ${
          isOpen ? 'w-72 opacity-100' : 'w-0 opacity-0 overflow-hidden'
        } border-l border-gray-200 bg-white flex flex-col flex-shrink-0`}
      >
        {/* Panel header */}
        <div className="flex items-center justify-between p-3 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">Backlog</h3>
          <button
            onClick={onToggle}
            className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
            title="Close backlog panel"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </div>

        {/* Search */}
        <div className="p-3 border-b border-gray-100">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search backlog..."
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 text-gray-900 bg-white"
            />
          </div>
        </div>

        {/* Items list (droppable target for unassigning from sprint) */}
        <div
          ref={setNodeRef}
          className={`flex-1 overflow-y-auto p-2 space-y-1.5 transition-colors ${
            isOver ? 'bg-primary-50 border-primary-200' : ''
          }`}
        >
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 rounded animate-pulse" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-4">
              No unassigned items
            </p>
          ) : (
            items.map((item) => (
              <BacklogPanelItem key={item.id} item={item} />
            ))
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Individual draggable item within the backlog side panel.
 * Uses useDraggable (not useSortable) since items are dragged TO the board,
 * not sorted within the panel.
 */
function BacklogPanelItem({ item }: { item: PmBacklogItem }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `backlog-${item.id}`,
    data: { type: 'backlog-item', item },
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`bg-white border border-gray-200 rounded p-2 cursor-grab active:cursor-grabbing hover:border-primary-300 transition-colors ${
        isDragging ? 'opacity-50' : ''
      }`}
    >
      <span className="text-xs text-gray-400 font-mono">#{item.item_number}</span>
      <Link
        href={`/dashboard/pm/tasks/${item.id}?from=board`}
        className="text-xs text-gray-900 font-medium line-clamp-2 mt-0.5 hover:text-primary-600 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {item.title}
      </Link>
      <div className="flex items-center gap-1.5 mt-1">
        <span className="text-xs text-gray-400">{item.type}</span>
        <span className="text-xs text-gray-300">|</span>
        <span className="text-xs text-gray-400">{item.priority}</span>
      </div>
    </div>
  );
}
