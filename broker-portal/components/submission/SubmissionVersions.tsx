/**
 * BACKLOG-3597: the other versions of a deal, on its submission page.
 *
 * - On an older version: a notice linking to the newest version. While the
 *   page is open, a newer version sent later shows the same notice
 *   (NewerVersionNotice, BACKLOG-3605).
 * - When older versions exist: "Previous versions", each with its number,
 *   status and date, linking to it.
 * Renders nothing visible for a deal with a single version until a newer one
 * arrives.
 */

import Link from 'next/link';
import { formatDate, formatStatus, getStatusColor } from '@/lib/utils';
import type { VersionChain } from '@/lib/submissions/versions';
import { NewerVersionNotice } from './NewerVersionNotice';

interface SubmissionVersionsProps extends VersionChain {
  /** Where a version's page lives, without the trailing id. */
  basePath?: string;
  /** The version being viewed (BACKLOG-3605: what the notice polls from). */
  currentId?: string;
  /** Poll for a newer version while the page is open. Off for support sessions. */
  poll?: boolean;
}

export function SubmissionVersions({
  previous,
  newest,
  basePath = '/dashboard/submissions',
  currentId,
  poll = false,
}: SubmissionVersionsProps) {
  const notice = (
    <NewerVersionNotice
      newest={newest}
      currentId={currentId}
      currentPosition={previous.length + 1}
      poll={poll}
      basePath={basePath}
    />
  );
  // No wrapper when there are no previous versions: the notice alone, which
  // renders nothing until there is a newer version to show.
  if (previous.length === 0) return notice;

  return (
    <div className="space-y-4">
      {notice}

      <details
        data-testid="previous-versions"
        className="bg-white shadow-sm border border-gray-200 rounded-lg"
      >
        <summary className="cursor-pointer select-none px-6 py-4 text-sm font-medium text-gray-900">
          Previous versions ({previous.length})
        </summary>
        <ul className="divide-y divide-gray-200 border-t border-gray-200">
          {previous.map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-4 px-6 py-3 text-sm">
              <Link
                href={`${basePath}/${v.id}`}
                className="font-medium text-primary-600 hover:text-primary-700 hover:underline"
              >
                Version {v.number}
              </Link>
              <span className="flex items-center gap-3 text-gray-500">
                {v.status && (
                  <span
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(v.status)}`}
                  >
                    {formatStatus(v.status)}
                  </span>
                )}
                <span>{formatDate(v.createdAt)}</span>
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
