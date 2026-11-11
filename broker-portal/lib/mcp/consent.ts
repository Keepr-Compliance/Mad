/**
 * Consent flow helpers for /oauth/consent (BACKLOG-4237).
 *
 * Reads the authorization with the signed-in user's own session (no service
 * role) and refuses any authorization whose redirect address is not on the
 * allowlist. Every redirect URL handed to the browser is checked first.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { allowedTargetOf, isAllowedRedirectUri, redirectHost, redirectUrlGoesTo } from './redirectAllowlist';

export const CONSENT_COOKIE_NAME = 'keepr_mcp_consent';
export const CONSENT_COOKIE_PATH = '/oauth';
export const CONSENT_COOKIE_MAX_AGE_SECONDS = 600;
export const CONSENT_RESUME_PATH = '/dashboard/account/ai-apps';

/** Authorization ids are opaque; accept a conservative token shape only. */
export function isAuthorizationId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

export type ConsentView =
  | { kind: 'consent'; authorizationId: string; clientName: string; redirectHost: string; scope: string }
  | { kind: 'redirect'; url: string }
  | { kind: 'refused' }
  | { kind: 'error' };

export async function loadConsent(supabase: SupabaseClient, authorizationId: string): Promise<ConsentView> {
  let result;
  try {
    result = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  } catch {
    return { kind: 'error' };
  }
  const { data, error } = result;
  if (error || !data) return { kind: 'error' };

  if ('authorization_id' in data) {
    if (!isAllowedRedirectUri(data.redirect_uri)) return { kind: 'refused' };
    return {
      kind: 'consent',
      authorizationId: data.authorization_id,
      clientName: typeof data.client?.name === 'string' ? data.client.name : '',
      redirectHost: redirectHost(data.redirect_uri),
      scope: typeof data.scope === 'string' ? data.scope : '',
    };
  }

  // Already consented: Supabase returns only the final URL. It must still go
  // to an allow-listed address.
  if (allowedTargetOf(data.redirect_url) === null) return { kind: 'refused' };
  return { kind: 'redirect', url: data.redirect_url };
}

export type ConsentDecision = 'approve' | 'deny';
export type DecisionResult = { ok: true; url: string } | { ok: false; reason: 'refused' | 'error' };

export async function decide(
  supabase: SupabaseClient,
  authorizationId: string,
  decision: ConsentDecision
): Promise<DecisionResult> {
  // Re-read on the server: the browser's copy of the page is not trusted.
  let details;
  try {
    details = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  } catch {
    return { ok: false, reason: 'error' };
  }
  if (details.error || !details.data) return { ok: false, reason: 'error' };
  if (!('authorization_id' in details.data)) {
    const url = details.data.redirect_url;
    return allowedTargetOf(url) === null ? { ok: false, reason: 'refused' } : { ok: true, url };
  }
  const expected = details.data.redirect_uri;
  if (!isAllowedRedirectUri(expected)) return { ok: false, reason: 'refused' };

  let result;
  try {
    result =
      decision === 'approve'
        ? await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
        : await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
  } catch {
    return { ok: false, reason: 'error' };
  }
  if (result.error || !result.data) return { ok: false, reason: 'error' };
  if (!redirectUrlGoesTo(result.data.redirect_url, expected)) return { ok: false, reason: 'refused' };
  return { ok: true, url: result.data.redirect_url };
}
