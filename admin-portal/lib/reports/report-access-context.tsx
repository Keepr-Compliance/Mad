'use client';

/**
 * The caller's access to the open report, for the browser side of a report page (BACKLOG-4144).
 *
 * The server page passes what `requireReportAccess` returned. With no provider the access is null,
 * which offers nothing: no saved-view Share, no report Share. Presentation only; the server
 * functions are the access guard.
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { ReportAccess } from './report-access';

export interface OpenReport {
  reportKey: string;
  title: string;
  access: ReportAccess;
}

const ReportAccessContext = createContext<OpenReport | null>(null);

export function ReportAccessProvider({
  reportKey,
  title,
  access,
  children,
}: OpenReport & { children: ReactNode }) {
  return <ReportAccessContext.Provider value={{ reportKey, title, access }}>{children}</ReportAccessContext.Provider>;
}

/** The open report, or null outside a report page. */
export function useOpenReport(): OpenReport | null {
  return useContext(ReportAccessContext);
}
