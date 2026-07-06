'use client';

/**
 * DroppableContainer -- Reusable drop target wrapper for the project detail page.
 *
 * Wraps children with @dnd-kit's useDroppable.
 * Shows a primary ring/highlight when an item is being dragged over it.
 */

import type { ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';

interface DroppableContainerProps {
  /** Unique droppable id (sprint id or 'backlog-panel') */
  droppableId: string;
  children: ReactNode;
  className?: string;
}

export function DroppableContainer({
  droppableId,
  children,
  className = '',
}: DroppableContainerProps) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });

  return (
    <div
      ref={setNodeRef}
      className={`transition-all duration-150 rounded-lg ${
        isOver ? 'ring-2 ring-primary-400 bg-primary-50/50' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}
