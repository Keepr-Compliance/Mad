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
