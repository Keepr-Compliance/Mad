/**
 * Exports report — access and registration (BACKLOG-4004)
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
const FILES = [
  'app/dashboard/reports/exports/page.tsx',
  'lib/reports/exports-queries.ts',
  'lib/reports/exports.ts',
  'lib/reports/exports-views.ts',
];

describe('no service role in the report', () => {
  it.each(FILES)('%s does not reach for the service-role client', (file) => {
    const src = readFileSync(path.join(ROOT, file), 'utf8');
    expect(src).not.toMatch(/createServiceClient|SERVICE_ROLE|service_role|supabase\/service/);
  });

  it('the page authorises through the cookie client, internal role and analytics.view', () => {
    const src = readFileSync(path.join(ROOT, FILES[0]), 'utf8');
    expect(src).toContain('getAuthenticatedUser()');
    expect(src).toContain(".from('internal_roles')");
    expect(src).toContain("required_permission: 'analytics.view'");
    expect(src).toContain("redirect('/dashboard?error=insufficient_permissions')");
  });
});

describe('registered in the report registry', () => {
  it('lists exports with ANALYTICS_VIEW and its source', () => {
    const entry = REPORTS.find((r) => r.slug === 'exports');
    expect(entry).toBeDefined();
    expect(entry!.title).toBe('Exports');
    expect(entry!.permission).toBe(PERMISSIONS.ANALYTICS_VIEW);
    expect(entry!.source).toBe('analytics_events (export-completed)');
    expect(reportHref('exports')).toBe(`${REPORTS_BASE_PATH}/exports`);
  });
});
