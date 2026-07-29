'use server';

/**
 * BACKLOG-2332 — mint a fresh, INDEPENDENT Supabase session for the desktop app.
 *
 * Problem: the desktop-login callback used to hand the desktop the BROWSER tab's exact
 * access/refresh tokens (createTokenClaim -> claim -> electron setSession verbatim). Desktop and
 * browser then shared ONE refresh-token family; both autoRefreshToken, so the first rotation
 * tripped GoTrue reuse-detection and revoked the family — the current desktop self-kicked ~1min
 * after its own login.
 *
 * Fix (Option A): the broker mints a brand-new session for the verified user (a distinct
 * session_id + refresh-token family) and hands THAT to the desktop, so desktop and browser refresh
 * and expire independently. The original provider_token/provider_refresh_token are passed through
 * the claim UNCHANGED by the caller (they are used for Graph/Gmail and are independent of the
 * Supabase auth session).
 *
 * Mechanism: admin.generateLink({ type: 'magiclink' }) issues a one-time OTP (it does NOT send an
 * email — admin generation only), and verifyOtp consumes it to mint the new session. supabase-js
 * has no admin.createSession, so this is the standard server-side session-mint.
 *
 * SECURITY (SR BLOCKING-A): the email fed to generateLink comes ONLY from a server-side VERIFIED
 * getUser(accessToken) — never client input — otherwise this becomes a "mint a session for any
 * email" primitive. A dedicated non-persisting client is used for verifyOtp so no background
 * refresh timer leaks in the Next.js server runtime.
 */

import { createClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/service';

export interface MintedSession {
  access_token: string;
  refresh_token: string;
}

/** A dedicated, non-persisting client for verifyOtp (no background refresh timer server-side). */
function createMintClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Mint a fresh independent session for the user identified by `accessToken` (the browser session's
 * token). Returns the new session's tokens, or null on any failure (the caller must then fail the
 * login rather than fall back to the browser tokens — falling back reintroduces the self-kick).
 */
export async function mintDesktopSession(accessToken: string): Promise<MintedSession | null> {
  try {
    if (!accessToken) return null;

    const admin = createServiceClient();

    // BLOCKING-A: identity/email from the VERIFIED token, never client input.
    const {
      data: { user },
      error: userError,
    } = await admin.auth.getUser(accessToken);
    if (userError || !user?.email) {
      console.error('[mintDesktopSession] could not verify user/email:', userError?.message);
      return null;
    }

    // Issue a one-time OTP for the verified email (does NOT send an email — admin generation only).
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: user.email,
    });
    const emailOtp = linkData?.properties?.email_otp;
    if (linkError || !emailOtp) {
      console.error('[mintDesktopSession] generateLink failed:', linkError?.message);
      return null;
    }

    // Consume the OTP to mint a brand-new, independent session (distinct refresh-token family).
    const mintClient = createMintClient();
    const { data: verifyData, error: verifyError } = await mintClient.auth.verifyOtp({
      email: user.email,
      token: emailOtp,
      type: 'email',
    });
    if (verifyError || !verifyData?.session) {
      console.error('[mintDesktopSession] verifyOtp failed:', verifyError?.message);
      return null;
    }

    return {
      access_token: verifyData.session.access_token,
      refresh_token: verifyData.session.refresh_token,
    };
  } catch (err) {
    console.error('[mintDesktopSession] unexpected error:', err);
    return null;
  }
}
