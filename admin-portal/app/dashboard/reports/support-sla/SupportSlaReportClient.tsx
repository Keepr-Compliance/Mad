'use client';

/**
 * The browser seam (BACKLOG-3721). `useRouter` is confined here so
 * `SupportSlaReport` renders in a plain test with no router.
 */

import { useRouter } from 'next/navigation';
import { SupportSlaReport, type SupportSlaReportProps } from './SupportSlaReport';

export function SupportSlaReportClient(props: Omit<SupportSlaReportProps, 'onNavigate'>) {
  const router = useRouter();
  return <SupportSlaReport {...props} onNavigate={(url) => router.push(url, { scroll: false })} />;
}
