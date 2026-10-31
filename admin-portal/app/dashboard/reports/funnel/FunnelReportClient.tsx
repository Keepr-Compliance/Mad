'use client';

/**
 * The browser seam (BACKLOG-3722). `useRouter` is confined here so
 * `FunnelReport` renders in a plain Node test with no router.
 */

import { useRouter } from 'next/navigation';
import { FunnelReport, type FunnelReportProps } from './FunnelReport';

export function FunnelReportClient(props: Omit<FunnelReportProps, 'onNavigate'>) {
  const router = useRouter();
  return <FunnelReport {...props} onNavigate={(url) => router.push(url, { scroll: false })} />;
}
