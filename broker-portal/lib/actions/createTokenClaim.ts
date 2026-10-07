'use server';

/**
 * BACKLOG-1603: Create Token Claim server action.
 *
 * Stores OAuth tokens in the token_claims table via the create_token_claim() RPC.
 * Returns a claim_id (UUID) that the desktop app uses to retrieve the tokens
 * securely over HTTPS instead of embedding them in the deep link URL.
 *
 * SOC 2 Control: CC6.1 - Secure credential transmission
 *
 * Uses service role client because:
 * - create_token_claim() is a SECURITY DEFINER function granted to service_role
 * - The browser client (anon key) cannot call it
 *
 * BACKLOG-3543: the action verifies the access token it is about to store
 * (same pattern as mintDesktopSession / enforceSingleDesktopSession), requires
 * the supplied userId to match that token's owner, stores only the four token
 * fields, and returns generic errors. Refusals are logged server-side by
 * category only.
 */

import { createServiceClient } from '@/lib/supabase/service';

interface TokenClaimPayload {
  access_token: string;
  refresh_token: string;
  provider_token?: string | null;
  provider_refresh_token?: string | null;
}

interface CreateTokenClaimResult {
  success: boolean;
  claimId?: string;
  error?: string;
}

type RefusalCategory = 'payload_shape' | 'provider' | 'unverified' | 'identity_mismatch';

const ALLOWED_KEYS = new Set([
  'access_token',
  'refresh_token',
  'provider_token',
  'provider_refresh_token',
]);
/** Supabase session tokens. */
const MAX_SESSION_TOKEN = 8192;
/** OAuth provider tokens (Microsoft access tokens with large claim sets can exceed 8 KB). */
const MAX_PROVIDER_TOKEN = 32768;
const PROVIDER_RE = /^[a-z0-9_-]{1,32}$/;

const REFUSED = 'Invalid token claim request';

function refuse(category: RefusalCategory): CreateTokenClaimResult {
  console.warn('[createTokenClaim] refused:', category);
  return { success: false, error: REFUSED };
}

function isRequiredToken(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_SESSION_TOKEN;
}

function isOptionalProviderToken(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  return typeof v === 'string' && v.length <= MAX_PROVIDER_TOKEN;
}

function cleanPayload(p: unknown): TokenClaimPayload | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!ALLOWED_KEYS.has(k)) return null;
  if (!isRequiredToken(o.access_token) || !isRequiredToken(o.refresh_token)) return null;
  if (!isOptionalProviderToken(o.provider_token)) return null;
  if (!isOptionalProviderToken(o.provider_refresh_token)) return null;
  return {
    access_token: o.access_token,
    refresh_token: o.refresh_token,
    provider_token: (o.provider_token as string | null | undefined) ?? null,
    provider_refresh_token: (o.provider_refresh_token as string | null | undefined) ?? null,
  };
}

export async function createTokenClaim(
  userId: string,
  payload: TokenClaimPayload,
  provider: string
): Promise<CreateTokenClaimResult> {
  try {
    const clean = cleanPayload(payload);
    if (!clean) return refuse('payload_shape');
    if (typeof provider !== 'string' || !PROVIDER_RE.test(provider)) return refuse('provider');

    const supabase = createServiceClient();

    // Identity comes from the VERIFIED token being stored, never the client-supplied id.
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(clean.access_token);
    if (userError || !user) return refuse('unverified');
    if (user.id !== userId) return refuse('identity_mismatch');

    const { data: claimId, error } = await supabase.rpc('create_token_claim', {
      p_user_id: user.id,
      p_payload: clean,
      p_provider: provider,
    });

    if (error) {
      console.error('[createTokenClaim] RPC error:', error.message);
      return { success: false, error: 'Failed to create token claim' };
    }

    if (!claimId) {
      console.error('[createTokenClaim] No claim_id returned');
      return { success: false, error: 'Failed to create token claim' };
    }

    return { success: true, claimId: claimId as string };
  } catch (err) {
    console.error('[createTokenClaim] Unexpected error:', err);
    return { success: false, error: 'Failed to create token claim' };
  }
}
