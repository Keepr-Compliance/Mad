/**
 * THE RULE ABOUT WHO IS ON A TRANSACTION, STATED ONCE (BACKLOG-2680)
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * There are two surfaces that put contacts on a deal, and they answered the
 * same question differently:
 *
 *   "a contact with no role"    wizard: SILENTLY DROPS THEM   (BACKLOG-2680)
 *                               Edit Contacts: refuses the save
 *
 * The wizard was missing the rule the other surface already had. That is the
 * same shape as BACKLOG-2603 (duplicate comparison in one add surface and not
 * the other) and BACKLOG-2664 (the rule in the linker and absent in the
 * backfill's worker twin): the rule lived in the caller rather than in the
 * thing being called.
 *
 * So both callers now import these functions. "The two surfaces agree" is then
 * true by construction rather than asserted twice and left to drift — and the
 * drift is the defect, not the symptom.
 *
 * A second rule — "the deal must have a Client" — was briefly stated here too,
 * for BACKLOG-2681. The founder deleted the requirement on 13 Aug
 * (BACKLOG-2683); see the note further down where it used to live.
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
 * THERE IS DELIBERATELY NO CLIENT RULE IN THIS FILE (BACKLOG-2683).
 *
 * `hasClientAssigned` and `LAST_CLIENT_REMOVED_MESSAGE` lived here until the
 * founder's 13 Aug decision dropped the "at least one Client" requirement
 * outright: *"lets just drop this requirement i don't think it's necessary."*
 * A deal may now be saved with nobody holding the Client role, on either
 * surface, so neither the wizard gate nor the Edit Contacts message survives.
 *
 * Do not reintroduce one without a founder decision reversing that. The
 * consequence was stated and accepted when it was made: an exported audit
 * package may not name which side the agent represented. If that later matters,
 * the place to solve it is the export, not a save-time wall.
 */
