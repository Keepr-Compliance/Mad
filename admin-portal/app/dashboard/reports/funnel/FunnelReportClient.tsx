'use client';

/**
 * The browser seam (BACKLOG-3722). `useRouter` is confined here so
 * `FunnelReport` renders in a plain Node test with no router.
 */

import { useRouter } from 'next/navigation';
import { funnelViewsApi } from '@/lib/reports/period-only-views-api';
import { FunnelReport, type FunnelReportProps } from './FunnelReport';

export function FunnelReportClient(props: Omit<FunnelReportProps, 'onNavigate' | 'viewsApi'>) {
  const router = useRouter();
  return (
    <FunnelReport {...props} onNavigate={(url) => router.push(url, { scroll: false })} viewsApi={funnelViewsApi} />
  );
}
