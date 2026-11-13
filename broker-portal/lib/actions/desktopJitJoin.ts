'use server';

/**
 * BACKLOG-3962 PR4a: the JIT step at a DESKTOP sign-in, with the same rules as the portal
 * (founder answer, plan v2 question 3: A).
 *
 * Called by app/auth/desktop/callback/page.tsx, AWAITED before the page hands anything to the
 * desktop app: the app creates its licence as soon as it has a session (electron/main.ts), so a
 * join has to be in place first, and a person whose brokerage has turned off personal accounts is
 * shown that message instead of being sent to the app at all.
 *
 * Identity comes from a VERIFIED getUser(accessToken), never from client input, and every call
 * runs on a client that carries that same access token (as syncDesktopIdpNames.ts): the database
 * decides on auth.uid(). Never the server role.
 *
 * Best-effort: resolves on every path and never throws. Any failure answers 'ok', and the
 * database's own gates still apply when the app creates its licence.
 */

import { createClient } from '@supabase/supabase-js';
import { domainManagedFor, runJitJoin } from '@/lib/auth/jitJoin';

export type DesktopJitResult =
  | { status: 'ok' }
  | { status: 'domain_managed'; organizationName: string; domain: string };

const OK: DesktopJitResult = { status: 'ok' };

export async function desktopJitJoin(accessToken: string): Promise<DesktopJitResult> {
  try {
    if (!accessToken) return OK;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      console.error('[desktopJitJoin] missing Supabase configuration');
      return OK;
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
      console.error('[desktopJitJoin] could not verify the user');
      return OK;
    }

    // As the portal: a pending invitation decides, through its link; JIT does not run.
    const { data: hasPendingInvite } = await userClient.rpc('caller_has_pending_invite');
    if (hasPendingInvite === true) return OK;

    const jit = await runJitJoin(userClient, user);
    if (jit.joined) return OK;

    const managed = await domainManagedFor(userClient);
    return managed ? { status: 'domain_managed', ...managed } : OK;
  } catch {
    console.error('[desktopJitJoin] failed');
    return OK;
  }
}
