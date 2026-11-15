/**
 * Reports index sections — BACKLOG-3513 PR-3g.
 *
 * Presentation only: one section, a bordered list of rows, each row the
 * report's name (a link to its page), a one-line summary and when it was last
 * updated. Server-renderable (no hooks).
 */

import Link from 'next/link';
import type { ReactNode } from 'react';

export interface ReportsIndexRow {
  id: string;
  name: string;
  href: string;
  /** null: nothing is shown (e.g. its sharing could not be read). */
  summary: string | null;
  /** null: nothing is shown (no readable time). */
  updated: string | null;
}

export interface ReportsIndexSectionProps {
  id: string;
  title: string;
  rows: ReportsIndexRow[];
  /** Shown instead of the list when there are no rows. */
  empty?: ReactNode;
  testId: string;
}

export function ReportsIndexSection({ id, title, rows, empty, testId }: ReportsIndexSectionProps) {
  return (
    <section className="space-y-2.5" aria-labelledby={id} data-testid={testId}>
      <h2 id={id} className="text-[13px] font-semibold uppercase tracking-wide text-gray-600">
        {title}
      </h2>
      {rows.length === 0 ? (
        empty
      ) : (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
          {rows.map((row) => (
            <li
              key={row.id}
              data-testid="report-row"
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5"
            >
              <Link href={row.href} className="min-w-0 flex-1 basis-48 text-[15px] font-medium text-gray-900 hover:underline">
                {row.name || 'Untitled report'}
              </Link>
              {row.summary ? (
                <span data-testid="report-row-summary" className="text-[13px] text-gray-600">
                  {row.summary}
                </span>
              ) : null}
              {row.updated ? (
                <span data-testid="report-row-updated" className="text-[13px] text-gray-600 sm:w-28 sm:text-right">
                  {row.updated}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
