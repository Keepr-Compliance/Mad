/**
 * Sender rules — who may change them (BACKLOG-4186).
 *
 * Only the report owner writes (the 4175 publish / pin / revert_all RPCs refuse anyone else with
 * 42501). Editor and viewer read only: founder decision 2026-11-09. The server is the enforcement;
 * this decides which controls the page renders.
 */

import type { ReportAccess } from '@/lib/reports/report-access';

export function canEditSenderRules(access: ReportAccess | null | undefined): boolean {
  return access === 'owner';
}

/** The report key the access checks use (BACKLOG-4144 `public.reports`, inserted by 4175). */
export const SENDER_RULES_REPORT_KEY = 'sender-rules';

/** The page, in the sidebar's AI section (founder ruling 2026-11-10: not under Reports). */
export const SENDER_RULES_PATH = '/dashboard/ai/sender-rules';

/**
 * The share dialog's role lines on this page. An editor gets no extra power here (founder
 * 2026-11-09), so "Can edit" is described as the same as "Can view".
 */
export const SENDER_RULES_SHARE_ROLE_DESCRIPTIONS = {
  viewer: 'Sees the rules',
  editor: 'Same as Can view on this page: sees the rules',
} as const;
