'use client';

/**
 * The signed-in user's access to the sender rules, for the sidebar's AI section (BACKLOG-4186).
 * `useReportAccess` on the sender-rules key; see lib/reports/use-report-access.ts.
 */

import { useReportAccess } from '@/lib/reports/use-report-access';
import type { ReportAccess } from '@/lib/reports/report-access';
import { SENDER_RULES_REPORT_KEY } from './access';

export function useSenderRulesAccess(userId: string | null | undefined): ReportAccess | null {
  return useReportAccess(SENDER_RULES_REPORT_KEY, userId);
}
