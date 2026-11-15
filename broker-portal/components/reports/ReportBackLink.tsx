'use client';

/**
 * "← Back" on a report page — BACKLOG-3513 PR-3c (founder QA).
 *
 * Goes to the page the person came from in this tab when that page is in this portal; otherwise
 * (a direct link, a new tab, arriving from another site) to the Reports index. Local to the
 * reports pages; a kit BackButton is BACKLOG-4241.
 *
 * Look copied from the portal's detail pages: app/dashboard/my-transactions/[id]/page.tsx:280-283
 * (a text link with ArrowLeft above the page header). The href is the Reports index, so the link
 * still works without JavaScript and opens the index in a new tab.
 *
 * The phone top bar shows a title only (lib/dashboard-page-titles.ts, no back arrow), so this link
 * is the back control on every width.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

export const REPORTS_INDEX_PATH = '/dashboard/reports';

/**
 * Whether going back stays inside this portal. `history.length` 1 = nothing to go back to (a new
 * tab); a referrer from another origin, or none, = the person did not come from a portal page.
 * Client-side navigations keep the tab's first referrer, which is this portal's own origin for
 * anyone who signed in or opened the portal and then moved around in it.
 */
export function canGoBackInApp(input: { historyLength: number; referrer: string; origin: string }): boolean {
  if (input.historyLength <= 1 || !input.referrer) return false;
  try {
    return new URL(input.referrer).origin === input.origin;
  } catch {
    return false;
  }
}

export function ReportBackLink() {
  const router = useRouter();
  return (
    <Link
      href={REPORTS_INDEX_PATH}
      data-testid="report-back-link"
      className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        if (!canGoBackInApp({ historyLength: window.history.length, referrer: document.referrer, origin: window.location.origin })) return;
        e.preventDefault();
        router.back();
      }}
    >
      <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
      Back
    </Link>
  );
}
