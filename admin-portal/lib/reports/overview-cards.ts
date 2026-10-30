/**
 * Overview cards on the Reports page (BACKLOG-4005)
 *
 * Analytics and Funnel are dashboards, not registry reports: they have no
 * saved views and no report key. They show as cards beside the reports and
 * nowhere else in the nav. Keep this list separate from REPORTS.
 */

import { PERMISSIONS, type PermissionKey } from '@/lib/permissions';
import { REPORTS_BASE_PATH } from './registry';

export interface OverviewCard {
  key: string;
  title: string;
  description: string;
  href: string;
  permission: PermissionKey;
}

export const OVERVIEW_CARDS: OverviewCard[] = [
  {
    key: 'analytics',
    title: 'Analytics',
    description: 'System-wide metrics and adoption data.',
    href: `${REPORTS_BASE_PATH}/analytics`,
    permission: PERMISSIONS.ANALYTICS_VIEW,
  },
  {
    key: 'funnel',
    title: 'Paywall Funnel',
    description: 'Paywall viewed, unlock clicked, payment succeeded, export completed. Where do users drop off?',
    href: `${REPORTS_BASE_PATH}/funnel`,
    permission: PERMISSIONS.ANALYTICS_VIEW,
  },
];
