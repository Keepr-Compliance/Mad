/**
 * BACKLOG-4005 C1 — old Analytics / Funnel / reports URLs redirect to the new
 * /dashboard/reports routes. Runs the REAL next.config.mjs (Sentry wrapper
 * included) through Next's own config resolver, so a rule that is defined but
 * not wired in, a wrong order, a dropped query or a loop all go red.
 */

import { describe, expect, it } from 'vitest';
import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
import nextConfig from '../../next.config.mjs';

const BASE = 'https://admin.example.test';

async function hit(path: string) {
  const res = await unstable_getResponseFromNextConfig({ url: `${BASE}${path}`, nextConfig });
  const location = res.headers.get('location');
  return { status: res.status, location: location ? location.replace(BASE, '') : null };
}

describe('C1 legacy redirects (temporary, query kept)', () => {
  it.each([
    ['/dashboard/analytics', '/dashboard/reports/analytics'],
    ['/dashboard/analytics?period=7', '/dashboard/reports/analytics?period=7'],
    ['/dashboard/funnel?period=all', '/dashboard/reports/funnel?period=all'],
    ['/dashboard/analytics/reports', '/dashboard/reports'],
    ['/dashboard/analytics/reports?x=1', '/dashboard/reports?x=1'],
    ['/dashboard/analytics/reports/iphone-sync', '/dashboard/reports/iphone-sync'],
    [
      '/dashboard/analytics/reports/iphone-sync?period=custom&from=2026-01-01&to=2026-02-01&q=a%20b',
      '/dashboard/reports/iphone-sync?period=custom&from=2026-01-01&to=2026-02-01&q=a+b',
    ],
    ['/dashboard/analytics/reports/submissions?period=30', '/dashboard/reports/submissions?period=30'],
  ])('%s -> 307 %s', async (from, to) => {
    const r = await hit(from);
    expect(r.status).toBe(307);
    expect(r.location).toBe(to);
  });

  it('a comma-separated filter decodes to the same value after the redirect', async () => {
    const r = await hit('/dashboard/analytics/reports/iphone-sync?type=first,incremental');
    expect(r.status).toBe(307);
    const url = new URL(r.location!, BASE);
    expect(url.pathname).toBe('/dashboard/reports/iphone-sync');
    expect(url.searchParams.get('type')).toBe('first,incremental');
  });

  it('trailing slash: 308 strip, then the 307 rule', async () => {
    const first = await hit('/dashboard/funnel/');
    expect(first.status).toBe(308);
    expect(first.location).toBe('/dashboard/funnel');
    const second = await hit(first.location!);
    expect(second.status).toBe(307);
    expect(second.location).toBe('/dashboard/reports/funnel');
  });

  it.each([
    '/dashboard/reports',
    '/dashboard/reports/analytics',
    '/dashboard/reports/funnel',
    '/dashboard/reports/iphone-sync?period=7',
    '/dashboard/analyticsx',
    '/dashboard/support/analytics',
  ])('%s is not redirected (no loop, no over-match)', async (path) => {
    const r = await hit(path);
    expect(r.location).toBeNull();
  });
});
