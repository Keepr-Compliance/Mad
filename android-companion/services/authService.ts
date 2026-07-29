/**
 * Authentication Service (Keepr Companion)
 *
 * Wraps Supabase auth operations for use in the companion app.
 * Supports Google OAuth, Microsoft/Azure OAuth, and email magic links.
 *
 * OAuth on React Native uses expo-web-browser's openAuthSessionAsync()
 * to open an in-app browser that returns the full redirect URL including
 * tokens. This avoids the issue where Expo Router consumes the URL before
 * the callback component can read the hash fragment.
 */

import { createURL } from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from './supabaseClient';
import { clearHadSession, markDeliberateSignOut } from './authSessionState';
import type { Session, AuthChangeEvent, Subscription } from '@supabase/supabase-js';

/** Redirect URI for OAuth callbacks using the app's URL scheme */
const REDIRECT_URI = createURL('auth/callback', { scheme: 'keepr-companion' });

/**
 * Extract tokens from a redirect URL hash fragment and set the Supabase session.
 * Returns null on success, or an error message string on failure.
 *
 * Exported (BACKLOG-2215) so the `auth/callback` route can complete a magic-link
 * redirect — the only path that lands on that route — and decide success vs.
 * failure, instead of blindly bouncing to `/`.
 */
export async function extractSessionFromUrl(url: string): Promise<string | null> {
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) {
    return 'No tokens in redirect URL';
  }

  const params = new URLSearchParams(url.substring(hashIndex + 1));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');

  if (!accessToken || !refreshToken) {
    return 'No tokens in redirect URL';
  }

  const { error: sessionError } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  if (sessionError) {
    return sessionError.message;
  }

  // BACKLOG-2326: mark this session as the companion so the broker's single-session enforcement
  // ALWAYS spares the phone. Best-effort — a failure just falls back to the user_agent backstop.
  await markCompanionSession();

  return null;
}

/**
 * BACKLOG-2326: mark THIS companion session so the broker's single-session enforcement spares the
 * phone when a desktop login revokes the user's other sessions. The RPC records the CALLER'S OWN
 * session id (derived server-side from the JWT — no parameters), so it can only ever mark this
 * device's current session. Best-effort and idempotent: never throws, safe to call repeatedly.
 */
export async function markCompanionSession(): Promise<void> {
  try {
    const { error } = await supabase.rpc('mark_companion_session');
    if (error) {
      // Non-fatal: the broker's user_agent backstop still spares this session.
      console.warn('[authService] mark_companion_session failed (non-fatal):', error.message);
    }
  } catch (err) {
    console.warn('[authService] mark_companion_session threw (non-fatal):', err);
  }
}

/**
 * Sign in with Google via Supabase OAuth.
 * Uses expo-web-browser to open an in-app auth session that returns
 * the redirect URL with tokens directly.
 */
export async function signInWithGoogle(): Promise<{ error: string | null }> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: REDIRECT_URI,
      skipBrowserRedirect: true,
    },
  });

  if (error || !data.url) {
    return { error: error?.message ?? 'No OAuth URL returned' };
  }

  const result = await WebBrowser.openAuthSessionAsync(data.url, REDIRECT_URI);

  if (result.type === 'success' && result.url) {
    const sessionError = await extractSessionFromUrl(result.url);
    return { error: sessionError };
  }

  return { error: result.type === 'cancel' ? 'Sign in cancelled' : 'Sign in failed' };
}

/**
 * Sign in with Microsoft/Azure via Supabase OAuth.
 * Uses expo-web-browser to open an in-app auth session that returns
 * the redirect URL with tokens directly.
 */
export async function signInWithMicrosoft(): Promise<{ error: string | null }> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'azure',
    options: {
      redirectTo: REDIRECT_URI,
      skipBrowserRedirect: true,
      scopes: 'email profile openid',
    },
  });

  if (error || !data.url) {
    return { error: error?.message ?? 'No OAuth URL returned' };
  }

  const result = await WebBrowser.openAuthSessionAsync(data.url, REDIRECT_URI);

  if (result.type === 'success' && result.url) {
    const sessionError = await extractSessionFromUrl(result.url);
    return { error: sessionError };
  }

  return { error: result.type === 'cancel' ? 'Sign in cancelled' : 'Sign in failed' };
}

/**
 * Sign in with email magic link.
 * Sends a magic link to the user's email address.
 */
export async function signInWithEmail(
  email: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: REDIRECT_URI,
    },
  });

  if (error) {
    return { error: error.message };
  }

  return { error: null };
}

/**
 * Sign out the current user and clear the session.
 */
export async function signOut(): Promise<{ error: string | null }> {
  // BACKLOG-2215: mark this sign-out as user-initiated BEFORE Supabase emits its
  // own SIGNED_OUT, so the auth gate never mistakes it for a session expiry
  // (which would wrongly show the "your session expired" notice). The
  // synchronous flag covers the live event; clearing the persisted marker covers
  // the next app launch.
  markDeliberateSignOut();
  await clearHadSession();

  const { error } = await supabase.auth.signOut();

  if (error) {
    return { error: error.message };
  }

  return { error: null };
}

/**
 * Get the current auth session (if any).
 */
export async function getSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/**
 * Subscribe to auth state changes.
 * Returns a subscription object that can be used to unsubscribe.
 */
export function onAuthStateChange(
  callback: (event: AuthChangeEvent, session: Session | null) => void,
): Subscription {
  const { data } = supabase.auth.onAuthStateChange(callback);
  return data.subscription;
}
