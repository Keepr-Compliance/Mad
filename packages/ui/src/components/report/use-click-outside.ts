'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Calls `callback` when a mousedown event occurs outside the element
 * referenced by `ref`. Attaches the listener only while `enabled` is true
 * (defaults to true).
 *
 * Copied verbatim from admin-portal/hooks/useClickOutside.ts (BACKLOG-3502a);
 * the admin copy stays for its existing importers.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  callback: () => void,
  enabled: boolean = true
) {
  useEffect(() => {
    if (!enabled) return;

    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        callback();
      }
    }

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [ref, callback, enabled]);
}
