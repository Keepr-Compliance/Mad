'use client';

import * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * Phone kit — action bar pinned to the bottom edge below `md` (1–2 actions).
 *
 * Bottom stacking (DESIGN-SYSTEM.md → Phone): while mounted the bar publishes
 * its rendered height (safe-area padding included) as the CSS variable
 * `--keepr-action-bar-h` on the root element; the Toast and the offline banner
 * offset themselves by it. Put `stickyActionBarSpacerClass` on the scrolling
 * content so the bar never covers its last row.
 *
 * Consumers: BACKLOG-3899 (ticket conversation), BACKLOG-3900 (projects),
 * BACKLOG-3901 (plans), BACKLOG-3902 (broker users).
 */
export const ACTION_BAR_HEIGHT_VAR = '--keepr-action-bar-h';

/** Bottom padding for content that scrolls under the bar (phone only). */
export const stickyActionBarSpacerClass =
  'pb-[calc(var(--keepr-action-bar-h,0px)_+_16px)] md:pb-0';

export interface StickyActionBarProps {
  children: React.ReactNode;
  variant?: 'light' | 'dark';
  className?: string;
}

export function StickyActionBar({ children, variant = 'light', className }: StickyActionBarProps) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof document === 'undefined') return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty(ACTION_BAR_HEIGHT_VAR, `${el.getBoundingClientRect().height}px`);
    publish();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(publish);
      ro.observe(el);
    }
    return () => {
      ro?.disconnect();
      root.style.removeProperty(ACTION_BAR_HEIGHT_VAR);
    };
  }, []);

  return (
    <div
      ref={ref}
      data-testid="sticky-action-bar"
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t px-4 pb-[calc(env(safe-area-inset-bottom,0px)_+_12px)] pt-3 md:hidden',
        variant === 'dark' ? 'border-gray-800 bg-gray-900 text-white' : 'border-gray-200 bg-white',
        className
      )}
    >
      {children}
    </div>
  );
}
