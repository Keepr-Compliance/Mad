/**
 * BACKLOG-3998: decide what directory sync does with a directory user who is not yet a
 * member of this organization.
 *
 * The person is found by sign-in email (public.user_id_for_auth_email: the account whose
 * auth.users email matches; a provisioned row not yet signed in by its stored email;
 * NULL when ambiguous). A person already in another brokerage is never added here
 * (already_placed); a person whose only membership is their own personal account is not
 * moved by directory sync (personal_account). Same two rules as the SCIM create handler.
 */

export type Placement =
  | { kind: "new" }
  | { kind: "add"; userId: string }
  | {
    kind: "skip";
    userId: string | null;
    reason: "already_placed" | "personal_account" | "lookup_failed";
  };

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
): Promise<Placement> {
  const { data: found, error: lookupError } = await db.rpc("user_id_for_auth_email", {
    p_email: email,
  });
  if (lookupError) return { kind: "skip", userId: null, reason: "lookup_failed" };
  if (typeof found !== "string") return { kind: "new" };
  const userId = found;

  const { data: memberships, error: memberError } = await db
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", userId);
  if (memberError) return { kind: "skip", userId, reason: "lookup_failed" };

  const otherOrgIds = ((memberships ?? []) as Array<{ organization_id: string }>)
    .map((m) => m.organization_id)
    .filter((id) => id !== orgId);
  if (otherOrgIds.length === 0) return { kind: "add", userId };

  const { data: orgs, error: orgError } = await db
    .from("organizations")
    .select("id, personal_owner_user_id")
    .in("id", otherOrgIds);
  const otherOrgs = (orgs ?? []) as Array<{ id: string; personal_owner_user_id: string | null }>;
  if (orgError || otherOrgs.length !== otherOrgIds.length) {
    return { kind: "skip", userId, reason: "lookup_failed" };
  }

  if (otherOrgs.some((o) => o.personal_owner_user_id === null)) {
    return { kind: "skip", userId, reason: "already_placed" };
  }
  return { kind: "skip", userId, reason: "personal_account" };
}
