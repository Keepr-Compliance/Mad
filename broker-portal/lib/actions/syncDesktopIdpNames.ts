'use server';

/**
 * BACKLOG-3991: the identity provider's names at a DESKTOP sign-in.
 *
 * Called by app/auth/desktop/callback/page.tsx before the desktop session is
 * minted. Every desktop sign-in passes through that page, so the desktop app gets
 * the same name rule as the portal without an app release.
 *
 * Why a server action and not a fetch from the page: the portal's
 * Content-Security-Policy (next.config.mjs, connect-src) does not allow the
 * browser to call Google's userinfo endpoint, and should not have to.
 *
 * Identity comes from a VERIFIED getUser(accessToken), never from client input,
 * and the names are written through a client that carries that same access token,
 * so sync_profile_names_from_idp writes only that user's own row (auth.uid()).
 * The provider token is used for the Google read only and is never logged.
 *
 * Best-effort: resolves on every path and never throws, so a desktop sign-in is
 * never blocked by it.
 */

import { createClient } from '@supabase/supabase-js';
import { syncIdpNames } from '@/lib/auth/idpNames';

export async function syncDesktopIdpNames(accessToken: string, providerToken: string | null): Promise<void> {
  try {
    if (!accessToken) return;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      console.error('[syncDesktopIdpNames] missing Supabase configuration');
      return;
    }
    const userClient = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const {
      data: { user },
      error,
    } = await userClient.auth.getUser(accessToken);
    if (error || !user) {
      console.error('[syncDesktopIdpNames] could not verify the user');
      return;
    }
    await syncIdpNames(userClient, user, typeof providerToken === 'string' ? providerToken : null);
  } catch {
    console.error('[syncDesktopIdpNames] failed');
  }
}
