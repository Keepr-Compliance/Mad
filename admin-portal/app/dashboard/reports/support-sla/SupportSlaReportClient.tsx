'use client';

/**
 * The browser seam (BACKLOG-3721). `useRouter` is confined here so
 * `SupportSlaReport` renders in a plain test with no router.
 */

import { useRouter } from 'next/navigation';
import { reportShareApi } from '@/lib/reports/report-share-api';
import { supportSlaViewsApi } from '@/lib/reports/period-only-views-api';
import { SupportSlaReport, type SupportSlaReportProps } from './SupportSlaReport';

export function SupportSlaReportClient(props: Omit<SupportSlaReportProps, 'onNavigate' | 'viewsApi' | 'shareApi'>) {
  const router = useRouter();
  return (
    <SupportSlaReport
      {...props}
      onNavigate={(url) => router.push(url, { scroll: false })}
      viewsApi={supportSlaViewsApi}
      shareApi={reportShareApi}
    />
  );
}
