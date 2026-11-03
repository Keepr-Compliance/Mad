/**
 * User Activity report — access and registration (BACKLOG-3720)
 *
 * A TEXT guard: it catches a service-role import in the report's page or
 * modules, not a new helper that wraps the service client.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@/lib/permissions';
import { REPORTS, REPORTS_BASE_PATH, reportHref } from '../registry';

const ROOT = path.resolve(__dirname, '../../..');
const PAGE = 'app/dashboard/reports/user-activity/page.tsx';
const FILES = [
  PAGE,
  'app/dashboard/reports/user-activity/UserActivityReport.tsx',
  'app/dashboard/reports/user-activity/UserActivityTable.tsx',
  'lib/reports/user-activity-queries.ts',
  'lib/reports/user-activity.ts',
];

describe('no service role in the report (C2)', () => {
  it.each(FILES)('%s does not reach for the service-role client', (file) => {
    const src = readFileSync(path.join(ROOT, file), 'utf8');
    expect(src).not.toMatch(/createServiceClient|SERVICE_ROLE|service_role|supabase\/service/);
  });
});

describe('the page authorises (C1)', () => {
  it('through the cookie client, internal role and analytics.view', () => {
    const src = readFileSync(path.join(ROOT, PAGE), 'utf8');
    expect(src).toContain('getAuthenticatedUser()');
    expect(src).toContain(".from('internal_roles')");
    expect(src).toContain("required_permission: 'analytics.view'");
    expect(src).toContain("redirect('/dashboard?error=insufficient_permissions')");
  });
});

describe('the page passes staff completeness through (C18)', () => {
  it('reads staff with the viewer id and tells the report when exclusion is incomplete', () => {
    const src = readFileSync(path.join(ROOT, PAGE), 'utf8');
    expect(src).toContain('getStaffIds(supabase, user.id)');
    expect(src).toContain('staffIds: staff.staffIds');
    expect(src).toContain('staffExclusionIncomplete={!staff.complete}');
    const queries = readFileSync(path.join(ROOT, 'lib/reports/user-activity-queries.ts'), 'utf8');
    expect(queries).toContain("supabase.rpc('is_super_admin'");
  });
});

describe('registered in the report registry (C3)', () => {
  it('lists user-activity last, with ANALYTICS_VIEW and its source', () => {
    const entry = REPORTS.find((r) => r.slug === 'user-activity');
    expect(entry).toBeDefined();
    expect(entry!.title).toBe('User Activity');
    expect(entry!.permission).toBe(PERMISSIONS.ANALYTICS_VIEW);
    expect(entry!.source).toBe('users, devices, audit_logs');
    expect(reportHref('user-activity')).toBe(`${REPORTS_BASE_PATH}/user-activity`);
  });
});
