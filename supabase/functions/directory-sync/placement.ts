/**
 * BACKLOG-3998: decide what directory sync does with a directory user who is not yet a
 * member of this organization.
 *
 * The person is found by sign-in email (public.user_id_for_auth_email: the account whose
 * auth.users email matches; a provisioned row not yet signed in by its stored email;
 * NULL when ambiguous). A person already in another brokerage is never added here
 * (already_placed); a person whose only membership is their own personal account is not
 * moved by directory sync (personal_account). Same two rules as the SCIM create handler.
 *
 * BACKLOG-4034: with an idKey (the Entra tenant id + the directory object id), the person is
 * first looked up by the azure identity Supabase Auth stores (public.user_id_for_idp_object_id).
 * A lookup error never falls through to the email match. A hit already in this organization
 * is `member`; with objectIdOnly, no hit is `none` (the caller then runs its own email checks).
 */

export type MatchedBy = "object_id" | "email";

export type Placement =
  | { kind: "new" }
  | { kind: "none" }
  | { kind: "add"; userId: string; matchedBy: MatchedBy }
  | { kind: "member"; userId: string; matchedBy: MatchedBy }
  | {
    kind: "skip";
    userId: string | null;
    reason: "already_placed" | "personal_account" | "lookup_failed";
    matchedBy?: MatchedBy;
  };

/** BACKLOG-4034: the Entra tenant id and the directory object id of the person. */
export interface IdpObjectKey {
  tenantId: string;
  objectId: string;
}

type DbError = { message: string } | null;

// The subset of the supabase-js client this module uses.
export interface PlacementDb {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: DbError }>;
  from(table: string): {
    select(cols: string): {
      eq(col: string, v: unknown): PromiseLike<{ data: unknown; error: DbError }>;
      in(col: string, v: unknown[]): PromiseLike<{ data: unknown; error: DbError }>;
    };
  };
}

export async function placeDirectoryUser(
  db: PlacementDb,
  orgId: string,
  email: string,
  idKey?: IdpObjectKey,
  options: { objectIdOnly?: boolean } = {},
): Promise<Placement> {
  let userId: string | null = null;
  let matchedBy: MatchedBy = "email";
  if (idKey) {
    const { data: byId, error: idError } = await db.rpc("user_id_for_idp_object_id", {
      p_tenant_id: idKey.tenantId,
      p_object_id: idKey.objectId,
    });
    if (idError) return { kind: "skip", userId: null, reason: "lookup_failed" };
    if (typeof byId === "string") {
      userId = byId;
      matchedBy = "object_id";
    } else if (options.objectIdOnly) {
      return { kind: "none" };
    }
  }

  if (userId === null) {
    const { data: found, error: lookupError } = await db.rpc("user_id_for_auth_email", {
      p_email: email,
    });
    if (lookupError) return { kind: "skip", userId: null, reason: "lookup_failed" };
    if (typeof found !== "string") return { kind: "new" };
    userId = found;
  }

  const { data: memberships, error: memberError } = await db
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", userId);
  if (memberError) return { kind: "skip", userId, reason: "lookup_failed", matchedBy };

  const allOrgIds = ((memberships ?? []) as Array<{ organization_id: string }>)
    .map((m) => m.organization_id);
  // BACKLOG-4034: found by object id and already in this organization -> member (an add's
  // membership write would collide). The email path keeps today's behaviour.
  if (matchedBy === "object_id" && allOrgIds.includes(orgId)) {
    return { kind: "member", userId, matchedBy };
  }
  const otherOrgIds = allOrgIds.filter((id) => id !== orgId);
  if (otherOrgIds.length === 0) return { kind: "add", userId, matchedBy };

  const { data: orgs, error: orgError } = await db
    .from("organizations")
    .select("id, personal_owner_user_id")
    .in("id", otherOrgIds);
  const otherOrgs = (orgs ?? []) as Array<{ id: string; personal_owner_user_id: string | null }>;
  if (orgError || otherOrgs.length !== otherOrgIds.length) {
    return { kind: "skip", userId, reason: "lookup_failed", matchedBy };
  }

  if (otherOrgs.some((o) => o.personal_owner_user_id === null)) {
    return { kind: "skip", userId, reason: "already_placed", matchedBy };
  }
  return { kind: "skip", userId, reason: "personal_account", matchedBy };
}
