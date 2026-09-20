/**
 * Report registry (BACKLOG-3441)
 *
 * The one place a new report is registered. Adding a report means adding a row
 * here and a folder under `app/dashboard/analytics/reports/<slug>/` — the
 * sidebar never changes again.
 */

import { PERMISSIONS, type PermissionKey } from '@/lib/permissions';

export interface ReportEntry {
  slug: string;
  title: string;
  /** One sentence: what question this report answers. */
  description: string;
  /** What it is built from, so the reader knows the source without opening it. */
  source: string;
  permission: PermissionKey;
}

export const REPORTS_BASE_PATH = '/dashboard/analytics/reports';

export const REPORTS: ReportEntry[] = [
  {
    slug: 'iphone-sync',
    title: 'iPhone Sync Performance',
    description:
      'How long each iPhone sync took, where the time went phase by phase, and which runs burned time without extracting anything.',
    source: 'sync_outcomes',
    permission: PERMISSIONS.ANALYTICS_VIEW,
  },
];

export function reportHref(slug: string): string {
  return `${REPORTS_BASE_PATH}/${slug}`;
}
