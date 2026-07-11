/**
 * BACKLOG-1952 (H1): unit tests for the middleware cookie parse-guard and the
 * secret-free auth-error descriptor.
 *
 * The guard exists to stop the @supabase/ssr single-cookie adapter from
 * throwing `TypeError: Cannot create property 'user' on string '{...session...}'`
 * (which embeds the full session) when the auth-token cookie is bare JSON.
 */

import { describe, it, expect } from 'vitest';
import { isAuthTokenCookie, isBareAuthTokenCookie, safeAuthErrorInfo } from './cookie-guard';

// A realistic bare-JSON session string — the exact shape whose interpolation
// into the thrown TypeError leaks live credentials.
const BARE_SESSION_JSON = JSON.stringify({
  access_token: 'eyJHEADER.eyJPAYLOAD.sigSUPABASE',
  refresh_token: 'refresh-secret-abc123',
  provider_token: 'ms-graph-secret-xyz789',
  user: { id: 'u1', email: 'agent@izzyrescue.org' },
});

describe('isAuthTokenCookie', () => {
  it('matches the unchunked auth-token cookie', () => {
    expect(isAuthTokenCookie('sb-nercleijfrxqcvfjskbc-auth-token')).toBe(true);
  });

  it('matches chunked auth-token cookies', () => {
    expect(isAuthTokenCookie('sb-nercleijfrxqcvfjskbc-auth-token.0')).toBe(true);
    expect(isAuthTokenCookie('sb-nercleijfrxqcvfjskbc-auth-token.12')).toBe(true);
  });

  it('ignores non-auth-token sb cookies', () => {
    expect(isAuthTokenCookie('sb-nercleijfrxqcvfjskbc-auth-token-code-verifier')).toBe(false);
    expect(isAuthTokenCookie('sb-provider-token')).toBe(false);
  });

  it('ignores unrelated cookies', () => {
    expect(isAuthTokenCookie('impersonation')).toBe(false);
    expect(isAuthTokenCookie('supabase-auth-token')).toBe(false); // not sb- prefixed
  });
});

describe('isBareAuthTokenCookie', () => {
  it('flags a bare-JSON auth-token cookie (the leak vector)', () => {
    expect(isBareAuthTokenCookie('sb-nercleijfrxqcvfjskbc-auth-token', BARE_SESSION_JSON)).toBe(
      true
    );
  });

  it('flags a bare-JSON chunk', () => {
    expect(isBareAuthTokenCookie('sb-nercleijfrxqcvfjskbc-auth-token.0', BARE_SESSION_JSON)).toBe(
      true
    );
  });

  it('flags a JSON-array (array-of-chunks) form', () => {
    expect(
      isBareAuthTokenCookie('sb-nercleijfrxqcvfjskbc-auth-token', '["chunk0","chunk1"]')
    ).toBe(true);
  });

  it('tolerates leading whitespace before the brace', () => {
    expect(
      isBareAuthTokenCookie('sb-nercleijfrxqcvfjskbc-auth-token', `  ${BARE_SESSION_JSON}`)
    ).toBe(true);
  });

  it('does NOT flag the healthy base64- encoded form', () => {
    expect(
      isBareAuthTokenCookie(
        'sb-nercleijfrxqcvfjskbc-auth-token',
        'base64-eyJhY2Nlc3NfdG9rZW4iOiJ4In0'
      )
    ).toBe(false);
  });

  it('does NOT flag non-auth-token cookies even if they are JSON', () => {
    expect(isBareAuthTokenCookie('some-other-cookie', BARE_SESSION_JSON)).toBe(false);
  });

  it('returns false for an undefined value', () => {
    expect(isBareAuthTokenCookie('sb-nercleijfrxqcvfjskbc-auth-token', undefined)).toBe(false);
  });

  it('returns false for an empty value', () => {
    expect(isBareAuthTokenCookie('sb-nercleijfrxqcvfjskbc-auth-token', '')).toBe(false);
  });
});

describe('safeAuthErrorInfo', () => {
  it('extracts name/code and NEVER the session-bearing message', () => {
    // Reproduce the exact throw shape the SSR adapter produces.
    const err = new TypeError(`Cannot create property 'user' on string '${BARE_SESSION_JSON}'`);
    const info = safeAuthErrorInfo(err);

    expect(info).toEqual({ name: 'TypeError', code: 'unknown' });

    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');
    expect(serialized).not.toContain('provider_token');
    expect(serialized).not.toContain('agent@izzyrescue.org');
    expect(serialized).not.toContain('Cannot create property');
  });

  it('surfaces a string error code when present', () => {
    const err = Object.assign(new Error('boom'), { code: 'PGRST301' });
    expect(safeAuthErrorInfo(err)).toEqual({ name: 'Error', code: 'PGRST301' });
  });

  it('falls back gracefully for non-Error throws', () => {
    expect(safeAuthErrorInfo('a raw string that could be a session')).toEqual({
      name: 'UnknownError',
      code: 'unknown',
    });
    expect(safeAuthErrorInfo(undefined)).toEqual({ name: 'UnknownError', code: 'unknown' });
  });
});
