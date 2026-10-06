/**
 * Submissions report — access and registration (BACKLOG-3715)
 *
 * C8 is a TEXT guard: it catches a service-role import in the report's page or
 * query module, not a new helper that wraps the service client.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@/lib/permissions';
import { REPORTS, reportHref } from '../registry';

const ROOT = path.resolve(__dirname, '../../..');
const FILES = [
  'app/dashboard/analytics/reports/submissions/page.tsx',
  'lib/reports/submissions-queries.ts',
  'lib/reports/submissions.ts',
];

describe('no service role in the report (C8)', () => {
  it.each(FILES)('%s does not reach for the service-role client', (file) => {
    const src = readFileSync(path.join(ROOT, file), 'utf8');
    expect(src).not.toMatch(/createServiceClient|SERVICE_ROLE|service_role|supabase\/service/);
  });

  it('the page authorises through the cookie client, internal role and analytics.view', () => {
    const src = readFileSync(path.join(ROOT, FILES[0]), 'utf8');
    expect(src).toContain('getAuthenticatedUser()');
    expect(src).toContain(".from('internal_roles')");
    expect(src).toContain("required_permission: 'analytics.view'");
  });
});

describe('registered in the report registry (C9)', () => {
  it('lists submissions with ANALYTICS_VIEW and the right source', () => {
    const entry = REPORTS.find((r) => r.slug === 'submissions');
    expect(entry).toBeDefined();
    expect(entry!.permission).toBe(PERMISSIONS.ANALYTICS_VIEW);
    expect(entry!.source).toBe('submission_attempts');
    expect(reportHref('submissions')).toBe('/dashboard/analytics/reports/submissions');
  });
});
