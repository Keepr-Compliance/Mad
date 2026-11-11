/**
 * BACKLOG-4237 A6 — the consent flow refuses any authorization whose redirect
 * address is not on the allowlist (exact match), and never hands the browser a
 * URL that does not go to the authorization's allow-listed address.
 *
 * Response shapes: OAuthAuthorizationDetails / OAuthRedirect from the installed
 * @supabase/auth-js (dist/module/lib/types.d.ts). Field values are placeholders.
 */

import { render, screen } from '@testing-library/react';

jest.mock('@/app/oauth/consent/actions', () => ({ decideConsent: jest.fn() }));

import ConsentClient from '@/app/oauth/consent/ConsentClient';
import { decide, isAuthorizationId, loadConsent } from '@/lib/mcp/consent';
import { isAllowedRedirectUri } from '@/lib/mcp/redirectAllowlist';
import { ZERO_UUID } from './fixtures';

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const AUTH_ID = 'authz_000000000000';

function details(redirectUri: string) {
  return {
    authorization_id: AUTH_ID,
    redirect_uri: redirectUri,
    client: { id: ZERO_UUID, name: 'Claude', uri: 'https://claude.ai', logo_uri: '' },
    user: { id: ZERO_UUID, email: 'person@example.com' },
    scope: 'email',
  };
}

function fakeSupabase(opts: {
  details?: unknown;
  detailsError?: unknown;
  approveUrl?: string;
  denyUrl?: string;
}) {
  const approve = jest.fn(async () => ({ data: { redirect_url: opts.approveUrl }, error: null }));
  const deny = jest.fn(async () => ({ data: { redirect_url: opts.denyUrl }, error: null }));
  const client = {
    auth: {
      oauth: {
        getAuthorizationDetails: jest.fn(async () =>
          opts.detailsError ? { data: null, error: opts.detailsError } : { data: opts.details, error: null }
        ),
        approveAuthorization: approve,
        denyAuthorization: deny,
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, approve, deny };
}

const ENV = { ...process.env };
beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.MCP_EXTRA_REDIRECT_URIS;
});
afterAll(() => {
  process.env = ENV;
});

const LOOK_ALIKES = [
  'https://claude.ai.evil.example/api/mcp/auth_callback',
  'https://evil.example/https://claude.ai/api/mcp/auth_callback',
  'https://claude.ai/api/mcp/auth_callback/',
  'https://claude.ai/api/mcp/auth_callback?x=1',
  'https://claude.ai/api/mcp/auth_callback#x',
  'https://claude.ai/api/mcp/auth_callbackx',
  'https://claude.ai/api/mcp/other',
  'https://CLAUDE.ai/api/mcp/auth_callback',
  'https://claude.ai:443/api/mcp/auth_callback',
  'https://claude.ai:8443/api/mcp/auth_callback',
  'http://claude.ai/api/mcp/auth_callback',
  'https://user@claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector/oauth/abc123',
  'http://localhost:3000/callback',
  'http://127.0.0.1:33418/callback',
  'https://localhost/callback',
  '',
];

describe('A6: allowlist is exact', () => {
  it.each(LOOK_ALIKES)('refuses %p', (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(false);
  });

  it.each([CLAUDE, CHATGPT])('allows %p', (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(true);
  });

  it('an extra address from MCP_EXTRA_REDIRECT_URIS is exact; loopback and http are dropped from it', () => {
    process.env.MCP_EXTRA_REDIRECT_URIS =
      'https://chatgpt.com/connector/oauth/abc123, http://localhost:1/cb, https://127.0.0.1/cb, http://x.example/cb';
    expect(isAllowedRedirectUri('https://chatgpt.com/connector/oauth/abc123')).toBe(true);
    expect(isAllowedRedirectUri('https://chatgpt.com/connector/oauth/abc1234')).toBe(false);
    expect(isAllowedRedirectUri('http://localhost:1/cb')).toBe(false);
    expect(isAllowedRedirectUri('https://127.0.0.1/cb')).toBe(false);
    expect(isAllowedRedirectUri('http://x.example/cb')).toBe(false);
  });
});

describe('A6: loadConsent', () => {
  it.each(LOOK_ALIKES)('a client redirecting to %p is refused', async (uri) => {
    const { client } = fakeSupabase({ details: details(uri) });
    expect(await loadConsent(client, AUTH_ID)).toEqual({ kind: 'refused' });
  });

  it('positive: the Claude callback shows the consent screen with Approve', async () => {
    const { client } = fakeSupabase({ details: details(CLAUDE) });
    const view = await loadConsent(client, AUTH_ID);
    expect(view).toEqual({
      kind: 'consent',
      authorizationId: AUTH_ID,
      clientName: 'Claude',
      redirectHost: 'claude.ai',
      scope: 'email',
    });
    if (view.kind !== 'consent') throw new Error('unreachable');
    render(<ConsentClient mode="consent" authorizationId={view.authorizationId} clientName={view.clientName} redirectHost={view.redirectHost} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByTestId('consent-redirect-host').textContent).toBe('claude.ai');
    expect(screen.getByText('App name (as registered by the app)')).toBeTruthy();
  });

  it('already consented: a redirect URL to an allow-listed address is followed', async () => {
    const { client } = fakeSupabase({ details: { redirect_url: `${CLAUDE}?code=c&state=s` } });
    expect(await loadConsent(client, AUTH_ID)).toEqual({ kind: 'redirect', url: `${CLAUDE}?code=c&state=s` });
  });

  it.each([
    'https://evil.example/cb?code=c',
    'https://claude.ai.evil.example/api/mcp/auth_callback?code=c',
    'https://claude.ai/api/mcp/auth_callback/x?code=c',
    'javascript:alert(1)',
  ])('already consented: a redirect URL to %p is refused', async (url) => {
    const { client } = fakeSupabase({ details: { redirect_url: url } });
    expect(await loadConsent(client, AUTH_ID)).toEqual({ kind: 'refused' });
  });

  it('an error reading the authorization is an error view', async () => {
    const { client } = fakeSupabase({ detailsError: { message: 'x' } });
    expect(await loadConsent(client, AUTH_ID)).toEqual({ kind: 'error' });
  });
});

describe('A6: decide re-checks on the server', () => {
  it.each(['approve', 'deny'] as const)('%s on a refused client calls nothing and returns refused', async (d) => {
    const { client, approve, deny } = fakeSupabase({ details: details('https://evil.example/cb') });
    expect(await decide(client, AUTH_ID, d)).toEqual({ ok: false, reason: 'refused' });
    expect(approve).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
  });

  it('approve passes skipBrowserRedirect and returns the URL', async () => {
    const url = `${CLAUDE}?code=c&state=s`;
    const { client, approve } = fakeSupabase({ details: details(CLAUDE), approveUrl: url });
    expect(await decide(client, AUTH_ID, 'approve')).toEqual({ ok: true, url });
    expect(approve).toHaveBeenCalledWith(AUTH_ID, { skipBrowserRedirect: true });
  });

  it('deny passes skipBrowserRedirect and returns the URL', async () => {
    const url = `${CLAUDE}?error=access_denied&state=s`;
    const { client, deny } = fakeSupabase({ details: details(CLAUDE), denyUrl: url });
    expect(await decide(client, AUTH_ID, 'deny')).toEqual({ ok: true, url });
    expect(deny).toHaveBeenCalledWith(AUTH_ID, { skipBrowserRedirect: true });
  });

  it.each([
    'https://evil.example/cb?code=c',
    `${CHATGPT}?code=c`,
    'https://claude.ai/api/mcp/auth_callback.evil.example?code=c',
  ])('an approval URL to %p (not the authorization address) is refused', async (url) => {
    const { client } = fakeSupabase({ details: details(CLAUDE), approveUrl: url });
    expect(await decide(client, AUTH_ID, 'approve')).toEqual({ ok: false, reason: 'refused' });
  });
});

describe('authorization id shape', () => {
  it.each(['', 'short', 'has space here', 'a/b/c/d/e/f/g', '../../../etc', 'x'.repeat(129)])('refuses %p', (v) => {
    expect(isAuthorizationId(v)).toBe(false);
  });
  it.each([AUTH_ID, ZERO_UUID])('accepts %p', (v) => {
    expect(isAuthorizationId(v)).toBe(true);
  });
});
