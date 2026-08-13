/**
 * THE RULES ABOUT WHO IS ON A TRANSACTION, STATED ONCE
 * (BACKLOG-2680, BACKLOG-2681)
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * There are two surfaces that put contacts on a deal, and they answered the
 * same two questions differently:
 *
 *   "a contact with no role"    wizard: SILENTLY DROPS THEM   (BACKLOG-2680)
 *                               Edit Contacts: refuses the save
 *
 *   "no Client on the deal"     wizard: refuses the save
 *                               Edit Contacts: SAVES IT       (BACKLOG-2681)
 *
 * Each surface enforced exactly one of the two rules, and each was missing the
 * other one. That is the same shape as BACKLOG-2603 (duplicate comparison in
 * one add surface and not the other) and BACKLOG-2664 (the rule in the linker
 * and absent in the backfill's worker twin): the rule lived in the caller
 * rather than in the thing being called.
 *
 * So both callers now import these functions. "The two surfaces agree" is then
 * true by construction rather than asserted twice and left to drift — and the
 * drift is the defect, not the symptom.
 *
 * ===========================================================================
 * WHERE THE REAL AUTHORITY FOR THE CLIENT RULE LIVES
 * ===========================================================================
 * `hasClientAssigned` here is a RENDERER convenience so the user gets a named
 * reason instead of a raw IPC failure. It is NOT the enforcement.
 *
 * BACKLOG-2681 is explicit that the check belongs in the main process, "where
 * every route passes through, not duplicated in two renderers that will drift
 * (they already have)". The enforcing copy is
 * `electron/utils/transactionClientRule.ts`, reached through
 * `transactions:batchUpdateContacts`, and it refuses the save whether or not a
 * renderer asked first.
 *
 * ===========================================================================
 * WHY THE TWO SHAPES ARE NORMALISED RATHER THAN UNIFIED
 * ===========================================================================
 * The wizard holds `{ [role]: ContactAssignment[] }` (objects carrying notes
 * and an is-primary flag); Edit Contacts holds `{ [role]: string[] }` (ids).
 * Changing either shape would be a refactor of two large components inside a
 * bug fix. `toRoleContactIds` narrows the wizard's shape to the other one at
 * the call site instead — the rules only ever need the ids.
 */

import { SPECIFIC_ROLES } from "../constants/contactRoles";

/** role -> the contact ids holding that role. The shape both surfaces reduce to. */
export type RoleContactIds = Record<string, string[] | undefined>;

/** The wizard's richer shape, narrowed to the ids the rules need. */
export function toRoleContactIds(
  assignments: Record<string, Array<{ contactId: string }> | undefined>,
): RoleContactIds {
  const out: RoleContactIds = {};
  for (const [role, list] of Object.entries(assignments)) {
    if (list) out[role] = list.map((a) => a.contactId);
  }
  return out;
}

/** Every contact id that holds at least one role. */
export function contactIdsWithRoles(assignments: RoleContactIds): Set<string> {
  const held = new Set<string>();
  for (const ids of Object.values(assignments)) {
    for (const id of ids ?? []) held.add(id);
  }
  return held;
}

/**
 * The selected contacts that hold no role at all.
 *
 * BACKLOG-2680: on the wizard these were not merely unvalidated — they were
 * DISCARDED. `useAuditSubmission` builds its payload by iterating the role map,
 * not `selectedContactIds`, so a contact in no role produced no row and the
 * deal saved without them, with nothing said. Blanking a role is a reachable,
 * deliberate action: `ContactRoleRow` renders an empty `<option value="">`.
 */
export function findContactsMissingRoles(
  selectedContactIds: string[],
  assignments: RoleContactIds,
): string[] {
  const held = contactIdsWithRoles(assignments);
  return selectedContactIds.filter((id) => !held.has(id));
}

/**
 * The message, verbatim from the surface that already shipped it
 * (`EditContactsModal`), so adopting the rule on the wizard did not invent a
 * second wording for one rule.
 */
export function missingRolesMessage(count: number): string {
  return `Please assign a role to all contacts (${count} contact${
    count !== 1 ? "s" : ""
  } missing roles)`;
}

/**
 * Does anyone hold the Client role?
 *
 * Deliberately the `client` key alone, matching the wizard's existing gate at
 * `useAuditSteps.ts` exactly. `buyer` and `seller` map to the CLIENT role
 * CATEGORY, but the shipped rule has always asked about the specific role, and
 * widening it here would quietly change what the wizard accepts — a different
 * change from the one BACKLOG-2681 asks for.
 */
export function hasClientAssigned(assignments: RoleContactIds): boolean {
  const client = assignments[SPECIFIC_ROLES.CLIENT];
  return Array.isArray(client) && client.length > 0;
}

/**
 * FOUNDER DECISION, BACKLOG-2677, 12 Aug, on why this rule is real rather than
 * onboarding scaffolding: *"Do not delete that check — it still guards a
 * transaction whose roles were all changed away from Client by hand."*
 *
 * That sentence describes this exact scenario, so BACKLOG-2681's open question
 * ("is the rule real, or is it wizard-only scaffolding?") is already answered
 * on the record, and the answer is that it is real.
 */
export const LAST_CLIENT_REMOVED_MESSAGE =
  "This transaction would be left with no Client. Assign the Client role to someone before saving.";
