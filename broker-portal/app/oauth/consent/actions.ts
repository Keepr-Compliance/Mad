'use server';

/**
 * Approve / deny for /oauth/consent — BACKLOG-4237.
 *
 * Returns the URL the browser should navigate to; the client navigates in
 * script (the portal CSP sets form-action 'self').
 */

import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import {
  CONSENT_COOKIE_NAME,
  CONSENT_COOKIE_PATH,
  decide,
  isAuthorizationId,
  type ConsentDecision,
  type DecisionResult,
} from '@/lib/mcp/consent';

export async function decideConsent(authorizationId: string, decision: ConsentDecision): Promise<DecisionResult> {
  if (!isAuthorizationId(authorizationId)) return { ok: false, reason: 'error' };
  if (decision !== 'approve' && decision !== 'deny') return { ok: false, reason: 'error' };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: 'error' };

  const result = await decide(supabase, authorizationId, decision);
  if (result.ok) {
    const store = await cookies();
    store.set({ name: CONSENT_COOKIE_NAME, value: '', path: CONSENT_COOKIE_PATH, maxAge: 0 });
  }
  return result;
}
