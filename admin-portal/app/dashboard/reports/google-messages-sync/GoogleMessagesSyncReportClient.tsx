'use client';

/** The browser seam: only this wrapper touches the router (as the iPhone report's). */

import { useRouter } from 'next/navigation';
import { gmViewsApi } from '@/lib/reports/google-messages-sync-views-api';
import { GoogleMessagesSyncReport, type GoogleMessagesSyncReportProps } from './GoogleMessagesSyncReport';

export function GoogleMessagesSyncReportClient(props: Omit<GoogleMessagesSyncReportProps, 'onNavigate' | 'viewsApi'>) {
  const router = useRouter();
  return (
    <GoogleMessagesSyncReport
      {...props}
      onNavigate={(url) => router.push(url, { scroll: false })}
      viewsApi={gmViewsApi}
    />
  );
}
