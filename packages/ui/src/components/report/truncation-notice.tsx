'use client';

import * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * Report kit — the amber notice a report shows when its query hit the row cap
 * (BACKLOG-3502a). It names the CAP (not the number of rows on screen), the
 * period, and what is affected, and always says the numbers are "a floor, not
 * a total". Render it only when the result was truncated.
 */
export interface TruncationNoticeProps {
  /** Plural noun, e.g. "runs". */
  noun: string;
  /** What the query returns, e.g. "at most 500 rows" or "the 500 most recent exports". */
  capPhrase: React.ReactNode;
  /** e.g. "Last 30 days" (lower-cased in the sentence). */
  periodLabel: string;
  /** What is a floor, e.g. "every count, chart and average". */
  scope: string;
  className?: string;
}

export function TruncationNotice({ noun, capPhrase, periodLabel, scope, className }: TruncationNoticeProps) {
  return (
    <div
      data-slot="truncation-notice"
      data-notice="truncated"
      className={cn('mb-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900', className)}
    >
      <strong>This period holds more {noun} than are shown.</strong> The query returns {capPhrase} and{' '}
      {periodLabel.toLowerCase()} reached that cap — {scope} on this page is therefore a floor, not a total.
      Narrow the period to see all of it.
    </div>
  );
}
