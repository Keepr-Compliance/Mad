'use client';

/**
 * The browser seam (BACKLOG-4004). `useRouter` and the Supabase browser client
 * are confined here so `ExportsReport` renders in a plain test with neither.
 */

import { useRouter } from 'next/navigation';
import { exportsViewsApi } from '@/lib/reports/exports-views-api';
import { ExportsReport, type ExportsReportProps } from './ExportsReport';

export function ExportsReportClient(props: Omit<ExportsReportProps, 'onNavigate' | 'viewsApi'>) {
  const router = useRouter();
  return (
    <ExportsReport
      {...props}
      onNavigate={(url) => router.push(url, { scroll: false })}
      viewsApi={exportsViewsApi}
    />
  );
}
