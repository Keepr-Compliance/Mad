'use client';

/**
 * The browser seam (BACKLOG-3720). `useRouter` is confined here so
 * `UserActivityReport` renders in a plain Node test with no router.
 */

import { useRouter } from 'next/navigation';
import { UserActivityReport, type UserActivityReportProps } from './UserActivityReport';

export function UserActivityReportClient(props: Omit<UserActivityReportProps, 'onNavigate'>) {
  const router = useRouter();
  return <UserActivityReport {...props} onNavigate={(url) => router.push(url, { scroll: false })} />;
}
