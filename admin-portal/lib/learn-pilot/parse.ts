/**
 * Learn pilot — read the answer of learn_pilot_report_admin_list() (BACKLOG-4219). Pure.
 *
 * Any error (42501 refused, PGRST202 function missing, ...) or any answer that is not the
 * `{rows: [...], truncated}` shape is a failure, shown as "could not be read" — never an empty
 * list, so a venue without the function does not read as "nobody has sent a report".
 */

import type { AdminListResult, AdminListRow } from './types';

export const READ_FAILED_MESSAGE = 'The pilot reports could not be read.';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

function parseRow(v: unknown): AdminListRow | null {
  if (!isObject(v)) return null;
  const org_id = str(v.org_id);
  const user_id = str(v.user_id);
  const submitted_at = str(v.submitted_at);
  const sender_rules_version = int(v.sender_rules_version);
  if (!org_id || !user_id || !submitted_at || sender_rules_version === null || !isObject(v.report)) return null;
  return {
    org_id,
    org_name: str(v.org_name),
    user_id,
    user_name: str(v.user_name),
    sender_rules_version,
    version_released: bool(v.version_released),
    version_bundled: bool(v.version_bundled),
    version_was_canary_for_this_org: v.version_was_canary_for_this_org === true,
    org_current_pin_version: int(v.org_current_pin_version),
    org_current_pin_at: str(v.org_current_pin_at),
    report: v.report,
    app_version: str(v.app_version),
    submitted_at,
  };
}

export function parseAdminList(data: unknown, error: unknown): AdminListResult {
  const failed = { ok: false as const, message: READ_FAILED_MESSAGE };
  if (error) return failed;
  if (!isObject(data) || !Array.isArray(data.rows) || typeof data.truncated !== 'boolean') return failed;
  const rows: AdminListRow[] = [];
  for (const r of data.rows) {
    const row = parseRow(r);
    if (!row) return failed;
    rows.push(row);
  }
  return { ok: true, rows, truncated: data.truncated };
}
