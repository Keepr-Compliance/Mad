/**
 * BACKLOG-3601 — the sign-out helper itself.
 *
 * @jest-environment node
 */

import { NextResponse } from 'next/server';
import { clearAuthCookies, signOutLocal } from '@/lib/auth/signOutLocal';

describe('signOutLocal', () => {
  it('takes only the client: no scope or options argument', () => {
    expect(signOutLocal.length).toBe(1);
  });

  it("calls sign-out exactly once with { scope: 'local' }", async () => {
    const signOut = jest.fn().mockResolvedValue({ error: null });
    await expect(signOutLocal({ auth: { signOut } })).resolves.toEqual({ error: null });
    expect(signOut.mock.calls).toEqual([[{ scope: 'local' }]]);
  });

  it('returns a returned error', async () => {
    const failure = { message: 'fixture failure' };
    const signOut = jest.fn().mockResolvedValue({ error: failure });
    await expect(signOutLocal({ auth: { signOut } })).resolves.toEqual({ error: failure });
  });

  it('never throws: a rejection comes back as { error }', async () => {
    const thrown = new Error('fixture network failure');
    const signOut = jest.fn().mockRejectedValue(thrown);
    await expect(signOutLocal({ auth: { signOut } })).resolves.toEqual({ error: thrown });
  });
});

describe('clearAuthCookies', () => {
  it('deletes only the Supabase auth cookies the request carried', () => {
    const request = new Request('http://localhost:3000/x', {
      headers: { cookie: 'sb-fixture-auth-token=abc; sb-fixture-auth-token.1=def; theme=dark' },
    });
    const response = NextResponse.redirect('http://localhost:3000/login');
    clearAuthCookies(request, response);
    const cleared = response.headers
      .getSetCookie()
      .map((c) => c.split('=')[0])
      .sort();
    expect(cleared).toEqual(['sb-fixture-auth-token', 'sb-fixture-auth-token.1']);
  });
});
