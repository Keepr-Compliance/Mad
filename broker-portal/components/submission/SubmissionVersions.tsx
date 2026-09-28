/**
 * BACKLOG-3597: the other versions of a deal, on its submission page.
 *
 * - On an older version: a notice linking to the newest version.
 * - When older versions exist: "Previous versions", each with its number,
 *   status and date, linking to it.
 * Renders nothing for a deal with a single version.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { formatDate, formatStatus, getStatusColor } from '@/lib/utils';
import type { VersionChain } from '@/lib/submissions/versions';

interface SubmissionVersionsProps extends VersionChain {
  /** Where a version's page lives, without the trailing id. */
  basePath?: string;
}

export function SubmissionVersions({
  previous,
  newest,
  basePath = '/dashboard/submissions',
}: SubmissionVersionsProps) {
  if (previous.length === 0 && !newest) return null;

  return (
    <div className="space-y-4">
      {newest && (
        <div
          role="status"
          data-testid="newer-version-notice"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <span>You are viewing an older version of this submission.</span>
          <Link
            href={`${basePath}/${newest.id}`}
            className="inline-flex items-center gap-1 font-medium text-primary-700 hover:text-primary-800 hover:underline"
          >
            Newer version available: v{newest.number}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      )}

      {previous.length > 0 && (
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
      )}
    </div>
  );
}
