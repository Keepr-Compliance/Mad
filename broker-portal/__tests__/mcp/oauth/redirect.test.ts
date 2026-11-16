/**
 * @jest-environment node
 *
 * BACKLOG-4238 — clientRedirect: parameters appended in order, iss last,
 * null values left out; a base that is not a plain https URI is refused.
 */

import { clientRedirect } from '@/lib/mcp/oauth/redirect';
import { ORIGIN, REDIRECT_URI } from './fixtures';

describe('clientRedirect', () => {
  it('appends the parameters, then iss', () => {
    const loc = clientRedirect(REDIRECT_URI, [['error', 'invalid_scope'], ['state', 'a b&c']], ORIGIN)!;
    expect(loc).toBe(`${REDIRECT_URI}?error=invalid_scope&state=a+b%26c&iss=https%3A%2F%2Fportal.test`);
    const url = new URL(loc);
    expect([...url.searchParams.keys()]).toEqual(['error', 'state', 'iss']);
    expect(url.searchParams.get('iss')).toBe(ORIGIN);
    expect(url.searchParams.get('state')).toBe('a b&c');
  });

  it('leaves out a null value', () => {
    const loc = clientRedirect(REDIRECT_URI, [['error', 'invalid_request'], ['state', null]], ORIGIN)!;
    expect([...new URL(loc).searchParams.keys()]).toEqual(['error', 'iss']);
  });

  it.each([
    ['a query', `${REDIRECT_URI}?x=1`],
    ['an empty query', `${REDIRECT_URI}?`],
    ['a fragment', `${REDIRECT_URI}#f`],
    ['userinfo', 'https://u:p@client.example/callback'],
    ['http', 'http://client.example/callback'],
    ['not a URL', 'not a url'],
  ])('refuses a base with %s', (_l, base) => {
    expect(clientRedirect(base, [['error', 'invalid_request']], ORIGIN)).toBeNull();
  });
});
