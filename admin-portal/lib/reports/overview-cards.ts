/**
 * Overview cards on the Reports page (BACKLOG-4005)
 *
 * Analytics is a dashboard, not a registry report: it has no saved views and
 * no report key. It shows as a card beside the reports and nowhere else in
 * the nav. Keep this list separate from REPORTS. (Paywall Funnel was a card
 * here until BACKLOG-3722 moved it onto the report kit and into REPORTS.)
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
];
