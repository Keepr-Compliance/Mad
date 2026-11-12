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

  // BACKLOG-4238 (H4): the OAuth register, token and metadata routes (exact
  // paths) and both discovery documents skip middleware; /oauth/authorize and
  // every look-alike still run it.
  it.each([
    '/oauth/register',
    '/oauth/token',
    '/oauth/metadata',
    '/oauth/token?x=1',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/api/mcp',
  ])('BACKLOG-4238: skips %s', (url) => {
    expect(runs(url)).toBe(false);
  });

  it.each([
    '/oauth/authorize',
    '/oauth/authorize?client_id=x',
    '/oauth/registerx',
    '/oauth/tokens',
    '/oauth/token/x',
    '/oauth/metadata/x',
    '/oauth/consent',
    '/x/oauth/token',
    '/.well-known/oauth-authorization-serverx',
    '/.well-known/oauth-protected-resourcex',
    '/.well-known/openid-configuration',
    '/.well-known/apple-app-site-association',
    '/dashboard',
  ])('BACKLOG-4238: still runs middleware for %s', (url) => {
    expect(runs(url)).toBe(true);
  });
});
