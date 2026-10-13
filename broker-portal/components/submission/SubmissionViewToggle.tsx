'use client';

/**
 * List / Board toggle for the Submissions page header — BACKLOG-3914.
 * Desktop only (md and up): the caller's wrapper hides it below md. Link mode
 * of the kit SegmentedTabs, rendered with next/link (a client component, so
 * the server page passes only data, never the link renderer).
 */

import Link from 'next/link';
import { SegmentedTabs } from '@keepr/ui';

export function SubmissionViewToggle({
  view,
  listHref,
  boardHref,
}: {
  view: 'list' | 'board';
  listHref: string;
  boardHref: string;
}) {
  return (
    <SegmentedTabs
      ariaLabel="View"
      value={view}
      items={[
        { value: 'list', label: 'List', href: listHref },
        { value: 'board', label: 'Board', href: boardHref },
      ]}
      renderLink={({ href, className, children, ...rest }) => (
        <Link href={href} className={className} aria-current={rest['aria-current']}>
          {children}
        </Link>
      )}
    />
  );
}
