'use client';

/**
 * A submissions-table row that opens its submission when clicked anywhere,
 * matching the dashboard's "Recent Submissions" list, where each row is one
 * block link (app/dashboard/page.tsx). A <tr> cannot be wrapped in an anchor,
 * so the click is handled here; the row's own "Review" link stays the
 * keyboard path (one tab stop per row, Enter opens it) — BACKLOG-3609.
 */

import { useRouter } from 'next/navigation';
import type { MouseEvent, ReactNode } from 'react';
import { startNavigationProgress } from '@/components/pwa/NavigationProgress';

/** Clicks that start on one of these keep that element's own action. */
const INTERACTIVE = 'a, button, input, select, textarea, label, [role="button"]';

interface SubmissionRowProps {
  href: string;
  className?: string;
  children: ReactNode;
}

export function SubmissionRow({ href, className, children }: SubmissionRowProps) {
  const router = useRouter();

  const handleClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const target = event.target as Element | null;
    if (target?.closest(INTERACTIVE)) return;
    // Selecting text in a row should not navigate away.
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    if (selection && selection.toString().length > 0) return;

    if (event.metaKey || event.ctrlKey) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    // Top loading bar: router.push is invisible to the anchor-click listener
    // (BACKLOG-3893).
    startNavigationProgress();
    router.push(href);
  };

  return (
    <tr className={className} onClick={handleClick}>
      {children}
    </tr>
  );
}
