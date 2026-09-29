'use client';

/**
 * BACKLOG-3597 / BACKLOG-3605: the "newer version" notice on a submission page.
 *
 * One notice from two sources: the newest version the server found when the
 * page was rendered (`newest`), or, when there was none, the one the poll
 * finds while the page is open. The server's answer always wins and switches
 * the poll off, so a router.refresh() that brings a server answer after the
 * poll already found one still shows exactly one notice.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { VersionLink } from '@/lib/submissions/versions';
import { useNewerVersionPoll } from '@/hooks/useNewerVersionPoll';

interface NewerVersionNoticeProps {
  /** The newest version as the server found it, or null. */
  newest: VersionLink | null;
  /** The version being viewed; without it there is nothing to poll for. */
  currentId?: string;
  /** Position of the version being viewed in its chain (1 = the first). */
  currentPosition: number;
  /** Poll for a newer version while the page is open (off for support sessions). */
  poll: boolean;
  basePath: string;
}

export function NewerVersionNotice({ newest, currentId, currentPosition, poll, basePath }: NewerVersionNoticeProps) {
  const found = useNewerVersionPoll({
    currentId: currentId ?? '',
    currentPosition,
    enabled: poll && !!currentId && !newest,
  });
  const shown = newest ?? found;
  if (!shown) return null;

  return (
    <div
      role="status"
      data-testid="newer-version-notice"
      className="flex flex-wrap items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <span>A newer version was submitted —</span>{' '}
      <Link
        href={`${basePath}/${shown.id}`}
        className="inline-flex items-center gap-1 font-medium text-primary-700 hover:text-primary-800 hover:underline"
      >
        View v{shown.number}
        <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  );
}
