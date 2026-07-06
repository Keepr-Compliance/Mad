/**
 * Regression test for the BACKLOG-1632 cookie-cleanup helper in
 * lib/supabase/client.ts.
 *
 * Bug: the helper validated each cookie CHUNK individually, but chunked
 * cookies (sb-...-auth-token.0/.1/.2) are slices of one encoded value, so a
 * lone chunk can never decode — every healthy multi-chunk session was
 * treated as corrupted and destroyed on page load (instant logout after
 * navigation). The helper must reassemble chunks before validating.
 */

import { TextDecoder as NodeTextDecoder } from 'node:util';

// jest-environment-jsdom does not provide TextDecoder (browsers always do)
if (!(globalThis as { TextDecoder?: unknown }).TextDecoder) {
  (globalThis as { TextDecoder?: unknown }).TextDecoder = NodeTextDecoder;
}

jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
}));

const CHUNK_SIZE = 3180;

function base64UrlEncode(text: string): string {
  const b64 = Buffer.from(text, 'utf-8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function setChunkedCookie(baseName: string, fullValue: string): string[] {
  const names: string[] = [];
  if (fullValue.length <= CHUNK_SIZE) {
    document.cookie = `${baseName}=${fullValue}; path=/`;
    names.push(baseName);
    return names;
  }
  for (let i = 0; i * CHUNK_SIZE < fullValue.length; i++) {
    const name = `${baseName}.${i}`;
    document.cookie = `${name}=${fullValue.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)}; path=/`;
    names.push(name);
  }
  return names;
}

function clearAllCookies() {
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

/** (Re-)imports the module, which runs the cleanup on load. */
function loadClientModule() {
  jest.isolateModules(() => {
    require('@/lib/supabase/client');
  });
}

describe('clearCorruptedCookies (module-load cookie cleanup)', () => {
  beforeEach(() => {
    clearAllCookies();
  });

  it('keeps a healthy session that spans multiple cookie chunks', () => {
    // Build a session payload large enough to need 3 chunks (~8KB encoded)
    const session = JSON.stringify({
      access_token: 'a'.repeat(3000),
      refresh_token: 'r'.repeat(500),
      user: { id: '00000000-0000-0000-0000-000000000000', email: 'test@example.com', name: 'Tester' },
      pad: 'x'.repeat(2500),
    });
    const value = `base64-${base64UrlEncode(session)}`;
    const names = setChunkedCookie('sb-testref-auth-token', value);
    expect(names.length).toBeGreaterThanOrEqual(3);

    loadClientModule();

    for (const name of names) {
      expect(document.cookie).toContain(`${name}=`);
    }
  });

  it('keeps a healthy single-chunk session', () => {
    const session = JSON.stringify({ access_token: 'abc', user: { id: 'u1' } });
    document.cookie = `sb-testref-auth-token=base64-${base64UrlEncode(session)}; path=/`;

    loadClientModule();

    expect(document.cookie).toContain('sb-testref-auth-token=');
  });

  it('clears all chunks of a genuinely corrupted session', () => {
    // Invalid base64 payload (illegal characters) split across two chunks
    const corrupt = `base64-!!!!${'*'.repeat(CHUNK_SIZE * 1.5)}`;
    const names = setChunkedCookie('sb-testref-auth-token', corrupt);
    expect(names.length).toBeGreaterThanOrEqual(2);

    loadClientModule();

    for (const name of names) {
      expect(document.cookie).not.toContain(`${name}=`);
    }
  });

  it('ignores non-supabase cookies entirely', () => {
    document.cookie = 'unrelated=base64-!!!notbase64; path=/';

    loadClientModule();

    expect(document.cookie).toContain('unrelated=');
  });
});
