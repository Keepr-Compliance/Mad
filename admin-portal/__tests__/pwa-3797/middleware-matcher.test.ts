/**
 * BACKLOG-3797 — the admin middleware matcher skips the service worker script
 * and the manifest, and nothing else that matters.
 *
 * Runs Next's own matcher logic against the REAL exported `config`. Before
 * this change /sw.js and /manifest.webmanifest ran middleware (a supabase
 * getUser() per worker update check).
 *
 * The exclusions are anchored with `$`. Unanchored, `sw\.js` would also skip
 * /sw.js.map; the over-broad exclusion is the wrong implementation to catch,
 * so /dashboard, auth routes and look-alike paths must still run middleware.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }));

import { unstable_doesMiddlewareMatch as doesMiddlewareMatch } from 'next/experimental/testing/server';
import { config } from '@/middleware';

const runs = (url: string) => doesMiddlewareMatch({ config, url });

describe('BACKLOG-3797 admin middleware matcher', () => {
  it.each(['/sw.js', '/manifest.webmanifest', '/sw.js?v=2', '/icons/icon-192.png', '/icons/icon-512.png'])(
    'skips %s',
    (url) => {
      expect(runs(url)).toBe(false);
    }
  );

  it.each([
    '/dashboard',
    '/dashboard/users',
    '/dashboard/sw.js',
    '/dashboard/manifest.webmanifest',
    '/sw.js.map',
    '/sw.jsx',
    '/manifest.webmanifest.bak',
    '/login',
    '/login?error=not_authorized',
    '/auth/callback',
    '/api/anything',
  ])('still runs middleware for %s', (url) => {
    expect(runs(url)).toBe(true);
  });
});
