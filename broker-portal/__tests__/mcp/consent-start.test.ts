/**
 * @jest-environment node
 *
 * BACKLOG-4237 — signed-out entry to the consent flow keeps the authorization
 * id in an httpOnly cookie on /oauth for 10 minutes and sends the person to
 * /login with the AI apps page as the post-login destination.
 */

import { NextRequest } from 'next/server';
import { GET } from '@/app/oauth/consent/start/route';

const ID = 'authz_000000000000';

function cookieLines(res: Response): string[] {
  return res.headers.getSetCookie();
}

describe('/oauth/consent/start', () => {
  it('stores the id and redirects to /login', async () => {
    const res = await GET(new NextRequest(`https://portal.test/oauth/consent/start?authorization_id=${ID}`));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('redirectTo')).toBe('/dashboard/account/ai-apps');

    const consent = cookieLines(res).find((c) => c.startsWith('keepr_mcp_consent='))!;
    expect(consent).toContain(`keepr_mcp_consent=${ID}`);
    expect(consent).toMatch(/Path=\/oauth(;|$)/);
    expect(consent).toContain('Max-Age=600');
    expect(consent).toContain('HttpOnly');
    expect(consent).toContain('Secure');

    const next = cookieLines(res).find((c) => c.startsWith('keepr_next='))!;
    expect(decodeURIComponent(next)).toContain('keepr_next=/dashboard/account/ai-apps');
  });

  it.each(['', 'bad id', '../x'])('an invalid id %p sets no cookie and goes back to the consent page', async (id) => {
    const res = await GET(
      new NextRequest(`https://portal.test/oauth/consent/start?authorization_id=${encodeURIComponent(id)}`)
    );
    expect(new URL(res.headers.get('location')!).pathname).toBe('/oauth/consent');
    expect(cookieLines(res)).toEqual([]);
  });
});
