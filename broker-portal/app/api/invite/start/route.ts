/**
 * Invite Start API Route (BACKLOG-3684)
 *
 * POST { token, purpose: 'invite' | 'setup' }. Called by the invitation page and
 * by /setup?token= right before the OAuth redirect. When the token names a
 * valid invitation, sets the keepr_invite cookie (lib/auth/inviteCookie.ts) so
 * the OAuth callback can accept exactly that invitation. Writes nothing else.
 *
 * Same-origin only: a request whose Origin header is missing or is not this
 * site's origin gets 403 and no cookie. GET /api/invite/validate stays
 * read-only and never sets the cookie.
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { isInvitePurpose, isPlausibleInviteToken, setInviteCookie } from '@/lib/auth/inviteCookie';

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_request' }, { status: 400 });
  }

  const { token, purpose } = (body ?? {}) as { token?: unknown; purpose?: unknown };
  if (!isPlausibleInviteToken(token) || !isInvitePurpose(purpose)) {
    return NextResponse.json({ ok: false, error: 'invalid_request' }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('public_validate_invitation_token', { p_token: token });

  if (error) {
    console.error('[invite/start] RPC error:', error.message);
    return NextResponse.json({ ok: false, error: 'invalid_invite' }, { status: 400 });
  }

  if (!(data as { valid?: boolean } | null)?.valid) {
    return NextResponse.json({ ok: false, error: 'invalid_invite' }, { status: 400 });
  }

  const response = new NextResponse(null, { status: 204 });
  setInviteCookie(response, purpose, token);
  return response;
}
