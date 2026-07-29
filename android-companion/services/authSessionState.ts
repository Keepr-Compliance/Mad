/**
 * Auth session-state marker (Keepr Companion) — BACKLOG-2215.
 *
 * Supabase collapses "the user never signed in" and "the user HAD a session but
 * its refresh token failed / was revoked" into the same observable state:
 * `getSession()` returns null and `onAuthStateChange` emits `SIGNED_OUT`. That
 * makes the auth gate in `_layout.tsx` unable to tell an expiry from a first
 * run, so an expired user is silently bounced to login with no explanation.
 *
 * This module persists a tiny "we have (or had) a real session" marker so the
 * auth gate can distinguish the two:
 *
 *   - `markHadSession()`   — call whenever a live session is observed.
 *   - `clearHadSession()`  — call on a DELIBERATE sign-out, BEFORE Supabase
 *                            emits its own `SIGNED_OUT`, so a user-initiated
 *                            sign-out never reads as an expiry.
 *   - `consumeHadSession()`— read-and-clear: returns true iff a session was
 *                            previously established and NOT deliberately signed
 *                            out. Clearing on read means the "session expired"
 *                            notice is shown once, not on every relaunch.
 *
 * All writes are best-effort — a storage failure must never crash the auth gate
 * or block routing; the worst case is falling back to the old (message-less)
 * behavior.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/** AsyncStorage key for the had-session marker. */
export const HAD_SESSION_KEY = '@keepr/had-session';

/** Remember that a real session exists, so a later loss can be shown as expiry. */
export async function markHadSession(): Promise<void> {
  try {
    await AsyncStorage.setItem(HAD_SESSION_KEY, 'true');
  } catch {
    /* best-effort: never block auth on a storage write */
  }
}

/**
 * Clear the marker. Call on a DELIBERATE sign-out before Supabase fires its own
 * `SIGNED_OUT`, so the subsequent session loss is not mistaken for an expiry.
 */
export async function clearHadSession(): Promise<void> {
  try {
    await AsyncStorage.removeItem(HAD_SESSION_KEY);
  } catch {
    /* best-effort */
  }
}

/**
 * Return true iff a session was previously established (and not deliberately
 * signed out), clearing the marker in the process so the expiry notice is a
 * one-shot. Returns false on first run or after a deliberate sign-out.
 */
export async function consumeHadSession(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(HAD_SESSION_KEY);
    if (value === 'true') {
      await AsyncStorage.removeItem(HAD_SESSION_KEY);
      return true;
    }
  } catch {
    /* best-effort: treat storage failure as "no prior session" */
  }
  return false;
}

/**
 * Synchronous "the user tapped Sign Out" flag.
 *
 * Supabase fires the SAME `SIGNED_OUT` event for a deliberate sign-out and a
 * failed token refresh, so the auth gate needs an out-of-band signal to tell
 * them apart the instant the event lands — a synchronous marker, because the
 * routing decision runs in the same React batch as the session going null and
 * cannot wait on an async storage read. `signOut()` sets it before Supabase
 * emits the event; the auth-gate listener takes (reads-and-clears) it and, when
 * set, suppresses the "session expired" notice for that transition.
 */
let deliberateSignOut = false;

/** Mark the imminent `SIGNED_OUT` as user-initiated (call inside `signOut()`). */
export function markDeliberateSignOut(): void {
  deliberateSignOut = true;
}

/** Read-and-clear the deliberate-sign-out flag (one-shot). */
export function takeDeliberateSignOut(): boolean {
  const value = deliberateSignOut;
  deliberateSignOut = false;
  return value;
}
