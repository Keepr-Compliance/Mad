/**
 * Supabase Edge Function: Directory Sync
 *
 * Periodically pulls users from configured identity providers (Azure AD,
 * Google Workspace) for organizations with directory_sync_enabled = true.
 *
 * Invocation:
 *   POST /functions/v1/directory-sync           -- sync all enabled orgs
 *   POST /functions/v1/directory-sync?org_id=X  -- sync a single org
 *
 * Flow per organization:
 *   1. Read IdP config from organization_identity_providers
 *   2. Obtain an access token via client credentials (Azure) or service
 *      account JWT (Google)
 *   3. Fetch all users from the provider API (with pagination)
 *   4. Compare with existing organization_members
 *   5. Upsert new members (provisioned_by = 'directory_sync')
 *   6. Suspend removed members (license_status = 'suspended')
 *   7. Update directory_sync_last_at / directory_sync_error
 *
 * Authentication:
 *   - Requires Authorization header with Bearer token matching the
 *     SUPABASE_SERVICE_ROLE_KEY. This restricts invocation to internal
 *     callers (cron jobs, admin scripts) that possess the service role key.
 *
 * Design decisions:
 *   - One org at a time to limit blast radius
 *   - Idempotent: running twice produces the same result
 *   - Never deletes members -- only suspends (audit data preservation)
 *   - Exponential backoff on API rate limits
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  resolveRole,
  extractGroupRoleMapping,
} from "../_shared/groupRoleMapper.ts";
import { placeDirectoryUser } from "./placement.ts";
import {
  defaultLastAdminNotifyDeps,
  notifyLastAdminKept,
  type LastAdminNotifyDeps,
} from "../_shared/lastAdminNotify.ts";
import {
  billingSkipMessage,
  isBillingSetupIncompleteError,
  readJoinsBlocked,
} from "../_shared/billingSetup.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IdpConfig {
  id: string;
  organization_id: string;
  provider_type: string;
  client_id: string | null;
  /**
   * KNOWN LIMITATION: Despite the "_encrypted" suffix, this column currently
   * stores plaintext. The column name is intentionally future-proofed for when
   * a KMS (Key Management Service) integration is added to provide actual
   * at-rest encryption. Do NOT assume this value is encrypted when reading it.
   */
  client_secret_encrypted: string | null;
  /**
   * KNOWN LIMITATION: Despite the "_encrypted" suffix, this column currently
   * stores the raw Google service account JSON key in plaintext. Same rationale
   * as client_secret_encrypted -- the name is future-proofed for KMS
   * integration. Do NOT assume this value is encrypted when reading it.
   */
  service_account_key_encrypted: string | null;
  issuer_url: string | null;
  is_active: boolean;
  attribute_mapping: Record<string, unknown> | null;
}

export interface ProviderUser {
  /** Provider-side unique ID (Azure objectId / Google user id) */
  externalId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  /** IdP group IDs/names the user belongs to */
  groups: string[];
}

interface OrgMember {
  user_id: string;
  email: string;
  oauth_id: string | null;
  scim_external_id: string | null;
  provisioned_by: string | null;
  license_status: string | null;
  group_sync_enabled: boolean | null;
  role: string | null;
}

interface SyncResult {
  orgId: string;
  added: number;
  suspended: number;
  reactivated: number;
  /** BACKLOG-4012: people not added or re-activated because billing setup is pending. */
  skipped_billing_setup: number;
  /** BACKLOG-4027: changes the database kept back because the person is the last active admin. */
  skipped_last_admin: number;
  error: string | null;
}

/** BACKLOG-4012: what the handler passes in; fetchUsers is injectable for tests. */
export interface SyncOptions {
  /** Billing setup is pending (_billing_org_join_blocked): add and re-activate no one. */
  joinsBlocked?: boolean;
  fetchUsers?: (idp: IdpConfig, org: Record<string, unknown>) => Promise<ProviderUser[]>;
  /** BACKLOG-4027: the last-admin email (fetch / env injectable for tests). */
  notifyDeps?: LastAdminNotifyDeps;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Maximum retries for rate-limited API requests */
const MAX_RETRIES = 3;

/** Base delay in ms for exponential backoff */
const BASE_BACKOFF_MS = 1000;

// ---------------------------------------------------------------------------
// Azure AD -- Microsoft Graph API
// ---------------------------------------------------------------------------

/**
 * Obtain an access token from Azure AD using the client credentials flow.
 *
 * POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
 */
async function getAzureAccessToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Azure token request failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return data.access_token as string;
}

/**
 * Fetch all users from Azure AD via the Microsoft Graph API.
 * Handles pagination via @odata.nextLink.
 */
async function fetchAzureUsers(accessToken: string): Promise<ProviderUser[]> {
  const users: ProviderUser[] = [];
  let url: string | null =
    "https://graph.microsoft.com/v1.0/users?$select=id,displayName,givenName,surname,mail,userPrincipalName&$top=999";

  while (url) {
    const resp = await fetchWithBackoff(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Azure Graph API error (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    const value = data.value as Array<Record<string, string>>;

    for (const u of value) {
      const email = (u.mail || u.userPrincipalName || "").toLowerCase();
      if (!email || email.includes("#EXT#")) continue; // Skip external/guest users

      users.push({
        externalId: u.id,
        email,
        firstName: u.givenName || null,
        lastName: u.surname || null,
        displayName: u.displayName || null,
        groups: [], // Populated later if group sync enabled
      });
    }

    url = (data["@odata.nextLink"] as string) || null;
  }

  return users;
}

// ---------------------------------------------------------------------------
// Google Workspace -- Admin SDK
// ---------------------------------------------------------------------------

/**
 * Create a signed JWT for Google service account authentication.
 * Uses the RS256 algorithm with the Web Crypto API.
 */
async function createServiceAccountJwt(
  serviceAccountEmail: string,
  privateKey: string,
  scopes: string[],
  subject?: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload: Record<string, unknown> = {
    iss: serviceAccountEmail,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  if (subject) {
    payload.sub = subject;
  }

  const encoder = new TextEncoder();

  const headerB64 = base64urlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  // Import the private key
  const key = await importPkcs8Key(privateKey);

  // Sign
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    key,
    encoder.encode(signingInput),
  );

  const signatureB64 = base64urlEncode(new Uint8Array(signature));
  return `${signingInput}.${signatureB64}`;
}

/** Import a PKCS8 PEM private key for signing. */
async function importPkcs8Key(pem: string): Promise<CryptoKey> {
  // Strip PEM headers and whitespace
  const pemBody = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  const binaryStr = atob(pemBody);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  return await crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Base64url encode (no padding). */
function base64urlEncode(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Exchange a service account JWT for an access token.
 */
async function getGoogleAccessToken(jwt: string): Promise<string> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google token request failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return data.access_token as string;
}

/**
 * Fetch all users from Google Workspace via the Admin SDK.
 * Handles pagination via nextPageToken.
 */
async function fetchGoogleUsers(
  accessToken: string,
  domain: string,
): Promise<ProviderUser[]> {
  const users: ProviderUser[] = [];
  let pageToken: string | null = null;

  do {
    let url = `https://admin.googleapis.com/admin/directory/v1/users?domain=${encodeURIComponent(domain)}&maxResults=500&projection=basic`;
    if (pageToken) {
      url += `&pageToken=${encodeURIComponent(pageToken)}`;
    }

    const resp = await fetchWithBackoff(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Google Admin SDK error (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    const googleUsers = (data.users || []) as Array<Record<string, unknown>>;

    for (const u of googleUsers) {
      const email = ((u.primaryEmail as string) || "").toLowerCase();
      if (!email) continue;
      // Skip suspended users in Google -- they should not be provisioned
      if (u.suspended === true) continue;

      const name = u.name as Record<string, string> | undefined;
      users.push({
        externalId: u.id as string,
        email,
        firstName: name?.givenName || null,
        lastName: name?.familyName || null,
        displayName: name?.fullName || null,
        groups: [], // Populated later if group sync enabled
      });
    }

    pageToken = (data.nextPageToken as string) || null;
  } while (pageToken);

  return users;
}

// ---------------------------------------------------------------------------
// Azure AD -- Group Memberships
// ---------------------------------------------------------------------------

/**
 * Fetch group memberships for an Azure AD user via the memberOf endpoint.
 * Returns an array of group IDs and display names.
 */
async function fetchAzureUserGroups(
  accessToken: string,
  userId: string,
): Promise<string[]> {
  const groups: string[] = [];
  const url = `https://graph.microsoft.com/v1.0/users/${userId}/memberOf?$select=id,displayName,@odata.type&$top=999`;

  try {
    const resp = await fetchWithBackoff(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) {
      console.warn(
        `[directory-sync] Failed to fetch groups for Azure user ${userId}: ${resp.status}`,
      );
      return groups;
    }

    const data = await resp.json();
    const members = data.value as Array<Record<string, string>>;

    for (const m of members) {
      // Only include security groups and Microsoft 365 groups
      if (
        m["@odata.type"] === "#microsoft.graph.group"
      ) {
        if (m.id) groups.push(m.id);
        if (m.displayName && m.displayName !== m.id) {
          groups.push(m.displayName);
        }
      }
    }
  } catch (err) {
    console.warn(
      `[directory-sync] Error fetching groups for Azure user ${userId}: ${err}`,
    );
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Google Workspace -- Group Memberships
// ---------------------------------------------------------------------------

/**
 * Fetch group memberships for a Google Workspace user.
 * Uses the Admin SDK groups endpoint to list groups the user belongs to.
 */
async function fetchGoogleUserGroups(
  accessToken: string,
  userEmail: string,
): Promise<string[]> {
  const groups: string[] = [];
  let pageToken: string | null = null;

  try {
    do {
      let url = `https://admin.googleapis.com/admin/directory/v1/groups?userKey=${encodeURIComponent(userEmail)}&maxResults=200`;
      if (pageToken) {
        url += `&pageToken=${encodeURIComponent(pageToken)}`;
      }

      const resp = await fetchWithBackoff(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!resp.ok) {
        console.warn(
          `[directory-sync] Failed to fetch groups for Google user ${userEmail}: ${resp.status}`,
        );
        return groups;
      }

      const data = await resp.json();
      const googleGroups = (data.groups || []) as Array<
        Record<string, unknown>
      >;

      for (const g of googleGroups) {
        if (g.id) groups.push(g.id as string);
        if (g.name && g.name !== g.id) groups.push(g.name as string);
      }

      pageToken = (data.nextPageToken as string) || null;
    } while (pageToken);
  } catch (err) {
    console.warn(
      `[directory-sync] Error fetching groups for Google user ${userEmail}: ${err}`,
    );
  }

  return groups;
}

// ---------------------------------------------------------------------------
// HTTP Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch with exponential backoff for rate limit (429) responses.
 */
async function fetchWithBackoff(
  url: string,
  init: RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(url, init);

    if (resp.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = resp.headers.get("Retry-After");
      const delayMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : BASE_BACKOFF_MS * Math.pow(2, attempt);
      console.warn(
        `Rate limited on ${url}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(delayMs);
      continue;
    }

    return resp;
  }

  // Should not reach here, but TypeScript needs a return
  return await fetch(url, init);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Sync Logic
// ---------------------------------------------------------------------------

/**
 * Fetch users from the appropriate provider based on IdP type.
 */
async function fetchProviderUsers(
  idp: IdpConfig,
  org: Record<string, unknown>,
): Promise<ProviderUser[]> {
  if (idp.provider_type === "azure_ad") {
    if (!idp.client_id || !idp.client_secret_encrypted) {
      throw new Error("Azure AD IdP missing client_id or client_secret");
    }

    // Extract tenant ID from issuer_url or use the org's microsoft_tenant_id
    let tenantId = org.microsoft_tenant_id as string | null;
    if (!tenantId && idp.issuer_url) {
      // issuer_url is typically https://login.microsoftonline.com/{tenantId}/v2.0
      const match = idp.issuer_url.match(
        /login\.microsoftonline\.com\/([^/]+)/,
      );
      tenantId = match?.[1] || null;
    }
    if (!tenantId) {
      throw new Error("Azure AD IdP missing tenant ID");
    }

    // NOTE: client_secret_encrypted is currently plaintext (no KMS yet).
    // When KMS is integrated, decrypt here before passing to the Azure API.
    const accessToken = await getAzureAccessToken(
      tenantId,
      idp.client_id,
      idp.client_secret_encrypted,
    );

    return await fetchAzureUsers(accessToken);
  }

  if (idp.provider_type === "google_workspace") {
    if (!idp.service_account_key_encrypted) {
      throw new Error(
        "Google Workspace IdP missing service_account_key",
      );
    }

    const domain = org.google_workspace_domain as string | null;
    if (!domain) {
      throw new Error("Organization missing google_workspace_domain");
    }

    // Parse the service account key JSON.
    // NOTE: service_account_key_encrypted is currently plaintext (no KMS yet).
    // When KMS is integrated, decrypt here before parsing.
    let serviceAccountKey: Record<string, string>;
    try {
      serviceAccountKey = JSON.parse(idp.service_account_key_encrypted);
    } catch {
      throw new Error("Invalid service account key JSON");
    }

    const serviceAccountEmail = serviceAccountKey.client_email;
    const privateKey = serviceAccountKey.private_key;

    if (!serviceAccountEmail || !privateKey) {
      throw new Error(
        "Service account key missing client_email or private_key",
      );
    }

    // Create JWT with domain-wide delegation (sub = admin email)
    // The admin email should be an admin of the Google Workspace domain
    // For directory sync, we need to impersonate an admin
    const adminEmail = (org.directory_sync_admin_email as string) || serviceAccountEmail;

    const jwt = await createServiceAccountJwt(
      serviceAccountEmail,
      privateKey,
      ["https://www.googleapis.com/auth/admin.directory.user.readonly"],
      adminEmail !== serviceAccountEmail ? adminEmail : undefined,
    );

    const accessToken = await getGoogleAccessToken(jwt);
    return await fetchGoogleUsers(accessToken, domain);
  }

  throw new Error(`Unsupported provider type: ${idp.provider_type}`);
}

/**
 * Sync a single organization's directory.
 *
 * Steps:
 *   1. Fetch current members from organization_members + users
 *   2. Fetch users from the identity provider
 *   3. Diff: find users to add and members to suspend
 *   4. Provision new members
 *   5. Suspend removed members
 *   6. Reactivate previously-suspended members who reappear
 *   7. Update sync timestamp
 */
export async function syncOrganization(
  supabaseAdmin: SupabaseClient,
  orgId: string,
  org: Record<string, unknown>,
  idp: IdpConfig,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = {
    orgId,
    added: 0,
    suspended: 0,
    reactivated: 0,
    skipped_billing_setup: 0,
    skipped_last_admin: 0,
    error: null,
  };
  const joinsBlocked = options.joinsBlocked === true;
  // BACKLOG-4027: one last-admin email per brokerage per run, whatever the count.
  let lastAdminKept: { label: string; kind: "deactivate" | "demote" } | null = null;

  try {
    // 1. Fetch provider users
    const providerUsers = await (options.fetchUsers ?? fetchProviderUsers)(idp, org);
    console.log(
      `[directory-sync] Org ${orgId}: fetched ${providerUsers.length} users from ${idp.provider_type}`,
    );

    // 1b. Extract group-to-role mapping configuration
    const groupMapping = extractGroupRoleMapping(idp.attribute_mapping);
    const groupSyncEnabled = groupMapping.group_sync_enabled;

    // 1c. If group sync is enabled, fetch group memberships for each user
    if (groupSyncEnabled && providerUsers.length > 0) {
      console.log(
        `[directory-sync] Org ${orgId}: fetching group memberships (group_sync_enabled=true)`,
      );

      if (idp.provider_type === "azure_ad") {
        // Get Azure access token (already used for fetching users)
        let tenantId = org.microsoft_tenant_id as string | null;
        if (!tenantId && idp.issuer_url) {
          const match = idp.issuer_url.match(
            /login\.microsoftonline\.com\/([^/]+)/,
          );
          tenantId = match?.[1] || null;
        }
        if (tenantId && idp.client_id && idp.client_secret_encrypted) {
          const groupAccessToken = await getAzureAccessToken(
            tenantId,
            idp.client_id,
            idp.client_secret_encrypted,
          );
          for (const user of providerUsers) {
            user.groups = await fetchAzureUserGroups(
              groupAccessToken,
              user.externalId,
            );
          }
        }
      } else if (idp.provider_type === "google_workspace") {
        // For Google, we need the same access token scope -- but we need
        // admin.directory.group.readonly in addition to user.readonly.
        // Re-create JWT with both scopes.
        if (idp.service_account_key_encrypted) {
          try {
            const serviceAccountKey = JSON.parse(
              idp.service_account_key_encrypted,
            );
            const serviceAccountEmail = serviceAccountKey.client_email;
            const privateKey = serviceAccountKey.private_key;
            const adminEmail =
              (org.directory_sync_admin_email as string) ||
              serviceAccountEmail;

            if (serviceAccountEmail && privateKey) {
              const groupJwt = await createServiceAccountJwt(
                serviceAccountEmail,
                privateKey,
                [
                  "https://www.googleapis.com/auth/admin.directory.user.readonly",
                  "https://www.googleapis.com/auth/admin.directory.group.readonly",
                ],
                adminEmail !== serviceAccountEmail ? adminEmail : undefined,
              );
              const groupAccessToken = await getGoogleAccessToken(groupJwt);
              for (const user of providerUsers) {
                user.groups = await fetchGoogleUserGroups(
                  groupAccessToken,
                  user.email,
                );
              }
            }
          } catch {
            console.warn(
              `[directory-sync] Org ${orgId}: failed to fetch Google group memberships`,
            );
          }
        }
      }

      console.log(
        `[directory-sync] Org ${orgId}: group memberships fetched for ${providerUsers.filter((u) => u.groups.length > 0).length}/${providerUsers.length} users`,
      );
    }

    // 2. Get current org members with user details
    const { data: members, error: membersError } = await supabaseAdmin
      .from("organization_members")
      .select("user_id, provisioned_by, license_status, group_sync_enabled, role")
      .eq("organization_id", orgId);

    if (membersError) {
      throw new Error(`Failed to fetch org members: ${membersError.message}`);
    }

    const memberUserIds = (members || [])
      .map((m: Record<string, unknown>) => m.user_id as string)
      .filter(Boolean);

    // Fetch user details for existing members
    let existingUsers: OrgMember[] = [];
    if (memberUserIds.length > 0) {
      const { data: users } = await supabaseAdmin
        .from("users")
        .select("id, email, oauth_id, scim_external_id")
        .in("id", memberUserIds);

      existingUsers = (users || []).map((u: Record<string, unknown>) => {
        const member = (members || []).find(
          (m: Record<string, unknown>) => m.user_id === u.id,
        );
        return {
          user_id: u.id as string,
          email: (u.email as string || "").toLowerCase(),
          oauth_id: u.oauth_id as string | null,
          scim_external_id: u.scim_external_id as string | null,
          provisioned_by: member?.provisioned_by as string | null,
          license_status: member?.license_status as string | null,
          group_sync_enabled: member?.group_sync_enabled as boolean | null,
          role: member?.role as string | null,
        };
      });
    }

    // 3. Build lookup maps for efficient diffing
    const existingByEmail = new Map<string, OrgMember>();
    const existingByExternalId = new Map<string, OrgMember>();
    for (const member of existingUsers) {
      existingByEmail.set(member.email, member);
      if (member.oauth_id) {
        existingByExternalId.set(member.oauth_id, member);
      }
      if (member.scim_external_id) {
        existingByExternalId.set(member.scim_external_id, member);
      }
    }

    // Track which existing members are still in the provider directory
    const seenMemberIds = new Set<string>();

    // Get org's default role
    const defaultRole = (org.default_member_role as string) || "agent";

    // 4. Process provider users: add new, reactivate returned
    for (const providerUser of providerUsers) {
      // Try to match by external ID first, then by email
      let existingMember =
        existingByExternalId.get(providerUser.externalId) ||
        existingByEmail.get(providerUser.email);

      if (existingMember) {
        seenMemberIds.add(existingMember.user_id);

        // Build member update payload
        const memberUpdate: Record<string, unknown> = {
          scim_synced_at: new Date().toISOString(),
        };

        // If member was suspended (by directory_sync), reactivate. BACKLOG-4012: not while
        // the brokerage's billing setup is pending; they stay suspended until a later sync.
        if (
          existingMember.license_status === "suspended" &&
          existingMember.provisioned_by === "directory_sync" &&
          joinsBlocked
        ) {
          result.skipped_billing_setup++;
        } else if (
          existingMember.license_status === "suspended" &&
          existingMember.provisioned_by === "directory_sync"
        ) {
          memberUpdate.license_status = "active";

          // Clear suspension on user record
          await supabaseAdmin
            .from("users")
            .update({
              suspended_at: null,
              suspension_reason: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingMember.user_id);

          result.reactivated++;
        }

        // Update groups and resolve role if group sync is enabled
        if (groupSyncEnabled && providerUser.groups.length > 0) {
          memberUpdate.idp_groups = providerUser.groups;

          // Check per-member group_sync_enabled override
          const memberGroupSync = existingMember.group_sync_enabled as boolean | null;
          if (memberGroupSync !== false) {
            const roleResult = resolveRole(providerUser.groups, groupMapping);
            if (roleResult.mappingApplied) {
              const currentRole = existingMember.role as string;
              if (currentRole !== roleResult.role) {
                memberUpdate.role = roleResult.role;
                console.log(
                  `[directory-sync] User ${providerUser.email}: role changed '${currentRole}' -> '${roleResult.role}' via group '${roleResult.matchedGroup}'`,
                );
              }
            }
          }
        }

        // BACKLOG-4027: read the error and the stored row. The last-admin guard keeps a
        // demotion of the brokerage's last active admin in-row (no error), so compare.
        const { data: storedRows, error: memberUpdateError } = await supabaseAdmin
          .from("organization_members")
          .update(memberUpdate)
          .eq("organization_id", orgId)
          .eq("user_id", existingMember.user_id)
          .select("role, license_status");
        if (memberUpdateError) {
          console.error(
            `[directory-sync] Org ${orgId}: could not update ${providerUser.email}: ${memberUpdateError.message}`,
          );
        } else if (memberUpdate.role !== undefined) {
          const stored = (Array.isArray(storedRows) ? storedRows[0] : storedRows) as
            | { role?: string | null }
            | null
            | undefined;
          if (stored && stored.role !== memberUpdate.role) {
            result.skipped_last_admin++;
            lastAdminKept ??= { label: providerUser.email, kind: "demote" };
            console.log(
              `[directory-sync] Org ${orgId}: kept ${providerUser.email} as ${stored.role}: last active admin`,
            );
          }
        }

        // Update external ID / sync timestamp on user record
        await supabaseAdmin
          .from("users")
          .update({
            oauth_id: providerUser.externalId,
            first_name: providerUser.firstName || undefined,
            last_name: providerUser.lastName || undefined,
            display_name: providerUser.displayName || undefined,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingMember.user_id);

        continue;
      }

      // BACKLOG-4012: no one is added while billing setup is pending (checked before any
      // users row is created or updated).
      if (joinsBlocked) {
        result.skipped_billing_setup++;
        continue;
      }

      // New member -- is this an existing Keepr person (by sign-in email)?
      const placement = await placeDirectoryUser(supabaseAdmin, orgId, providerUser.email);
      if (placement.kind === "skip") {
        console.log(
          `[directory-sync] Org ${orgId}: not adding ${providerUser.email}: ${placement.reason}`,
        );
        continue;
      }
      const existingUser = placement.kind === "add" ? { id: placement.userId } : null;

      if (existingUser) {
        // User exists but not in this org -- add membership
        await supabaseAdmin
          .from("users")
          .update({
            oauth_id: providerUser.externalId,
            first_name: providerUser.firstName || undefined,
            last_name: providerUser.lastName || undefined,
            display_name: providerUser.displayName || undefined,
            is_managed: true,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingUser.id);

        // Resolve role from groups if group sync is enabled
        let memberRole = defaultRole;
        if (groupSyncEnabled && providerUser.groups.length > 0) {
          const roleResult = resolveRole(providerUser.groups, groupMapping);
          if (roleResult.mappingApplied) {
            memberRole = roleResult.role;
            console.log(
              `[directory-sync] New member ${providerUser.email}: role resolved to '${memberRole}' via group '${roleResult.matchedGroup}'`,
            );
          }
        }

        const { error: addError } = await supabaseAdmin.from("organization_members").insert({
          organization_id: orgId,
          user_id: existingUser.id,
          role: memberRole,
          license_status: "active",
          provisioned_by: "directory_sync",
          provisioned_at: new Date().toISOString(),
          scim_synced_at: new Date().toISOString(),
          joined_at: new Date().toISOString(),
          idp_groups: providerUser.groups.length > 0 ? providerUser.groups : null,
          group_sync_enabled: groupSyncEnabled,
        });

        // BACKLOG-4012: every insert reads its error; only a written row counts as added.
        if (addError) {
          if (isBillingSetupIncompleteError(addError)) {
            result.skipped_billing_setup++;
          } else {
            console.error(
              `[directory-sync] Org ${orgId}: could not add ${providerUser.email}: ${addError.message}`,
            );
          }
          continue;
        }

        seenMemberIds.add(existingUser.id);
        result.added++;
      } else {
        // Completely new user -- create user record + membership
        const providerName =
          idp.provider_type === "azure_ad" ? "azure" : "google";

        const { data: newUser, error: createError } = await supabaseAdmin
          .from("users")
          .insert({
            email: providerUser.email,
            first_name: providerUser.firstName || null,
            last_name: providerUser.lastName || null,
            display_name: providerUser.displayName || null,
            oauth_provider: providerName,
            oauth_id: providerUser.externalId,
            provisioning_source: "directory_sync",
            is_managed: true,
            status: "active",
            is_active: true,
          })
          .select("id")
          .single();

        if (createError || !newUser) {
          console.error(
            `[directory-sync] Failed to create user ${providerUser.email}: ${createError?.message}`,
          );
          continue;
        }

        // Resolve role from groups if group sync is enabled
        let newMemberRole = defaultRole;
        if (groupSyncEnabled && providerUser.groups.length > 0) {
          const roleResult = resolveRole(providerUser.groups, groupMapping);
          if (roleResult.mappingApplied) {
            newMemberRole = roleResult.role;
            console.log(
              `[directory-sync] New user ${providerUser.email}: role resolved to '${newMemberRole}' via group '${roleResult.matchedGroup}'`,
            );
          }
        }

        const { error: newMemberError } = await supabaseAdmin.from("organization_members").insert({
          organization_id: orgId,
          user_id: newUser.id,
          role: newMemberRole,
          license_status: "active",
          provisioned_by: "directory_sync",
          provisioned_at: new Date().toISOString(),
          scim_synced_at: new Date().toISOString(),
          joined_at: new Date().toISOString(),
          idp_groups: providerUser.groups.length > 0 ? providerUser.groups : null,
          group_sync_enabled: groupSyncEnabled,
        });

        if (newMemberError) {
          if (isBillingSetupIncompleteError(newMemberError)) {
            // Remove the fresh users row so the next sync after setup adds this person cleanly.
            await supabaseAdmin.from("users").delete().eq("id", newUser.id);
            result.skipped_billing_setup++;
          } else {
            console.error(
              `[directory-sync] Org ${orgId}: could not add ${providerUser.email}: ${newMemberError.message}`,
            );
          }
          continue;
        }

        seenMemberIds.add(newUser.id);
        result.added++;
      }
    }

    // 5. Suspend members who were provisioned by directory_sync but are
    //    no longer in the provider directory
    for (const member of existingUsers) {
      if (
        member.provisioned_by === "directory_sync" &&
        member.license_status === "active" &&
        !seenMemberIds.has(member.user_id)
      ) {
        const { data: storedRows, error: suspendError } = await supabaseAdmin
          .from("organization_members")
          .update({
            license_status: "suspended",
            scim_synced_at: new Date().toISOString(),
          })
          .eq("organization_id", orgId)
          .eq("user_id", member.user_id)
          .select("license_status");
        const stored = (Array.isArray(storedRows) ? storedRows[0] : storedRows) as
          | { license_status?: string | null }
          | null
          | undefined;
        if (suspendError) {
          console.error(
            `[directory-sync] Org ${orgId}: could not suspend ${member.email}: ${suspendError.message}`,
          );
          continue;
        }
        // BACKLOG-4027 (founder B): the last active admin was kept; their account stays active.
        if (stored && stored.license_status !== "suspended") {
          result.skipped_last_admin++;
          lastAdminKept = { label: member.email, kind: "deactivate" };
          continue;
        }

        await supabaseAdmin
          .from("users")
          .update({
            suspended_at: new Date().toISOString(),
            suspension_reason: "directory_sync_removed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", member.user_id);

        result.suspended++;
      }
    }

    // 6. Update sync timestamp; the error says who is waiting for billing setup, else clear
    await supabaseAdmin
      .from("organizations")
      .update({
        directory_sync_last_at: new Date().toISOString(),
        directory_sync_error: result.skipped_billing_setup > 0
          ? billingSkipMessage(result.skipped_billing_setup)
          : null,
      })
      .eq("id", orgId);

    if (lastAdminKept) {
      await notifyLastAdminKept(supabaseAdmin, options.notifyDeps ?? defaultLastAdminNotifyDeps(), {
        orgId,
        personLabel: lastAdminKept.label,
        kind: lastAdminKept.kind,
        source: "directory_sync",
      });
    }

    console.log(
      `[directory-sync] Org ${orgId}: added=${result.added}, suspended=${result.suspended}, reactivated=${result.reactivated}, skipped_billing_setup=${result.skipped_billing_setup}, skipped_last_admin=${result.skipped_last_admin}`,
    );
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Unknown sync error";
    result.error = errorMessage;
    console.error(`[directory-sync] Org ${orgId} error: ${errorMessage}`);

    // Record error on the organization
    await supabaseAdmin
      .from("organizations")
      .update({
        directory_sync_error: errorMessage,
      })
      .eq("id", orgId);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Edge Function Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // Only accept POST
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed. Use POST." }),
      {
        status: 405,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    // -----------------------------------------------------------------------
    // Authentication: verify the caller has the service role key.
    // This function is internal -- invoked by cron jobs or admin scripts,
    // not by end users. The service role key acts as a shared secret.
    // -----------------------------------------------------------------------
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid Authorization header" }),
        {
          status: 401,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    const bearerToken = authHeader.substring(7);
    if (bearerToken !== supabaseServiceKey) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        {
          status: 403,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Check for optional org_id query parameter
    const url = new URL(req.url);
    const specificOrgId = url.searchParams.get("org_id");

    // Query organizations with directory sync enabled
    let orgsQuery = supabaseAdmin
      .from("organizations")
      .select("*")
      .eq("directory_sync_enabled", true);

    if (specificOrgId) {
      orgsQuery = orgsQuery.eq("id", specificOrgId);
    }

    const { data: orgs, error: orgsError } = await orgsQuery;

    if (orgsError) {
      return new Response(
        JSON.stringify({ error: `Failed to query organizations: ${orgsError.message}` }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    if (!orgs || orgs.length === 0) {
      return new Response(
        JSON.stringify({
          message: "No organizations with directory sync enabled",
          results: [],
        }),
        {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        },
      );
    }

    // Process each organization sequentially (one at a time for blast radius)
    const results: SyncResult[] = [];

    for (const org of orgs) {
      const orgId = org.id as string;

      // Fetch the IdP config for this org
      const { data: idps, error: idpError } = await supabaseAdmin
        .from("organization_identity_providers")
        .select("*")
        .eq("organization_id", orgId)
        .eq("is_active", true);

      if (idpError || !idps || idps.length === 0) {
        const errorMsg = idpError
          ? `Failed to fetch IdP config: ${idpError.message}`
          : "No active identity provider configured";

        results.push({ orgId, added: 0, suspended: 0, reactivated: 0, skipped_billing_setup: 0, skipped_last_admin: 0, error: errorMsg });

        await supabaseAdmin
          .from("organizations")
          .update({ directory_sync_error: errorMsg })
          .eq("id", orgId);

        continue;
      }

      // Use the first active IdP (organizations typically have one)
      const idp = idps[0] as unknown as IdpConfig;

      // Only sync for supported provider types
      if (
        idp.provider_type !== "azure_ad" &&
        idp.provider_type !== "google_workspace"
      ) {
        const errorMsg = `Unsupported provider type for directory sync: ${idp.provider_type}`;
        results.push({ orgId, added: 0, suspended: 0, reactivated: 0, skipped_billing_setup: 0, skipped_last_admin: 0, error: errorMsg });
        continue;
      }

      // BACKLOG-4012: read once per org; the member trigger is the enforcement.
      const joinsBlocked = await readJoinsBlocked(supabaseAdmin, orgId);
      const result = await syncOrganization(supabaseAdmin, orgId, org, idp, { joinsBlocked });
      results.push(result);
    }

    // Build response summary
    const summary = {
      message: `Directory sync completed for ${results.length} organization(s)`,
      synced_at: new Date().toISOString(),
      results: results.map((r) => ({
        org_id: r.orgId,
        added: r.added,
        suspended: r.suspended,
        reactivated: r.reactivated,
        skipped_billing_setup: r.skipped_billing_setup,
        skipped_last_admin: r.skipped_last_admin,
        error: r.error,
      })),
    };

    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[directory-sync] Fatal error:", err);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  }
});
