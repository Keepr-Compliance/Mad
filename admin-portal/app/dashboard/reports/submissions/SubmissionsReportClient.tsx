'use client';

/**
 * The browser seam (BACKLOG-3715). `useRouter` is confined here so
 * `SubmissionsReport` renders in a plain Node test with no router.
 */

import { useRouter } from 'next/navigation';
import { reportShareApi } from '@/lib/reports/report-share-api';
import { submissionsViewsApi } from '@/lib/reports/submissions-views-api';
import { SubmissionsReport, type SubmissionsReportProps } from './SubmissionsReport';

export function SubmissionsReportClient(props: Omit<SubmissionsReportProps, 'onNavigate' | 'viewsApi' | 'shareApi'>) {
  const router = useRouter();
  return (
    <SubmissionsReport
      {...props}
      onNavigate={(url) => router.push(url, { scroll: false })}
      viewsApi={submissionsViewsApi}
      shareApi={reportShareApi}
    />
  );
}
