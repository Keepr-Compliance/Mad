'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'pm-project-backlog-width';
const DEFAULT_WIDTH = 33; // percent of the container
const MIN_WIDTH = 20;
const MAX_WIDTH = 60;
// Side-by-side split only applies at >=1200px; below that the columns stack
// (Backlog on top, Sprints below) so the Sprints column is never clipped by a
// narrow viewport. Keep this in sync with the `min-[1200px]:` Tailwind variants
// in page.tsx.
const LG_QUERY = '(min-width: 1200px)';

function clamp(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));
}

/**
 * Drives a horizontally-resizable two-column split (Backlog | Sprints).
 *
 * The left column's width is expressed as a percentage of the container and
 * persisted to localStorage, so a user's chosen split survives reloads.
 * Resizing only applies on wide screens (>=1200px); below that the layout
 * stacks vertically and the width is ignored (`isLarge` is false).
 */
export function useResizableColumn() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [isLarge, setIsLarge] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Restore persisted width on mount.
  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      const parsed = Number(stored);
      if (Number.isFinite(parsed)) setWidth(clamp(parsed));
    }
  }, []);

  // Track the large-screen media query so resizing is disabled when stacked.
  useEffect(() => {
    const mql = window.matchMedia(LG_QUERY);
    const update = () => setIsLarge(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);

  // Global pointer listeners are attached only while actively dragging.
  useEffect(() => {
    if (!dragging) return;

    const handleMove = (e: PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0) return;
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setWidth(clamp(pct));
    };

    const stop = () => setDragging(false);

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', stop);

    // Suppress text selection / cursor flicker while dragging.
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', stop);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [dragging]);

  // Persist the chosen width (cheap write; fine to run on each settle).
  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, String(width));
  }, [width]);

  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const resetWidth = useCallback(() => setWidth(DEFAULT_WIDTH), []);

  return { containerRef, width, isLarge, dragging, startDrag, resetWidth };
}
