/**
 * Report registry (BACKLOG-3441)
 *
 * The one place a new report is registered. Adding a report means adding a row
 * here and a folder under `app/dashboard/reports/<slug>/` — the
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

export const REPORTS_BASE_PATH = '/dashboard/reports';

export const REPORTS: ReportEntry[] = [
  {
    slug: 'iphone-sync',
    title: 'iPhone Sync Performance',
    description:
      'How long each iPhone sync took, where the time went phase by phase, and which runs burned time without extracting anything.',
    source: 'sync_outcomes',
    permission: PERMISSIONS.ANALYTICS_VIEW,
  },
  {
    slug: 'google-messages-sync',
    title: 'Google Messages Sync Performance',
    description:
      'How long each Google Messages Sync took per stage (finding, reading, saving), how many chats and messages it moved, and why runs did not complete.',
    source: 'sync_outcomes',
    permission: PERMISSIONS.ANALYTICS_VIEW,
  },
  {
    slug: 'submissions',
    title: 'Submissions',
    description:
      'Every submit attempt: which committed, which failed and where, and which are still open or stalled.',
    source: 'submission_attempts',
    permission: PERMISSIONS.ANALYTICS_VIEW,
  },
  {
    slug: 'exports',
    title: 'Exports',
    description:
      'How many exports each user ran in the period, how many were unique deals, in which formats, and when.',
    source: 'analytics_events (export-completed)',
    permission: PERMISSIONS.ANALYTICS_VIEW,
  },
  {
    slug: 'user-activity',
    title: 'User Activity',
    description:
      'Who signed in and was last seen when, on how many devices, and how many transactions, submissions and exports each user ran in the period.',
    source: 'users, devices, audit_logs',
    permission: PERMISSIONS.ANALYTICS_VIEW,
  },
];

export function reportHref(slug: string): string {
  return `${REPORTS_BASE_PATH}/${slug}`;
}
