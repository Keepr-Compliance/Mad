'use client';

/**
 * The browser seam (BACKLOG-3450).
 *
 * `useRouter` throws outside an App Router context and the Supabase browser
 * client needs env that a Node test does not have, so BOTH are confined to
 * this wrapper. `IphoneSyncReport` below it takes navigation and the saved-view
 * RPCs as props, and therefore renders in a plain Node test with no mock and no
 * provider — which is what keeps the render controls honest.
 */

import { useRouter } from 'next/navigation';
import { reportViewsApi } from '@/lib/reports/report-views-api';
import { IphoneSyncReport, type IphoneSyncReportProps } from './IphoneSyncReport';

export function IphoneSyncReportClient(
  props: Omit<IphoneSyncReportProps, 'onNavigate' | 'viewsApi'>
) {
  const router = useRouter();
  return (
    <IphoneSyncReport
      {...props}
      onNavigate={(url) => router.push(url, { scroll: false })}
      viewsApi={reportViewsApi}
    />
  );
}
