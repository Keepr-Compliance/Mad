'use client';

import * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * Report kit — the line under a paged table (BACKLOG-3502a):
 * "Showing 5 of 24 finished runs, newest first" + "Show 5 more" + "Show all".
 *
 * "Show N more" says what the click will actually add: the step, or what is
 * left when less than a step remains (7 rows, step 5 -> "Show 2 more"). Both
 * buttons disappear once everything is shown; nothing renders for zero rows.
 */
export interface ShowMoreFooterProps {
  shown: number;
  total: number;
  noun: { one: string; other: string };
  /** Appended after a comma, e.g. "newest first". */
  suffix?: string;
  /** Rows added per "Show more". Default 5. */
  step?: number;
  onShowMore: () => void;
  /** Omit to hide "Show all". */
  onShowAll?: () => void;
  className?: string;
}

const LINK = 'text-sm font-medium text-primary-600 hover:text-primary-800';

export function ShowMoreFooter({
  shown,
  total,
  noun,
  suffix,
  step = 5,
  onShowMore,
  onShowAll,
  className,
}: ShowMoreFooterProps) {
  if (total <= 0) return null;
  const more = total - shown;
  return (
    <div data-slot="show-more-footer" className={cn('mt-3 flex flex-wrap items-center gap-3', className)}>
      <p className="text-sm text-gray-500">
        Showing {shown} of {total} {total === 1 ? noun.one : noun.other}
        {suffix ? `, ${suffix}` : ''}
      </p>
      {more > 0 ? (
        <>
          <button type="button" onClick={onShowMore} className={LINK}>
            Show {Math.min(step, more)} more
          </button>
          {onShowAll ? (
            <button type="button" onClick={onShowAll} className={LINK}>
              Show all
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
