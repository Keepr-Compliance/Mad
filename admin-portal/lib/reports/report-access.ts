/**
 * Per-report access (BACKLOG-4144): the shapes the report pages, the index and the sidebar share.
 *
 * Read from the server functions `report_my_access(p_key)` and `report_list_my_reports()`. Those
 * functions are the access guard; everything here only parses what they answered.
 *
 * - owner: a Super Admin. Opens every report, shares saved views, grants report access.
 * - editor: opens the report, applies views shared with them, shares saved views on it.
 * - viewer: opens the report and applies views shared with them.
 */

export type ReportAccess = 'owner' | 'editor' | 'viewer';

/** One row of `report_list_my_reports`. */
export interface MyReport {
  reportKey: string;
  access: ReportAccess;
}

/** A `report_my_access` answer, or null for no access or anything unreadable (fails closed). */
export function parseReportAccess(value: unknown): ReportAccess | null {
  return value === 'owner' || value === 'editor' || value === 'viewer' ? value : null;
}

/** `report_list_my_reports` rows. Rows without a key or a known access level are left out. */
export function parseMyReports(data: unknown): MyReport[] {
  if (!Array.isArray(data)) return [];
  const out: MyReport[] = [];
  for (const row of data) {
    if (row == null || typeof row !== 'object') continue;
    const { report_key: key, access } = row as { report_key?: unknown; access?: unknown };
    const parsed = parseReportAccess(access);
    if (typeof key === 'string' && key.length > 0 && parsed) out.push({ reportKey: key, access: parsed });
  }
  return out;
}

/** May this caller share saved views on the report? Editors and owners only. */
export function canShareViews(access: ReportAccess | null): boolean {
  return access === 'owner' || access === 'editor';
}

/** May this caller grant report access? Owners (Super Admins) only. */
export function canGrantReportAccess(access: ReportAccess | null): boolean {
  return access === 'owner';
}
