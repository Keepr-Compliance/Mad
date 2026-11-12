/**
 * BACKLOG-4237 — the middleware matcher skips /api/mcp and its sub-paths, and
 * still runs on /oauth paths and on look-alike paths.
 *
 * Runs Next's own matcher logic against the REAL exported `config`.
 *
 * @jest-environment node
 */

jest.mock('@supabase/ssr', () => ({ createServerClient: jest.fn() }));

import { unstable_doesMiddlewareMatch as doesMiddlewareMatch } from 'next/experimental/testing/server';
import { config } from '@/middleware';

const runs = (url: string) => doesMiddlewareMatch({ config, url });

describe('BACKLOG-4237 middleware matcher', () => {
  it.each(['/api/mcp', '/api/mcp/', '/api/mcp/resource-metadata', '/api/mcp?x=1'])('skips %s', (url) => {
    expect(runs(url)).toBe(false);
  });

  it.each([
    '/oauth',
    '/oauth/authorize',
    '/oauth/authorize?x=1',
    '/oauth/a/b',
    '/api/mcpx',
    '/api/mcp-admin',
    '/api/billing/plan-summary',
    '/dashboard/api/mcp',
  ])('still runs middleware for %s', (url) => {
    expect(runs(url)).toBe(true);
  });
});
