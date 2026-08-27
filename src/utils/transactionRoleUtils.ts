import {
  SPECIFIC_ROLES,
  ROLE_DISPLAY_NAMES,
  AUDIT_WORKFLOW_STEPS,
} from "../constants/contactRoles";

/**
 * Format a role string as a human-readable label.
 *
 * First attempts to look up the role in ROLE_DISPLAY_NAMES.
 * If not found, formats the string by splitting on underscores
 * and title-casing each word.
 *
 * Examples:
 *   "seller_agent" -> "Listing Agent"   (BACKLOG-2804: the industry term)
 *   "buyer_agent" -> "Buyer Agent"
 *   "inspector" -> "Inspector"
 *
 * @param role - The role string (e.g., "seller_agent", "buyer_agent")
 * @returns Human-readable label (e.g., "Listing Agent", "Buyer Agent")
 */
export function formatRoleLabel(role: string): string {
  // First check if we have a known display name
  if (role in ROLE_DISPLAY_NAMES) {
    return ROLE_DISPLAY_NAMES[role as keyof typeof ROLE_DISPLAY_NAMES];
  }

  // Fallback: format the role string by splitting on underscores and title-casing
  return role
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Transaction Role Utilities
 * Helper functions for filtering and managing transaction contact roles
 */

/**
 * Role configuration structure from workflow steps
 */
export interface RoleConfig {
  role: string;
  required: boolean;
  multiple: boolean;
}

/**
 * Transaction type — which side of the deal the USER represents.
 *
 * The premise, stated once here because several functions below derive labels
 * and role scoping from it (founder's ruling, BACKLOG-2850):
 *
 *   `purchase` — displayed "Listing". The user is the LISTING agent, so the
 *                user's client is the SELLER.
 *   `sale`     — displayed "Sale". The user is the BUYER's agent, so the
 *                user's client is the BUYER.
 *   `other`    — no side; type-dependent labels fall back to their static form.
 *
 * The stored enum values are deliberately NOT renamed. `purchase`/`sale` are a
 * database column, a Zod enum, e2e selectors and a PDF badge class; only the
 * DISPLAY moved. Reading `purchase` as "buy-side" is the error this comment
 * exists to stop — it produced the inverted client label fixed in BACKLOG-2850.
 */
export type TransactionType = "purchase" | "sale" | "other";

/**
 * Contact assignments mapping roles to assigned contacts
 */
export interface ContactAssignments {
  [role: string]: string[] | undefined;
}

/**
 * Validation result for role assignments
 */
export interface RoleValidationResult {
  isValid: boolean;
  missingRoles: string[];
}

/**
 * A selectable role in a picker: the value that gets STORED, and the label a
 * person reads.
 */
export interface RoleOption {
  value: string;
  label: string;
}

/**
 * Build the role options offered for a transaction — THE one definition, used
 * by every picker in the app (BACKLOG-2859).
 *
 * WHAT REPLACED WHAT. This function replaces `filterRolesByTransactionType`,
 * which was deleted rather than kept. Under the collapsed role model the OFFERED
 * SET IS THE SAME ON EVERY TRANSACTION TYPE — `client`, `agent`, `co_agent` plus
 * the type-independent service providers — so a filter had nothing left to
 * remove and had become a pure identity function. A function named
 * "filterRolesByTransactionType" that filters nothing is worse than no function:
 * the next reader assumes the type scoping lives there and stops looking.
 *
 * The scoping now lives in two places that actually do it:
 *  1. AUDIT_WORKFLOW_STEPS no longer contains the user's own role or the other
 *     side's principal, so no picker can offer them on any type.
 *  2. `getRoleDisplayName` resolves `client` and `agent` by transaction type.
 *
 * Four surfaces called the old helper with four copies of the same fifteen-line
 * loop: ContactAssignmentStep, EditContactsModal (twice), and RoleAssigner. They
 * now share this, so "what does the picker offer" is asserted in one place and
 * each surface only has to prove it uses it.
 *
 * @param transactionType - 'purchase' (a Listing) | 'sale' | 'other'
 * @returns Every offered role, in wizard order, labelled for this type
 */
export function buildRoleOptions(transactionType: TransactionType): RoleOption[] {
  const options: RoleOption[] = [];
  for (const step of AUDIT_WORKFLOW_STEPS) {
    for (const roleConfig of step.roles as RoleConfig[]) {
      options.push({
        value: roleConfig.role,
        label: getRoleDisplayName(roleConfig.role, transactionType),
      });
    }
  }
  return options;
}

/**
 * The set of role VALUES a picker offers for this transaction type.
 *
 * Separate from `buildRoleOptions` because two callers need only the predicate
 * "would this role be offered?" and building labels to answer it invites the
 * mistake of comparing a label to a value.
 */
export function offeredRoleValues(transactionType: TransactionType): Set<string> {
  return new Set(buildRoleOptions(transactionType).map((o) => o.value));
}

/**
 * Resolve the role to assign a contact when it is added to a transaction, so a
 * newly added contact is never left with an empty role. (BACKLOG-2358)
 *
 * Precedence:
 *  1. Smart auto-role (only when `autoRoleEnabled`): the contact's saved
 *     `default_role`, used when it is an option this transaction offers.
 *  2. Baseline (always): `client` — which reads "Seller (Client)" on a Listing
 *     and "Buyer (Client)" on a Sale.
 *
 * WHAT WAS REMOVED HERE, AND WHY IT IS NOT A REGRESSION (BACKLOG-2859).
 * This function used to flip a role to its other-side equivalent via
 * `flipRoleForTransactionType`, then re-check the flip result against
 * `isRoleValid` before trusting it. Both are gone.
 *
 * The flip existed because a role carried a side: a contact saved as
 * `seller_agent` was unusable on a deal that only offered `buyer_agent`, so the
 * role had to be translated. Roles no longer carry a side — there is one `agent`
 * value, offered on every transaction type — so there is nothing to translate.
 *
 * The re-check (added on PR #2374) guarded the window where the flip and the
 * picker disagreed: the flip would return a role the dropdown could not display,
 * producing a blank select over a stored value. That disagreement was between
 * two things that no longer exist. A saved `agent` is valid everywhere, so it
 * can never be unshowable, so the case the guard was written for cannot arise.
 * `isRoleValid` is still consulted ONCE, on the saved role itself — that is the
 * ordinary "is this offered here" question, not the guard.
 *
 * @param autoRoleEnabled - whether the smart default_role override is enabled
 * @param defaultRole - the contact's saved default_role (may be null/empty)
 * @param transactionType - 'purchase' | 'sale' | 'other'
 * @param isRoleValid - predicate: is a role a selectable option for this type?
 * @returns the role to assign (never empty — falls back to `client`)
 */
export function resolveDefaultContactRole(
  autoRoleEnabled: boolean,
  defaultRole: string | null | undefined,
  _transactionType: TransactionType,
  isRoleValid: (role: string) => boolean,
): string {
  if (autoRoleEnabled && defaultRole && isRoleValid(defaultRole)) {
    return defaultRole;
  }
  return SPECIFIC_ROLES.CLIENT;
}

/**
 * Validate required role assignments
 *
 * @param contactAssignments - Object mapping roles to contact assignments
 * @param roles - Array of role configurations
 * @returns Validation result with { isValid, missingRoles }
 */
export function validateRoleAssignments(
  contactAssignments: ContactAssignments,
  roles: RoleConfig[],
): RoleValidationResult {
  const missingRoles = roles
    .filter((roleConfig) => roleConfig.required)
    .filter((roleConfig) => {
      const assignments = contactAssignments[roleConfig.role];
      return !assignments || assignments.length === 0;
    })
    .map((roleConfig) => roleConfig.role);

  return {
    isValid: missingRoles.length === 0,
    missingRoles,
  };
}

/**
 * The label a role reads as ON A TRANSACTION — resolved from the transaction
 * type (BACKLOG-2859).
 *
 * TWO roles are type-dependent, and this function is the ONLY place either one
 * becomes words in the renderer:
 *
 *   `client` — the party the user represents.
 *       purchase (displayed "Listing"): the user is the listing agent, so their
 *                                       client is the SELLER -> "Seller (Client)"
 *       sale:                           the user is the buyer's agent, so their
 *                                       client is the BUYER  -> "Buyer (Client)"
 *
 *   `agent`  — the OTHER side's agent, which is the other side FROM the user.
 *       purchase: the user holds the listing, so the other agent represents the
 *                 buyer                                      -> "Buyer's Agent"
 *       sale:     the user represents the buyer, so the other agent holds the
 *                 listing                                    -> "Listing Agent"
 *
 * "Listing Agent" on a Sale is what PRESERVES the founder's support-ticket-111
 * ruling (BACKLOG-2804) through the enum collapse: the agent representing the
 * seller must read "Listing Agent", and now does so as a label rule instead of
 * a stored value. Do not "simplify" it to "Seller's Agent".
 *
 * `co_agent` is deliberately absent from this function. It is the same string on
 * both types — founder: "same as the other, not dynamic co agent" — so it lives
 * in the static map and falls through below. Adding it here is how it would
 * become dynamic by accident; a test asserts the two types render it equal.
 *
 * `other` names no side, so both type-dependent roles fall through to their
 * static forms rather than guessing a side.
 *
 * DO NOT read `purchase` as "the user is buying". That reading produced the
 * inverted labels the founder reported on screen (BACKLOG-2850). `purchase` is
 * the stored value behind the word "Listing".
 *
 * @param role - The specific role constant
 * @param transactionType - 'purchase' | 'sale' | 'other'
 * @returns Display name for the role
 */
export function getRoleDisplayName(
  role: string,
  transactionType: TransactionType,
): string {
  if (role === SPECIFIC_ROLES.CLIENT) {
    if (transactionType === "purchase") return "Seller (Client)";
    if (transactionType === "sale") return "Buyer (Client)";
  }

  if (role === SPECIFIC_ROLES.AGENT) {
    if (transactionType === "purchase") return "Buyer's Agent";
    if (transactionType === "sale") return "Listing Agent";
  }

  // Everything else — service providers, co_agent, and any legacy value still
  // sitting in a database — is type-independent.
  return ROLE_DISPLAY_NAMES[role] || formatRoleLabel(role);
}
