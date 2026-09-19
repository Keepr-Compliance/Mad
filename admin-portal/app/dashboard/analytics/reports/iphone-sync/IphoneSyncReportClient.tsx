'use client';

/**
 * The router seam (BACKLOG-3450).
 *
 * `useRouter` throws outside an App Router context, so it is confined to this
 * six-line wrapper. `IphoneSyncReport` below it takes navigation as a prop and
 * therefore renders in a plain Node test with no mock and no provider — which
 * is what keeps the render controls honest.
 */

import { useRouter } from 'next/navigation';
import { IphoneSyncReport, type IphoneSyncReportProps } from './IphoneSyncReport';

export function IphoneSyncReportClient(props: Omit<IphoneSyncReportProps, 'onNavigate'>) {
  const router = useRouter();
  return <IphoneSyncReport {...props} onNavigate={(url) => router.push(url, { scroll: false })} />;
}
