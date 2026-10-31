'use client';

/**
 * The browser seam (BACKLOG-3723). `useRouter` is confined here so
 * `AnalyticsReport` renders in a plain Node test with no router.
 */

import { useRouter } from 'next/navigation';
import { AnalyticsReport, type AnalyticsReportProps } from './AnalyticsReport';

export function AnalyticsReportClient(props: Omit<AnalyticsReportProps, 'onNavigate'>) {
  const router = useRouter();
  return <AnalyticsReport {...props} onNavigate={(url) => router.push(url, { scroll: false })} />;
}
