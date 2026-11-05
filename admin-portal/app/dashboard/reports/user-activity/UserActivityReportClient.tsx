'use client';

/**
 * The browser seam (BACKLOG-3720). `useRouter` is confined here so
 * `UserActivityReport` renders in a plain Node test with no router.
 */

import { useRouter } from 'next/navigation';
import { reportShareApi } from '@/lib/reports/report-share-api';
import { userActivityViewsApi } from '@/lib/reports/user-activity-views-api';
import { UserActivityReport, type UserActivityReportProps } from './UserActivityReport';

export function UserActivityReportClient(props: Omit<UserActivityReportProps, 'onNavigate' | 'viewsApi' | 'shareApi'>) {
  const router = useRouter();
  return (
    <UserActivityReport
      {...props}
      onNavigate={(url) => router.push(url, { scroll: false })}
      viewsApi={userActivityViewsApi}
      shareApi={reportShareApi}
    />
  );
}
