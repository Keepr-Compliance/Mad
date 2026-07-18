/**
 * Stripe SDK singleton + desktop-caller auth helper (BACKLOG-2005a).
 *
 * TEST MODE at launch: STRIPE_SECRET_KEY holds a test-mode key until the account
 * is activated (BACKLOG-2017). All code reads the key from env; nothing is hardcoded.
 *
 * The charge endpoints are called by the desktop app (Electron main process) with
 * the user's Supabase access token as a Bearer header. R5 (SR): verify the JWT
 * server-side and derive user_id ONLY from the verified token — never from the body.
 */

import Stripe from 'stripe';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';

let _stripe: Stripe | null = null;

/** Lazy Stripe singleton. Throws (500) if the secret key is not configured. */
export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  _stripe = new Stripe(key, {
    // Pin the API version so behavior is stable across Stripe upgrades.
    apiVersion: '2025-02-24.acacia',
    typescript: true,
  });
  return _stripe;
}

/** Currency + product framing shared by both charge flows. USD only at launch. */
export const CURRENCY = 'usd';
export const UNLOCK_PRODUCT_NAME = 'Keepr transaction unlock';

export interface VerifiedUser {
  userId: string;
  email: string | null;
}

/**
 * Extract and verify the Bearer JWT from a desktop-originated request.
 * Returns the verified user, or null if the token is missing/invalid.
 *
 * Uses a stateless @supabase/supabase-js client (anon key) and getUser(jwt),
 * which validates the token signature/expiry server-side. We derive user_id from
 * the verified token — the request body's user_id (if any) is ignored (R5).
 */
export async function verifyBearerUser(req: Request): Promise<VerifiedUser | null> {
  const authHeader = req.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  if (!token) return null;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }

  const supabase = createSupabaseJsClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return { userId: data.user.id, email: data.user.email ?? null };
}

/** Server-quoted price for the user's next PAID unlock. Never client-supplied. */
export interface UnlockQuote {
  nextUnitIndex: number;
  unitPriceCents: number;
  currency: string;
  pricingTierId: string;
}

/** Deep-link the desktop app returns through after Checkout / hosted SCA. */
export function paymentCallbackUrl(checkoutSessionId: string): string {
  return `keepr://payment-callback?session=${encodeURIComponent(checkoutSessionId)}`;
}
