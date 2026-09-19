/**
 * Which organization membership the portal routes on — BACKLOG-3364.
 *
 * ---------------------------------------------------------------------------
 * A personal organization is not a placement.
 * ---------------------------------------------------------------------------
 * A solo user now holds an `organization_members` row in an organization of
 * their own. Before this, a solo user had no row at all, and all three entry
 * points below read "has a row" as "already placed somewhere":
 *
 *   - middleware bounced any non-portal role to /download;
 *   - the OAuth callback returned /download before it ever looked for a
 *     pending brokerage invite, so a solo user could never accept one;
 *   - the setup callback returned /dashboard before calling the provisioning
 *     RPC, so a solo user could never set up a brokerage.
 *
 * All three must look past the personal row and answer the question they were
 * really asking: does this user belong to a BROKERAGE? That is what
 * `pickBrokerageMembership` returns, and a solo user's answer is `null` —
 * exactly the answer they gave before personal organizations existed.
 *
 * ---------------------------------------------------------------------------
 * Why the column is never named in the query.
 * ---------------------------------------------------------------------------
 * `organizations.personal_owner_user_id` arrives in its own migration, applied
 * to production on its own schedule. A deployed portal that NAMES the column in
 * a select, order or filter gets HTTP 400 / PostgREST code 42703 from a
 * database that does not have it yet — with `data: null` and NO throw. Every
 * reader here would then read `null` as "no membership", and every real
 * brokerage member would silently lose their role: brokers bounced, admins
 * un-admined, invites re-offered. Measured, not assumed: variants A, C and D in
 * supabase/tests/backlog-3364/fixtures/postgrest-pre-migration.json.
 *
 * So the query embeds the WHOLE organization record (`organizations(*)`, case
 * B — 200 on both sides of the migration) and the personal flag is computed
 * here, in code, from a key that is simply absent before the migration. Absent
 * key → not personal → precisely today's behaviour.
 *
 * ---------------------------------------------------------------------------
 * No imports, deliberately.
 * ---------------------------------------------------------------------------
 * `middleware.ts` runs in the Edge runtime. Anything reached from here that
 * pulls `next/headers` (which `@/lib/supabase/server` does) fails the Edge
 * build, and nothing in the local test suite would say so.
 */

/**
 * The select string every portal membership read uses.
 *
 * `organizations(*)` — never a column list, for the reason above. Also never
 * `.limit(1)` plus `.single()`: with two rows `.single()` returns an error and
 * the caller reads `data: null`, i.e. "no membership", which is the same silent
 * demotion. The rows come back ordered and this module picks.
 */
export const PORTAL_MEMBERSHIP_SELECT = 'role, organization_id, organizations(*)';

/** The embedded organization record, of which only one key is read here. */
export interface EmbeddedOrganization {
  /** Present only once BACKLOG-3364's migration has been applied. */
  personal_owner_user_id?: string | null;
}

/**
 * One row of {@link PORTAL_MEMBERSHIP_SELECT}.
 *
 * `role` and `organization_id` are NOT NULL columns, so they are declared
 * required: callers that build a consent URL out of the organization id would
 * otherwise have to widen for a value the database cannot produce. The embed is
 * optional because it is what the pre-migration database omits.
 */
export interface PortalMembershipRow {
  role: string;
  organization_id: string;
  /**
   * Object on the wire; ARRAY in the type.
   *
   * PostgREST returns a single object for this embed — a many-to-one
   * relationship — and that is what the transcribed responses in
   * supabase/tests/backlog-3364/fixtures/ contain. But this portal's Supabase
   * client is built without a generated `Database` type, so supabase-js cannot
   * know the cardinality and infers `any[]` from the select string alone.
   *
   * Both are declared, and `embeddedOrganization` below takes either. Narrowing
   * this to the object alone is what `npm run build` rejects; narrowing it to
   * the array alone would compile and then read `undefined` at runtime, which
   * silently makes every organization non-personal — the exact failure this
   * module exists to prevent, and one no type error would report.
   */
  organizations?: EmbeddedOrganization | EmbeddedOrganization[] | null;
}

/** The embedded record, whichever of the two shapes it arrived in. */
function embeddedOrganization(
  row: PortalMembershipRow | null | undefined
): EmbeddedOrganization | null {
  const embed = row?.organizations;
  if (!embed) return null;
  return Array.isArray(embed) ? (embed[0] ?? null) : embed;
}

/**
 * Is this membership row the user's own personal organization?
 *
 * A null, empty or missing embed reads as NOT personal. That is the
 * pre-migration answer and the safe one: it can only ever leave today's
 * behaviour in place.
 */
export function isPersonalMembership(row: PortalMembershipRow | null | undefined): boolean {
  return !!embeddedOrganization(row)?.personal_owner_user_id;
}

/**
 * The brokerage membership this user should be routed on, or null.
 *
 * Takes the first non-personal row in the order the query returned them, so the
 * caller must order deterministically (`created_at`, then `id` — both base
 * columns of `organization_members`, so neither names the new column). SCIM and
 * directory sync can both write, so "two brokerage rows" is reachable and must
 * not resolve arbitrarily.
 *
 * Anything that is not an array — `null` from an error result included — is no
 * membership. That is what the caller did with an error before this change.
 */
export function pickBrokerageMembership(
  rows: PortalMembershipRow[] | null | undefined
): PortalMembershipRow | null {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (row && !isPersonalMembership(row)) return row;
  }
  return null;
}
