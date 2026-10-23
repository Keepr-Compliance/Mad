/**
 * BACKLOG-4005 C2/C3/C5 — every moved page keeps its own analytics.view gate,
 * the middleware gates the whole /dashboard/reports tree, and the registry
 * stays reports-only.
 *
 * C2 is a TEXT guard over each page.tsx (same pattern as
 * lib/reports/__tests__/submissions-access.test.ts).
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { requiredPermissionsFor } from '@/lib/route-permissions';
import { REPORTS, reportHref } from '@/lib/reports/registry';
import { OVERVIEW_CARDS } from '@/lib/reports/overview-cards';

const ROOT = path.resolve(__dirname, '../..');
const PAGES = [
  'app/dashboard/reports/page.tsx',
  'app/dashboard/reports/analytics/page.tsx',
  'app/dashboard/reports/funnel/page.tsx',
  'app/dashboard/reports/iphone-sync/page.tsx',
  'app/dashboard/reports/google-messages-sync/page.tsx',
  'app/dashboard/reports/submissions/page.tsx',
];

describe('C2 each moved page checks auth, internal role and analytics.view', () => {
  it.each(PAGES)('%s', (file) => {
    const src = readFileSync(path.join(ROOT, file), 'utf8');
    expect(src).toContain('getAuthenticatedUser()');
    expect(src).toContain(".from('internal_roles')");
    expect(src).toContain("required_permission: 'analytics.view'");
    expect(src).toContain("redirect('/dashboard?error=insufficient_permissions')");
  });
});

describe('C3 middleware route permissions', () => {
  it.each([
    '/dashboard/reports',
    '/dashboard/reports/analytics',
    '/dashboard/reports/funnel',
    '/dashboard/reports/iphone-sync',
    '/dashboard/reports/submissions?period=7',
  ])('%s requires analytics.view', (p) => {
    expect(requiredPermissionsFor(p)).toEqual(['analytics.view']);
  });

  it('support analytics stays on support.view (prefix ordering)', () => {
    expect(requiredPermissionsFor('/dashboard/support/analytics')).toEqual(['support.view']);
  });

  it('the dashboard root is not gated by a route permission', () => {
    expect(requiredPermissionsFor('/dashboard')).toBeNull();
  });

  it('middleware.ts resolves the route permission through requiredPermissionsFor', () => {
    const src = readFileSync(path.join(ROOT, 'middleware.ts'), 'utf8');
    expect(src).toMatch(/const requiredPermissions = requiredPermissionsFor\(pathname\);/);
    expect(src).toContain("permission_keys: requiredPermissions");
    expect(src).not.toContain('ROUTE_PERMISSIONS');
  });
});

describe('C5 registry stays reports-only; overview cards are separate', () => {
  it('report links live under /dashboard/reports', () => {
    for (const r of REPORTS) expect(reportHref(r.slug)).toBe(`/dashboard/reports/${r.slug}`);
  });

  it('no registry slug collides with the analytics or funnel routes', () => {
    expect(REPORTS.map((r) => r.slug)).not.toContain('analytics');
    expect(REPORTS.map((r) => r.slug)).not.toContain('funnel');
  });

  it('overview cards point at the moved Analytics and Funnel pages', () => {
    expect(OVERVIEW_CARDS.map((c) => c.href)).toEqual(['/dashboard/reports/analytics', '/dashboard/reports/funnel']);
  });
});
