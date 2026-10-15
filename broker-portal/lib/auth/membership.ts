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
 * One import, deliberately: `@keepr/shared`.
 * ---------------------------------------------------------------------------
 * `middleware.ts` runs in the Edge runtime. Anything reached from here that
 * pulls `next/headers` (which `@/lib/supabase/server` does) fails the Edge
 * build, and nothing in the local test suite would say so. The only module
 * this file reaches is `@keepr/shared`, whose source files import nothing
 * (BACKLOG-3859). Guarded by __tests__/agentFloor-3080/classify.test.ts.
 */

import type { PortalAccess } from '@keepr/shared';

/**
 * The select string every portal membership read uses.
 *
 * `organizations(*)` — never a column list, for the reason above. Also never
 * `.limit(1)` plus `.single()`: with two rows `.single()` returns an error and
 * the caller reads `data: null`, i.e. "no membership", which is the same silent
 * demotion. The rows come back ordered and this module picks.
 */
export const PORTAL_MEMBERSHIP_SELECT = 'role, organization_id, license_status, organizations(*)';

// BACKLOG-3859: the classifier and its pieces moved, verbatim, to
// packages/shared/src/billing/planRule.ts, so the admin portal reads the same
// rule. Re-exported here so every importer of this file is unchanged.
export {
  PORTAL_GRANTING_LICENSE_STATUSES,
  memberStatusGrantsAccess,
  isPersonalMembership,
  pickBrokerageMembership,
  FULL_PORTAL_ROLES,
  classifyPortalAccess,
} from '@keepr/shared';
export type { EmbeddedOrganization, PortalMembershipRow, PortalAccess } from '@keepr/shared';

/** The dashboard paths the floor opens. Each also opens its sub-paths. */
export const FLOOR_PATHS = ['/dashboard', '/dashboard/account', '/dashboard/support'] as const;

/**
 * Paths that carry their own server gate and are NOT decided here.
 *
 * Checklists are refused to every non-editor by lib/checklist-access.ts; that
 * gate, not this list, decides who may open them.
 */
export const OWN_GATE_PATHS = ['/dashboard/checklists'] as const;

/**
 * My Transactions (BACKLOG-3080): passed through for a floor user routed on a
 * BROKERAGE row only. The owner of a personal organization never gets it. The
 * plan key is not read here (no feature call at the edge);
 * lib/my-transactions-access.ts decides on the server.
 */
export const MY_TRANSACTIONS_PATHS = ['/dashboard/my-transactions'] as const;

/**
 * Billing (BACKLOG-3844): passed through for the OWNER of a personal
 * organization only. A brokerage agent never gets it (their brokerage pays).
 * Full-portal users are admitted above. The flag and the rest of the rule are
 * NOT read here; app/dashboard/billing/page.tsx refuses on its own, and that
 * refusal is the gate.
 */
export const BILLING_PATHS = ['/dashboard/billing'] as const;

/** `path` is `base` itself or a sub-path of it. Never a bare prefix match. */
function isUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/**
 * May this access open this dashboard path?
 *
 * `/dashboard` itself is matched exactly: every dashboard route starts with it,
 * so treating it as a prefix would open everything.
 */
export function mayOpenDashboardPath(access: PortalAccess, pathname: string): boolean {
  if (access.kind === 'full') return true;
  if (access.kind === 'none') return false;

  if (pathname === '/dashboard') return true;
  for (const base of FLOOR_PATHS) {
    if (base !== '/dashboard' && isUnder(pathname, base)) return true;
  }
  // BACKLOG-3917: a deactivated member opens the floor paths only.
  if (access.kind === 'floor' && access.via === 'deactivated') return false;
  for (const base of OWN_GATE_PATHS) {
    if (isUnder(pathname, base)) return true;
  }
  if (access.kind === 'floor' && access.via === 'brokerage') {
    for (const base of MY_TRANSACTIONS_PATHS) {
      if (isUnder(pathname, base)) return true;
    }
  }
  if (access.kind === 'floor' && access.via === 'personal_owner') {
    for (const base of BILLING_PATHS) {
      if (isUnder(pathname, base)) return true;
    }
  }
  return false;
}

// ===========================================================================
// Suspended account — BACKLOG-3878.
// ===========================================================================
//
// Suspended means `licenses.status = 'suspended'` (both suspension paths write
// it; users.status is written by one path only). The licence is read by
// lib/auth/suspension.ts; these two functions only decide WHERE a suspended
// person may go. Middleware calls them.
//
//   - the OWNER of a personal organization: Billing (only while billing is on;
//     the page 404s otherwise), My Account, Support;
//   - everyone else (brokerage member, full or floor, and an unknown access):
//     My Account and Support only. The brokerage's bill is not theirs.

/** Paths every suspended person may open. Each also opens its sub-paths. */
export const SUSPENDED_PATHS = ['/dashboard/account', '/dashboard/support'] as const;

function suspendedSeesBilling(access: PortalAccess, billingOn: boolean): boolean {
  return billingOn && access.kind === 'floor' && access.via === 'personal_owner';
}

/** May a SUSPENDED person with this access open this dashboard path? */
export function maySuspendedOpenPath(access: PortalAccess, pathname: string, billingOn: boolean): boolean {
  for (const base of SUSPENDED_PATHS) {
    if (isUnder(pathname, base)) return true;
  }
  if (suspendedSeesBilling(access, billingOn)) {
    for (const base of BILLING_PATHS) {
      if (isUnder(pathname, base)) return true;
    }
  }
  return false;
}

/**
 * Where a suspended person lands. Always a path {@link maySuspendedOpenPath}
 * admits for the same arguments, so a redirect to it never redirects again.
 */
export function suspendedLanding(access: PortalAccess, billingOn: boolean): string {
  return suspendedSeesBilling(access, billingOn) ? '/dashboard/billing' : '/dashboard/account';
}
