/**
 * SCIM 2.0 User Handlers
 *
 * Implements CRUD operations for SCIM User resources:
 *   POST   /scim/v2/Users       - Create user
 *   GET    /scim/v2/Users       - List/filter users
 *   GET    /scim/v2/Users/:id   - Get single user
 *   PATCH  /scim/v2/Users/:id   - Update user
 *   DELETE /scim/v2/Users/:id   - Deactivate user (soft-delete)
 */

import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  AuthResult,
  buildScimUser,
  CORS_HEADERS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parseFilter,
  SCIM_CONTENT_TYPE,
  SCIM_LIST_SCHEMA,
} from "../shared/types.ts";
import { scimError } from "../shared/errors.ts";
import { logScimOperation } from "../shared/auth.ts";
import {
  defaultSeatNotifyDeps,
  isSeatLimitError,
  notifySeatLimitReached,
  SEAT_LIMIT_DETAIL,
  SEAT_LIMIT_ERROR,
  type SeatNotifyDeps,
} from "../shared/seatLimit.ts";
import {
  resolveRole,
  extractGroupRoleMapping,
} from "../../_shared/groupRoleMapper.ts";

// ---------------------------------------------------------------------------
// Helpers: Group Extraction & Role Resolution
// ---------------------------------------------------------------------------

/**
 * Extract group IDs/names from a SCIM User payload.
 *
 * SCIM payloads may include groups via:
 *  - `groups` array with `{ value, display }` entries
 *  - Enterprise extension `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User`
 *
 * Accepts both group UUIDs (value) and display names (display).
 */
function extractGroupsFromScimPayload(
  body: Record<string, unknown>,
): string[] {
  const groups: string[] = [];

  // Direct groups array (SCIM core schema)
  const scimGroups = body.groups as
    | Array<{ value?: string; display?: string }>
    | undefined;

  if (Array.isArray(scimGroups)) {
    for (const g of scimGroups) {
      if (g.value) groups.push(g.value);
      if (g.display && g.display !== g.value) groups.push(g.display);
    }
  }

  // Enterprise extension groups
  const enterprise = body[
    "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"
  ] as Record<string, unknown> | undefined;

  if (enterprise?.groups && Array.isArray(enterprise.groups)) {
    for (const g of enterprise.groups as Array<{
      value?: string;
      display?: string;
    }>) {
      if (g.value && !groups.includes(g.value)) groups.push(g.value);
      if (g.display && g.display !== g.value && !groups.includes(g.display)) {
        groups.push(g.display);
      }
    }
  }

  return groups;
}

/**
 * Fetch the IdP config's attribute_mapping for an organization and resolve
 * the user's role from their groups. If group sync is disabled or no IdP
 * config exists, returns null (caller should use default role).
 */
async function resolveRoleFromGroups(
  supabaseAdmin: SupabaseClient,
  orgId: string,
  userGroups: string[],
  memberGroupSyncEnabled?: boolean,
): Promise<{ role: string; matchedGroup: string | null } | null> {
  // If the per-member group_sync_enabled is explicitly false, skip
  if (memberGroupSyncEnabled === false) {
    return null;
  }

  // Fetch IdP config for this org
  const { data: idp } = await supabaseAdmin
    .from("organization_identity_providers")
    .select("attribute_mapping")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .maybeSingle();

  if (!idp) return null;

  const mapping = extractGroupRoleMapping(
    idp.attribute_mapping as Record<string, unknown> | null,
  );

  // If org-level group sync is disabled, skip
  if (!mapping.group_sync_enabled) return null;

  const result = resolveRole(userGroups, mapping);
  return { role: result.role, matchedGroup: result.matchedGroup };
}

// ---------------------------------------------------------------------------
// Membership writes (BACKLOG-3851 PR-2c)
// ---------------------------------------------------------------------------

type DbError = { code?: string; message?: string } | null;

/** "Given Family", display name, or the email: who the IT-admin email is about. */
function personLabelOf(
  email: string,
  nameObj?: { givenName?: string; familyName?: string },
  displayName?: string | null,
): string {
  const full = [nameObj?.givenName, nameObj?.familyName].filter(Boolean).join(" ").trim();
  return full || (displayName ?? "").trim() || email;
}

/**
 * Add the person to this brokerage: claim their unclaimed invite in it if one exists
 * (case-insensitive email match; a live invite already holds the seat, an expired one
 * takes one), otherwise insert a membership. The seat trigger refuses either write when
 * it would exceed the brokerage's seats (P0001 seat_limit_reached).
 */
async function writeScimMembership(
  supabaseAdmin: SupabaseClient,
  p: {
    orgId: string;
    userId: string;
    email: string;
    role: string;
    roleFromGroups: boolean;
    groups: string[];
  },
): Promise<{ error: DbError; claimedInvite: boolean }> {
  const now = new Date().toISOString();
  const { data: invites, error: inviteError } = await supabaseAdmin
    .from("organization_members")
    .select("id, role, invited_email")
    .eq("organization_id", p.orgId)
    .is("user_id", null)
    .eq("license_status", "pending");
  if (inviteError) return { error: inviteError, claimedInvite: false };

  const invite = ((invites ?? []) as Array<{ id: string; role: string; invited_email: string | null }>)
    .find((m) => (m.invited_email ?? "").trim().toLowerCase() === p.email);

  if (invite) {
    const { data: claimed, error } = await supabaseAdmin
      .from("organization_members")
      .update({
        user_id: p.userId,
        role: p.roleFromGroups ? p.role : invite.role,
        license_status: "active",
        provisioned_by: "scim",
        provisioned_at: now,
        scim_synced_at: now,
        joined_at: now,
        invitation_token: null,
        idp_groups: p.groups.length > 0 ? p.groups : null,
        group_sync_enabled: p.roleFromGroups,
      })
      .eq("id", invite.id)
      .is("user_id", null)
      .select("id");
    if (error) return { error, claimedInvite: true };
    if (!Array.isArray(claimed) || claimed.length !== 1) {
      return { error: { message: "invite was claimed concurrently" }, claimedInvite: true };
    }
    return { error: null, claimedInvite: true };
  }

  const { error } = await supabaseAdmin.from("organization_members").insert({
    organization_id: p.orgId,
    user_id: p.userId,
    role: p.role,
    license_status: "active",
    provisioned_by: "scim",
    provisioned_at: now,
    scim_synced_at: now,
    joined_at: now,
    idp_groups: p.groups.length > 0 ? p.groups : null,
    group_sync_enabled: p.roleFromGroups,
  });
  return { error, claimedInvite: false };
}

/** 403 for a seat refusal: email the IT admins (de-duped), then log, then answer. */
async function refuseForSeats(
  supabaseAdmin: SupabaseClient,
  deps: SeatNotifyDeps,
  auth: AuthResult,
  p: {
    operation: "CREATE" | "UPDATE";
    resourceId?: string;
    externalId?: string;
    body: unknown;
    personLabel: string;
    kind: "add" | "reactivate";
    excludeUserId?: string;
  },
): Promise<Response> {
  await notifySeatLimitReached(supabaseAdmin, deps, {
    orgId: auth.orgId,
    personLabel: p.personLabel,
    kind: p.kind,
    excludeUserId: p.excludeUserId,
  });
  await logScimOperation(supabaseAdmin, {
    organizationId: auth.orgId,
    operation: p.operation,
    resourceType: "User",
    resourceId: p.resourceId,
    externalId: p.externalId,
    requestPayload: p.body,
    responseStatus: 403,
    errorMessage: SEAT_LIMIT_ERROR,
    scimTokenId: auth.tokenId,
  });
  return scimError(403, SEAT_LIMIT_DETAIL);
}

/** The org's default role, overridden by IdP group mapping when it resolves. */
async function resolveCreateRole(
  supabaseAdmin: SupabaseClient,
  orgId: string,
  body: Record<string, unknown>,
  email: string,
): Promise<{ role: string; fromGroups: boolean; groups: string[] }> {
  const { data: org } = await supabaseAdmin
    .from("organizations")
    .select("default_member_role")
    .eq("id", orgId)
    .single();
  let role = org?.default_member_role || "agent";
  const groups = extractGroupsFromScimPayload(body);
  const groupRoleResult = await resolveRoleFromGroups(supabaseAdmin, orgId, groups);
  if (groupRoleResult) {
    role = groupRoleResult.role;
    console.log(
      `[scim] User ${email}: role resolved to '${role}' via group '${groupRoleResult.matchedGroup}'`,
    );
  }
  return { role, fromGroups: groupRoleResult !== null, groups };
}

// ---------------------------------------------------------------------------
// POST /scim/v2/Users -- Create a new user
// ---------------------------------------------------------------------------

/** POST /scim/v2/Users -- Create a new user */
export async function handleCreateUser(
  req: Request,
  auth: AuthResult,
  supabaseAdmin: SupabaseClient,
  baseUrl: string,
  deps: SeatNotifyDeps = defaultSeatNotifyDeps(),
): Promise<Response> {
  if (!auth.permissions.canCreate) {
    return scimError(403, "Token does not have create permission");
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return scimError(400, "Invalid JSON request body");
  }

  const externalId = body.externalId as string | undefined;
  const userName = body.userName as string;
  const nameObj = body.name as
    | { givenName?: string; familyName?: string }
    | undefined;
  const displayName = body.displayName as string | undefined;

  if (!userName) {
    await logScimOperation(supabaseAdmin, {
      organizationId: auth.orgId,
      operation: "CREATE",
      resourceType: "User",
      externalId: externalId,
      requestPayload: body,
      responseStatus: 400,
      errorMessage: "Missing userName",
      scimTokenId: auth.tokenId,
    });
    return scimError(400, "userName is required");
  }

  const email = userName.toLowerCase();
  const personLabel = personLabelOf(email, nameObj, displayName);

  // Check if user already exists by scim_external_id or email
  if (externalId) {
    const { data: existingByExtId } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("scim_external_id", externalId)
      .maybeSingle();

    if (existingByExtId) {
      await logScimOperation(supabaseAdmin, {
        organizationId: auth.orgId,
        operation: "CREATE",
        resourceType: "User",
        resourceId: existingByExtId.id,
        externalId: externalId,
        requestPayload: body,
        responseStatus: 409,
        errorMessage: "User with this externalId already exists",
        scimTokenId: auth.tokenId,
      });
      return scimError(409, "User with this externalId already exists", "uniqueness");
    }
  }

  const { data: existingByEmail } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (existingByEmail) {
    // Check if this user is already a member of this org
    const { data: existingMember } = await supabaseAdmin
      .from("organization_members")
      .select("id")
      .eq("organization_id", auth.orgId)
      .eq("user_id", existingByEmail.id)
      .maybeSingle();

    if (existingMember) {
      await logScimOperation(supabaseAdmin, {
        organizationId: auth.orgId,
        operation: "CREATE",
        resourceType: "User",
        resourceId: existingByEmail.id,
        externalId: externalId,
        requestPayload: body,
        responseStatus: 409,
        errorMessage: "User already exists in this organization",
        scimTokenId: auth.tokenId,
      });
      return scimError(
        409,
        "User already exists in this organization",
        "uniqueness",
      );
    }

    // The person's memberships elsewhere decide whether SCIM may add them here.
    const { data: otherMemberships, error: otherError } = await supabaseAdmin
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", existingByEmail.id);
    const otherOrgIds = ((otherMemberships ?? []) as Array<{ organization_id: string }>)
      .map((m) => m.organization_id)
      .filter((id) => id !== auth.orgId);
    let otherOrgs: Array<{ id: string; personal_owner_user_id: string | null }> = [];
    let otherOrgsError: DbError = null;
    if (!otherError && otherOrgIds.length > 0) {
      const res = await supabaseAdmin
        .from("organizations")
        .select("id, personal_owner_user_id")
        .in("id", otherOrgIds);
      otherOrgs = (res.data ?? []) as typeof otherOrgs;
      otherOrgsError = res.error;
    }
    if (otherError || otherOrgsError || otherOrgs.length !== otherOrgIds.length) {
      await logScimOperation(supabaseAdmin, {
        organizationId: auth.orgId,
        operation: "CREATE",
        resourceType: "User",
        resourceId: existingByEmail.id,
        externalId: externalId,
        requestPayload: body,
        responseStatus: 500,
        errorMessage: "Failed to read the person's memberships",
        scimTokenId: auth.tokenId,
      });
      return scimError(500, "Failed to create user");
    }

    // A person already in another brokerage is never moved (same rule as accepting an
    // invitation, BACKLOG-3684 already_placed).
    if (otherOrgs.some((o) => o.personal_owner_user_id === null)) {
      await logScimOperation(supabaseAdmin, {
        organizationId: auth.orgId,
        operation: "CREATE",
        resourceType: "User",
        resourceId: existingByEmail.id,
        externalId: externalId,
        requestPayload: body,
        responseStatus: 409,
        errorMessage: "already_placed",
        scimTokenId: auth.tokenId,
      });
      return scimError(
        409,
        "already_placed: this person already belongs to another brokerage in Keepr.",
        "uniqueness",
      );
    }

    // Q-F4, answer (b): a person whose only Keepr membership is their own personal
    // account (solo Agent plan) is not moved by SCIM; the brokerage invites them and they
    // accept. Answer (a) would be: remove this branch.
    if (otherOrgs.length > 0) {
      await logScimOperation(supabaseAdmin, {
        organizationId: auth.orgId,
        operation: "CREATE",
        resourceType: "User",
        resourceId: existingByEmail.id,
        externalId: externalId,
        requestPayload: body,
        responseStatus: 409,
        errorMessage: "personal_account",
        scimTokenId: auth.tokenId,
      });
      return scimError(
        409,
        "personal_account: this person has their own Keepr account; this person must accept an invitation from the brokerage.",
        "uniqueness",
      );
    }

    const created = await resolveCreateRole(supabaseAdmin, auth.orgId, body, email);

    // Membership first: a refused write must leave the person's users row untouched.
    const { error: memberError } = await writeScimMembership(supabaseAdmin, {
      orgId: auth.orgId,
      userId: existingByEmail.id,
      email,
      role: created.role,
      roleFromGroups: created.fromGroups,
      groups: created.groups,
    });
    if (memberError) {
      if (isSeatLimitError(memberError)) {
        return refuseForSeats(supabaseAdmin, deps, auth, {
          operation: "CREATE",
          resourceId: existingByEmail.id,
          externalId,
          body,
          personLabel,
          kind: "add",
        });
      }
      await logScimOperation(supabaseAdmin, {
        organizationId: auth.orgId,
        operation: "CREATE",
        resourceType: "User",
        resourceId: existingByEmail.id,
        externalId: externalId,
        requestPayload: body,
        responseStatus: 500,
        errorMessage: memberError.message || "Failed to add membership",
        scimTokenId: auth.tokenId,
      });
      return scimError(500, "Failed to create user");
    }

    const { error: userUpdateError } = await supabaseAdmin
      .from("users")
      .update({
        scim_external_id: externalId || existingByEmail.id,
        provisioning_source: "scim",
        is_managed: true,
        first_name: nameObj?.givenName || undefined,
        last_name: nameObj?.familyName || undefined,
        display_name: displayName || undefined,
        suspended_at: null,
        suspension_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingByEmail.id);
    if (userUpdateError) {
      await logScimOperation(supabaseAdmin, {
        organizationId: auth.orgId,
        operation: "CREATE",
        resourceType: "User",
        resourceId: existingByEmail.id,
        externalId: externalId,
        requestPayload: body,
        responseStatus: 500,
        errorMessage: userUpdateError.message,
        scimTokenId: auth.tokenId,
      });
      return scimError(500, "Failed to create user");
    }

    // Fetch the updated user
    const { data: updatedUser } = await supabaseAdmin
      .from("users")
      .select("*")
      .eq("id", existingByEmail.id)
      .single();

    await logScimOperation(supabaseAdmin, {
      organizationId: auth.orgId,
      operation: "CREATE",
      resourceType: "User",
      resourceId: existingByEmail.id,
      externalId: externalId,
      requestPayload: body,
      responseStatus: 201,
      scimTokenId: auth.tokenId,
    });

    return new Response(
      JSON.stringify(buildScimUser(updatedUser!, baseUrl)),
      {
        status: 201,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": SCIM_CONTENT_TYPE,
          Location: `${baseUrl}/scim/v2/Users/${existingByEmail.id}`,
        },
      },
    );
  }

  // New email: no Keepr account. Provisioning a brand-new person is BACKLOG-3986; today
  // the membership write fails (the seat rule in a full brokerage, otherwise the
  // auth.users key), so the users row created here is removed and the answer is 403 or
  // 500, never 201 over a person with no membership.
  const { data: newUser, error: createError } = await supabaseAdmin
    .from("users")
    .insert({
      email,
      first_name: nameObj?.givenName || null,
      last_name: nameObj?.familyName || null,
      display_name: displayName || null,
      oauth_provider: "azure",
      oauth_id: externalId || email,
      scim_external_id: externalId || null,
      provisioning_source: "scim",
      is_managed: true,
      status: "active",
      is_active: true,
    })
    .select("*")
    .single();

  if (createError || !newUser) {
    await logScimOperation(supabaseAdmin, {
      organizationId: auth.orgId,
      operation: "CREATE",
      resourceType: "User",
      externalId: externalId,
      requestPayload: body,
      responseStatus: 500,
      errorMessage: createError?.message || "Failed to create user",
      scimTokenId: auth.tokenId,
    });
    return scimError(500, "Failed to create user");
  }

  const createdNew = await resolveCreateRole(supabaseAdmin, auth.orgId, body, email);

  const { error: newMemberError } = await writeScimMembership(supabaseAdmin, {
    orgId: auth.orgId,
    userId: newUser.id,
    email,
    role: createdNew.role,
    roleFromGroups: createdNew.fromGroups,
    groups: createdNew.groups,
  });

  if (newMemberError) {
    // Remove the fresh users row first, so Entra's retry is a clean new-email POST again.
    const { error: removeError } = await supabaseAdmin
      .from("users")
      .delete()
      .eq("id", newUser.id);
    if (removeError) {
      console.error(`[scim] could not remove users row ${newUser.id}:`, removeError.message);
    }
    if (isSeatLimitError(newMemberError)) {
      return refuseForSeats(supabaseAdmin, deps, auth, {
        operation: "CREATE",
        externalId,
        body,
        personLabel,
        kind: "add",
      });
    }
    await logScimOperation(supabaseAdmin, {
      organizationId: auth.orgId,
      operation: "CREATE",
      resourceType: "User",
      externalId: externalId,
      requestPayload: body,
      responseStatus: 500,
      errorMessage: newMemberError.message || "Failed to add membership",
      scimTokenId: auth.tokenId,
    });
    return scimError(500, "Failed to create user");
  }

  await logScimOperation(supabaseAdmin, {
    organizationId: auth.orgId,
    operation: "CREATE",
    resourceType: "User",
    resourceId: newUser.id,
    externalId: externalId,
    requestPayload: body,
    responseStatus: 201,
    scimTokenId: auth.tokenId,
  });

  return new Response(JSON.stringify(buildScimUser(newUser, baseUrl)), {
    status: 201,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": SCIM_CONTENT_TYPE,
      Location: `${baseUrl}/scim/v2/Users/${newUser.id}`,
    },
  });
}

// ---------------------------------------------------------------------------
// GET /scim/v2/Users -- List users with optional filtering and pagination
// ---------------------------------------------------------------------------

/** GET /scim/v2/Users -- List users with optional filtering and pagination */
export async function handleListUsers(
  req: Request,
  auth: AuthResult,
  supabaseAdmin: SupabaseClient,
  baseUrl: string,
): Promise<Response> {
  const url = new URL(req.url);
  const filter = url.searchParams.get("filter");
  const startIndexParam = url.searchParams.get("startIndex");
  const countParam = url.searchParams.get("count");

  // SCIM uses 1-based indexing
  const startIndex = Math.max(1, parseInt(startIndexParam || "1", 10));
  const count = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(countParam || String(DEFAULT_PAGE_SIZE), 10)),
  );
  const offset = startIndex - 1;

  // Get org member user IDs
  const { data: members } = await supabaseAdmin
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", auth.orgId)
    .not("user_id", "is", null);

  if (!members || members.length === 0) {
    return new Response(
      JSON.stringify({
        schemas: [SCIM_LIST_SCHEMA],
        totalResults: 0,
        startIndex,
        itemsPerPage: count,
        Resources: [],
      }),
      {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": SCIM_CONTENT_TYPE },
      },
    );
  }

  const userIds = members
    .map((m) => m.user_id)
    .filter((id): id is string => id !== null);

  // Build query
  let query = supabaseAdmin
    .from("users")
    .select("*", { count: "exact" })
    .in("id", userIds);

  // Apply filter if present
  if (filter) {
    const parsed = parseFilter(filter);
    if (parsed) {
      switch (parsed.attribute) {
        case "username":
          query = query.ilike("email", parsed.value);
          break;
        case "externalid":
          query = query.eq("scim_external_id", parsed.value);
          break;
        case "emails.value":
          query = query.ilike("email", parsed.value);
          break;
        default:
          // Unknown filter attribute -- return empty per SCIM spec recommendation
          return new Response(
            JSON.stringify({
              schemas: [SCIM_LIST_SCHEMA],
              totalResults: 0,
              startIndex,
              itemsPerPage: count,
              Resources: [],
            }),
            {
              status: 200,
              headers: {
                ...CORS_HEADERS,
                "Content-Type": SCIM_CONTENT_TYPE,
              },
            },
          );
      }
    }
  }

  // Apply pagination
  query = query.range(offset, offset + count - 1);

  const { data: users, count: totalResults, error } = await query;

  if (error) {
    return scimError(500, "Failed to list users");
  }

  const resources = (users || []).map((u) => buildScimUser(u, baseUrl));

  return new Response(
    JSON.stringify({
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: totalResults || 0,
      startIndex,
      itemsPerPage: count,
      Resources: resources,
    }),
    {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": SCIM_CONTENT_TYPE },
    },
  );
}

// ---------------------------------------------------------------------------
// GET /scim/v2/Users/:id -- Get a single user
// ---------------------------------------------------------------------------

/** GET /scim/v2/Users/:id -- Get a single user */
export async function handleGetUser(
  userId: string,
  auth: AuthResult,
  supabaseAdmin: SupabaseClient,
  baseUrl: string,
): Promise<Response> {
  // Verify the user belongs to this org
  const { data: member } = await supabaseAdmin
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", auth.orgId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!member) {
    return scimError(404, "User not found");
  }

  const { data: user, error } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", userId)
    .single();

  if (error || !user) {
    return scimError(404, "User not found");
  }

  return new Response(JSON.stringify(buildScimUser(user, baseUrl)), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": SCIM_CONTENT_TYPE },
  });
}

// ---------------------------------------------------------------------------
// PATCH /scim/v2/Users/:id -- Update user attributes
// ---------------------------------------------------------------------------

/** PATCH /scim/v2/Users/:id -- Update user attributes */
export async function handlePatchUser(
  req: Request,
  userId: string,
  auth: AuthResult,
  supabaseAdmin: SupabaseClient,
  baseUrl: string,
  deps: SeatNotifyDeps = defaultSeatNotifyDeps(),
): Promise<Response> {
  if (!auth.permissions.canUpdate) {
    return scimError(403, "Token does not have update permission");
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return scimError(400, "Invalid JSON request body");
  }

  // Verify user belongs to this org (include group_sync_enabled + role for audit)
  const { data: member } = await supabaseAdmin
    .from("organization_members")
    .select("user_id, group_sync_enabled, role, license_status")
    .eq("organization_id", auth.orgId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!member) {
    await logScimOperation(supabaseAdmin, {
      organizationId: auth.orgId,
      operation: "UPDATE",
      resourceType: "User",
      resourceId: userId,
      requestPayload: body,
      responseStatus: 404,
      errorMessage: "User not found",
      scimTokenId: auth.tokenId,
    });
    return scimError(404, "User not found");
  }

  // Parse SCIM PatchOp operations
  const operations = body.Operations as Array<{
    op: string;
    path?: string;
    value?: unknown;
  }>;

  if (!operations || !Array.isArray(operations)) {
    return scimError(400, "Missing Operations array in PatchOp request");
  }

  // Build update fields
  const userUpdates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  const memberUpdates: Record<string, unknown> = {
    scim_synced_at: new Date().toISOString(),
  };
  // The last active value in the PatchOp wins; applied after the loop.
  let requestedActive: boolean | undefined;

  for (const op of operations) {
    const opType = op.op?.toLowerCase();
    if (opType !== "replace" && opType !== "add") {
      continue; // Only handle replace and add operations for now
    }

    const path = op.path?.toLowerCase();

    if (path === "active" || (!path && typeof op.value === "object")) {
      // Handle active status
      let activeValue: boolean | undefined;

      if (path === "active") {
        activeValue =
          op.value === true ||
          op.value === "true" ||
          op.value === "True";
      } else if (
        op.value &&
        typeof op.value === "object" &&
        "active" in (op.value as Record<string, unknown>)
      ) {
        const val = (op.value as Record<string, unknown>).active;
        activeValue = val === true || val === "true" || val === "True";
      }

      if (activeValue !== undefined) {
        requestedActive = activeValue;
      }

      // Also handle name fields in the value object
      if (op.value && typeof op.value === "object") {
        const valObj = op.value as Record<string, unknown>;
        if ("name" in valObj && typeof valObj.name === "object") {
          const nameVal = valObj.name as Record<string, string>;
          if (nameVal.givenName !== undefined) {
            userUpdates.first_name = nameVal.givenName;
          }
          if (nameVal.familyName !== undefined) {
            userUpdates.last_name = nameVal.familyName;
          }
        }
        if ("displayName" in valObj) {
          userUpdates.display_name = valObj.displayName;
        }
      }
    }

    if (path === "name.givenname") {
      userUpdates.first_name = op.value as string;
    }
    if (path === "name.familyname") {
      userUpdates.last_name = op.value as string;
    }
    if (path === "displayname") {
      userUpdates.display_name = op.value as string;
    }
    if (path === "username") {
      // Updating userName means changing the email
      const newEmail = (op.value as string)?.toLowerCase();
      if (newEmail) {
        userUpdates.email = newEmail;
      }
    }
    if (path === "externalid") {
      userUpdates.scim_external_id = op.value as string;
    }
  }

  // Extract groups from the PatchOp body and resolve role
  const patchGroups = extractGroupsFromScimPayload(body);
  if (patchGroups.length > 0) {
    memberUpdates.idp_groups = patchGroups;

    // Resolve role from groups (respects per-member group_sync_enabled)
    const patchGroupResult = await resolveRoleFromGroups(
      supabaseAdmin,
      auth.orgId,
      patchGroups,
      member.group_sync_enabled as boolean | undefined,
    );
    if (patchGroupResult) {
      const oldRole = member.role as string;
      if (oldRole !== patchGroupResult.role) {
        memberUpdates.role = patchGroupResult.role;
        console.log(
          `[scim] User ${userId}: role changed '${oldRole}' -> '${patchGroupResult.role}' via group '${patchGroupResult.matchedGroup}'`,
        );
      }
    }
  }

  // active:false deactivates from any status. active:true re-activates ONLY a
  // deactivated (suspended / expired) member; an unassigned or pending member keeps its
  // status (a licence is assigned in Keepr, not by the IdP).
  const currentStatus = (member as { license_status?: string | null }).license_status ?? null;
  const reactivating = requestedActive === true &&
    (currentStatus === "suspended" || currentStatus === "expired");
  if (requestedActive === false) {
    userUpdates.suspended_at = new Date().toISOString();
    userUpdates.suspension_reason = "scim_deprovisioned";
    memberUpdates.license_status = "suspended";
  } else if (requestedActive === true) {
    userUpdates.suspended_at = null;
    userUpdates.suspension_reason = null;
    if (reactivating) memberUpdates.license_status = "active";
  }

  // Membership first (it carries scim_synced_at on every PATCH). A refused re-activation
  // writes nothing, so the person stays deactivated (SCIM active = false) and the PATCH
  // as a whole is not applied.
  const { error: memberError } = await supabaseAdmin
    .from("organization_members")
    .update(memberUpdates)
    .eq("organization_id", auth.orgId)
    .eq("user_id", userId);

  if (memberError) {
    if (isSeatLimitError(memberError)) {
      const { data: who } = await supabaseAdmin
        .from("users")
        .select("email, display_name, first_name, last_name")
        .eq("id", userId)
        .maybeSingle();
      const whoEmail = (who?.email as string | undefined) ?? userId;
      return refuseForSeats(supabaseAdmin, deps, auth, {
        operation: "UPDATE",
        resourceId: userId,
        body,
        personLabel: personLabelOf(
          whoEmail,
          { givenName: who?.first_name ?? undefined, familyName: who?.last_name ?? undefined },
          who?.display_name ?? null,
        ),
        kind: "reactivate",
        excludeUserId: userId,
      });
    }
    await logScimOperation(supabaseAdmin, {
      organizationId: auth.orgId,
      operation: "UPDATE",
      resourceType: "User",
      resourceId: userId,
      requestPayload: body,
      responseStatus: 500,
      errorMessage: memberError.message,
      scimTokenId: auth.tokenId,
    });
    return scimError(500, "Failed to update user");
  }

  // Apply user updates
  const { error: updateError } = await supabaseAdmin
    .from("users")
    .update(userUpdates)
    .eq("id", userId);

  if (updateError) {
    await logScimOperation(supabaseAdmin, {
      organizationId: auth.orgId,
      operation: "UPDATE",
      resourceType: "User",
      resourceId: userId,
      requestPayload: body,
      responseStatus: 500,
      errorMessage: updateError.message,
      scimTokenId: auth.tokenId,
    });
    return scimError(500, "Failed to update user");
  }

  // Fetch updated user
  const { data: updatedUser } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", userId)
    .single();

  await logScimOperation(supabaseAdmin, {
    organizationId: auth.orgId,
    operation: "UPDATE",
    resourceType: "User",
    resourceId: userId,
    requestPayload: body,
    responseStatus: 200,
    scimTokenId: auth.tokenId,
  });

  return new Response(
    JSON.stringify(buildScimUser(updatedUser!, baseUrl)),
    {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": SCIM_CONTENT_TYPE },
    },
  );
}

// ---------------------------------------------------------------------------
// DELETE /scim/v2/Users/:id -- Soft-delete (suspend) user
// ---------------------------------------------------------------------------

/** DELETE /scim/v2/Users/:id -- Soft-delete (suspend) user */
export async function handleDeleteUser(
  userId: string,
  auth: AuthResult,
  supabaseAdmin: SupabaseClient,
): Promise<Response> {
  if (!auth.permissions.canDelete) {
    return scimError(403, "Token does not have delete permission");
  }

  // Verify user belongs to this org
  const { data: member } = await supabaseAdmin
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", auth.orgId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!member) {
    await logScimOperation(supabaseAdmin, {
      organizationId: auth.orgId,
      operation: "DELETE",
      resourceType: "User",
      resourceId: userId,
      responseStatus: 404,
      errorMessage: "User not found",
      scimTokenId: auth.tokenId,
    });
    return scimError(404, "User not found");
  }

  // Soft-delete: suspend the membership, then the user; do NOT hard-delete.
  const { error: memberError } = await supabaseAdmin
    .from("organization_members")
    .update({
      license_status: "suspended",
      scim_synced_at: new Date().toISOString(),
    })
    .eq("organization_id", auth.orgId)
    .eq("user_id", userId);

  const { error: userError } = memberError ? { error: null } : await supabaseAdmin
    .from("users")
    .update({
      suspended_at: new Date().toISOString(),
      suspension_reason: "scim_deleted",
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (memberError || userError) {
    await logScimOperation(supabaseAdmin, {
      organizationId: auth.orgId,
      operation: "DELETE",
      resourceType: "User",
      resourceId: userId,
      responseStatus: 500,
      errorMessage: (memberError ?? userError)?.message,
      scimTokenId: auth.tokenId,
    });
    return scimError(500, "Failed to deactivate user");
  }

  await logScimOperation(supabaseAdmin, {
    organizationId: auth.orgId,
    operation: "DELETE",
    resourceType: "User",
    resourceId: userId,
    responseStatus: 204,
    scimTokenId: auth.tokenId,
  });

  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
