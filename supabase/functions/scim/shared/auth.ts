/**
 * SCIM Authentication, Rate Limiting & Sync Logging
 *
 * Bearer token validation against the scim_tokens table,
 * rate limiting per token, and SCIM operation audit logging.
 */

import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { checkRateLimit } from "../../_shared/rateLimiter.ts";
import { AuthResult, CORS_HEADERS, SCIM_CONTENT_TYPE, SCIM_ERROR_SCHEMA } from "./types.ts";
import { scimError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 hash a plaintext string and return its hex digest. */
async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Authenticate a SCIM request by validating the Bearer token against the
 * scim_tokens table. Returns auth context on success, or a SCIM error Response.
 */
export async function authenticateScimRequest(
  req: Request,
  supabaseAdmin: SupabaseClient,
): Promise<AuthResult | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return scimError(401, "Missing or invalid Authorization header");
  }

  const token = authHeader.substring(7);
  if (!token) {
    return scimError(401, "Empty bearer token");
  }

  const tokenHash = await sha256(token);

  const { data: tokenRecord, error } = await supabaseAdmin
    .from("scim_tokens")
    .select(
      "id, organization_id, can_create_users, can_update_users, can_delete_users, expires_at, revoked_at",
    )
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .single();

  if (error || !tokenRecord) {
    return scimError(401, "Invalid or revoked token");
  }

  // Check expiration
  if (
    tokenRecord.expires_at &&
    new Date(tokenRecord.expires_at) < new Date()
  ) {
    return scimError(401, "Token expired");
  }

  // Atomic increment of request_count and update last_used_at
  // Uses raw SQL via .rpc() to avoid read-then-write race conditions
  await supabaseAdmin.rpc("increment_scim_token_usage", {
    p_token_id: tokenRecord.id,
  });

  return {
    orgId: tokenRecord.organization_id,
    tokenId: tokenRecord.id,
    permissions: {
      canCreate: tokenRecord.can_create_users ?? true,
      canUpdate: tokenRecord.can_update_users ?? true,
      canDelete: tokenRecord.can_delete_users ?? false,
    },
  };
}

// ---------------------------------------------------------------------------
// Rate Limiting
// ---------------------------------------------------------------------------

/**
 * Apply SCIM rate limiting by token ID.
 * Returns null if allowed, or a 429 Response if rate-limited.
 */
export function checkScimRateLimit(tokenId: string): Response | null {
  const rateLimitMaxRequests = parseInt(
    Deno.env.get("SCIM_RATE_LIMIT_MAX") || "100",
    10,
  );
  const rateLimitWindowMs = parseInt(
    Deno.env.get("SCIM_RATE_LIMIT_WINDOW_MS") || "60000",
    10,
  );
  const rateLimitKey = `scim:${tokenId}`;
  const { allowed, retryAfter } = checkRateLimit(
    rateLimitKey,
    rateLimitMaxRequests,
    rateLimitWindowMs,
  );

  if (!allowed) {
    return new Response(
      JSON.stringify({
        schemas: [SCIM_ERROR_SCHEMA],
        detail: "Rate limit exceeded",
        status: 429,
      }),
      {
        status: 429,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": SCIM_CONTENT_TYPE,
          "Retry-After": String(retryAfter),
        },
      },
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Sync Log
// ---------------------------------------------------------------------------

/** Log a SCIM operation to the scim_sync_log table. */
export async function logScimOperation(
  supabaseAdmin: SupabaseClient,
  params: {
    organizationId: string;
    operation: string;
    resourceType: string;
    resourceId?: string;
    externalId?: string;
    requestPayload?: unknown;
    responseStatus: number;
    errorMessage?: string;
    scimTokenId: string;
  },
): Promise<void> {
  const { error } = await supabaseAdmin.from("scim_sync_log").insert({
    organization_id: params.organizationId,
    operation: params.operation,
    resource_type: params.resourceType,
    resource_id: params.resourceId || null,
    external_id: params.externalId || null,
    request_payload: params.requestPayload || null,
    response_status: params.responseStatus,
    error_message: params.errorMessage || null,
    scim_token_id: params.scimTokenId,
  });
  if (error) {
    // The seat-email de-dupe reads these rows; a lost row can mean one extra email.
    console.error("[scim] sync log insert failed:", error.message);
  }
}
