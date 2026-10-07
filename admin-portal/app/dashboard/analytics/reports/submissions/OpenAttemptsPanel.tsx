/**
 * Submissions report — open attempts (BACKLOG-3715)
 *
 * Every attempt still `in_progress`, whatever the period, oldest first and
 * capped. Renders whether or not the period has rows.
 */

import { AlertTriangle } from 'lucide-react';
import {
  STALL_MINUTES,
  SWEEP_WINDOW_MINUTES,
  type Submission,
} from '@/lib/reports/submissions';
import { StatusChip } from './SubmissionCard';

function formatOpenFor(minutes: number | null): string {
  if (minutes == null) return '—';
  if (minutes < 60) return `${Math.floor(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  return `${h} h ${m} min`;
}

export const STALLED_DEFINITION = `Stalled = open ${STALL_MINUTES} min or more. The app does not report progress after it starts, so a large upload can show here while still running.`;

export const SWEEP_WINDOW_WARNING = `Open ${SWEEP_WINDOW_MINUTES / 60} h+ — past the window in which the server sweep normally clears an upload that stopped sending files. If it was still sending files, this is expected.`;

export function OpenAttemptsPanel({
  attempts,
  failed,
  truncated,
  cap,
}: {
  attempts: Submission[];
  failed: boolean;
  truncated: boolean;
  cap: number;
}) {
  return (
    <section data-open-attempts-panel="" className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold text-gray-900">Open attempts</h2>
      <p className="mt-1 text-xs text-gray-500">
        Every attempt that has not finished, from any date, oldest first. {STALLED_DEFINITION}
      </p>
      <p className="mt-1 text-xs text-gray-500">
        This report cannot tell a sweep that is not running from an app that stopped before it
        created the submission; in the second case there is nothing for the sweep to clear and the
        attempt stays open here.
      </p>

      {failed ? (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          The open attempts could not be read. This is a query failure, not a true zero.
        </div>
      ) : null}

      {truncated ? (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <strong>More attempts are open than are shown.</strong> This panel lists at most {cap}, the
          oldest first.
        </div>
      ) : null}

      {!failed && attempts.length === 0 ? (
        <p className="mt-3 text-sm text-gray-700">No attempts are open right now.</p>
      ) : null}

      {attempts.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th scope="col" className="py-2 px-3 font-medium">Started</th>
                <th scope="col" className="py-2 px-3 font-medium">Open for</th>
                <th scope="col" className="py-2 px-3 font-medium">Status</th>
                <th scope="col" className="py-2 px-3 font-medium">Agent</th>
                <th scope="col" className="py-2 px-3 font-medium">Organization</th>
                <th scope="col" className="py-2 px-3 font-medium">Submission</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id} data-open-attempt={a.submissionId} className="border-b border-gray-100 last:border-0 align-top">
                  <td className="whitespace-nowrap py-2 px-3 text-gray-700">{a.whenUtc}</td>
                  <td className="whitespace-nowrap py-2 px-3 tabular-nums text-gray-700">
                    {formatOpenFor(a.openMinutes)}
                  </td>
                  <td className="py-2 px-3">
                    <StatusChip submission={a} />
                    {a.pastSweepWindow ? (
                      <p data-sweep-window="" className="mt-1 flex items-start gap-1 text-xs text-red-700">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                        {SWEEP_WINDOW_WARNING}
                      </p>
                    ) : null}
                  </td>
                  <td className="py-2 px-3 text-gray-900">{a.agentLabel}</td>
                  <td className="py-2 px-3 text-gray-700">{a.orgLabel}</td>
                  <td className="py-2 px-3 font-mono text-xs text-gray-700">{a.shortId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
