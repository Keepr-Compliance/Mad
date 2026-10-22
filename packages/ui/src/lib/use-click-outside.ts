'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Calls `callback` on a pointerdown outside the element referenced by `ref`.
 * Listens only while `enabled` is true. `pointerdown` covers mouse, pen and
 * touch.
 *
 * Same shape as report/use-click-outside.ts on the release-2.43 line (which
 * listens on mousedown); dedupe the two when that line reaches develop.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  callback: () => void,
  enabled: boolean = true
) {
  useEffect(() => {
    if (!enabled) return;
    function handle(e: Event) {
      if (ref.current && !ref.current.contains(e.target as Node)) callback();
    }
    document.addEventListener('pointerdown', handle);
    return () => document.removeEventListener('pointerdown', handle);
  }, [ref, callback, enabled]);
}
