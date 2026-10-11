/**
 * Supabase Edge Function: Issue Offline Pass (BACKLOG-3675)
 *
 * Returns a short-lived signed pass that lets the desktop app honour the
 * `unlimited_transactions` feature while it has no network, for at most
 * 48 hours and never past the paid period.
 *
 * Deploy WITH gateway JWT verification (the default):
 *   supabase functions deploy issue-offline-pass --project-ref <ref>
 *
 * Request: POST with the signed-in user's access token. The body is ignored;
 * the user id comes from the token only.
 *
 * Every read runs as the caller (anon key + the caller's Authorization
 * header), under the existing member SELECT policies. No service-role key.
 *
 * Responses:
 *   401 {pass:null, reason:"unauthenticated"}  no user behind the token
 *                                              (including the anon key)
 *   200 {pass:"<token>"}                        entitled
 *   200 {pass:null, reason:"not_entitled"|"paid_period_ended"|"paid_through_invalid"}
 *   429 {pass:null, reason:"rate_limited"}
 *   503 {pass:null, reason:"unavailable"|"issuer_unconfigured"}
 *
 * Secrets: OFFLINE_PASS_SIGNING_KEY (Ed25519 PKCS#8 DER, base64) and
 * OFFLINE_PASS_KID (e.g. "k1"). The matching public key is embedded in the
 * desktop app (electron/constants/offlinePassKeys.ts).
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.110.2";
import { checkRateLimit } from "../_shared/rateLimiter.ts";
import {
  chooseMembership,
  computePassClaims,
  isUnlimitedEnabled,
  parsePaidThrough,
  signOfflinePass,
  OFFLINE_PASS_ENTITLEMENT,
  type MembershipRowLike,
} from "../_shared/offlinePassClaims.ts";

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return reply(405, { pass: null, reason: "method_not_allowed" });
  }

  const authorization = req.headers.get("Authorization");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    return reply(503, { pass: null, reason: "unavailable" });
  }
  if (!authorization) {
    return reply(401, { pass: null, reason: "unauthenticated" });
  }

  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // The user id comes from the token, never from the request body.
  let sub: string | null = null;
  try {
    const { data, error } = await client.auth.getUser();
    sub = !error && data?.user?.id ? data.user.id : null;
  } catch {
    sub = null;
  }
  if (!sub) {
    return reply(401, { pass: null, reason: "unauthenticated" });
  }

  const rate = checkRateLimit(`issue-offline-pass:${sub}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rate.allowed) {
    return reply(429, { pass: null, reason: "rate_limited" });
  }

  try {
    // 1. Which organization decides (same rule as the desktop).
    const { data: rows, error: membershipError } = await client
      .from("organization_members")
      .select("organization_id, organizations(*)")
      .eq("user_id", sub)
      .eq("license_status", "active")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (membershipError || !Array.isArray(rows)) {
      return reply(503, { pass: null, reason: "unavailable" });
    }
    const orgId = chooseMembership(rows as MembershipRowLike[]);
    if (!orgId) {
      return reply(200, { pass: null, reason: "not_entitled" });
    }

    // 2. Is the feature on for that organization?
    const { data: features, error: featuresError } = await client.rpc("get_org_features", {
      p_org_id: orgId,
    });
    if (featuresError) {
      return reply(503, { pass: null, reason: "unavailable" });
    }
    if (!isUnlimitedEnabled(features)) {
      return reply(200, { pass: null, reason: "not_entitled" });
    }

    // 3. Optional paid-period end from the override.
    const { data: planRow, error: planError } = await client
      .from("organization_plans")
      .select("feature_overrides")
      .eq("organization_id", orgId)
      .maybeSingle();
    if (planError) {
      return reply(503, { pass: null, reason: "unavailable" });
    }
    const overrides = (planRow?.feature_overrides ?? null) as Record<string, unknown> | null;
    const paid = parsePaidThrough(overrides ? overrides[OFFLINE_PASS_ENTITLEMENT] : null);
    if (!paid.ok) {
      return reply(200, { pass: null, reason: "paid_through_invalid" });
    }

    const claims = computePassClaims({
      sub,
      org: orgId,
      nowSec: Math.floor(Date.now() / 1000),
      pte: paid.pte,
      jti: crypto.randomUUID(),
    });
    if (!claims) {
      return reply(200, { pass: null, reason: "paid_period_ended" });
    }

    const signingKey = Deno.env.get("OFFLINE_PASS_SIGNING_KEY");
    const kid = Deno.env.get("OFFLINE_PASS_KID");
    if (!signingKey || !kid) {
      return reply(503, { pass: null, reason: "issuer_unconfigured" });
    }

    const pass = await signOfflinePass({ claims, kid, pkcs8Base64: signingKey });
    return reply(200, { pass });
  } catch (error) {
    console.error("[issue-offline-pass] failed", error instanceof Error ? error.message : String(error));
    return reply(503, { pass: null, reason: "unavailable" });
  }
});
