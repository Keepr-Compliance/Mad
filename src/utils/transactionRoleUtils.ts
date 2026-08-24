import { SPECIFIC_ROLES, ROLE_DISPLAY_NAMES } from "../constants/contactRoles";

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
 * Context message for transaction type
 */
export interface TransactionTypeContext {
  title: string;
  message: string;
}

/**
 * Validation result for role assignments
 */
export interface RoleValidationResult {
  isValid: boolean;
  missingRoles: string[];
}

/**
 * Get filtered roles based on transaction type
 *
 * Logic AS IMPLEMENTED (deliberately unchanged — see the warning below):
 * - For PURCHASE: offers seller + seller's agents
 * - For SALE: offers buyer + buyer's agent
 * - Always show client role
 * - Professional services roles are not filtered
 *
 * !! PRE-2850 PREMISE — KNOWN INVERTED, DELIBERATELY NOT FIXED HERE !!
 *
 * The scoping above encodes the old premise that `purchase` is a buy-side
 * deal. Under the corrected premise (see TransactionType) `purchase` is a
 * Listing, where the user represents the SELLER — so the counterparty roles
 * offered here are on the wrong side of the deal.
 *
 * It is NOT flipped as part of the BACKLOG-2850 label fix, for two reasons:
 *  1. Flipping it drops `seller`/`seller_agent` from the picker on a Listing.
 *     That is precisely the same-side-counterparty re-scoping specified in
 *     BACKLOG-2859, which also adds Co-Agent.
 *  2. Transactions already in the field carry contacts assigned to those
 *     roles. Re-scoping without deciding what becomes of them is a silent
 *     write loss. BACKLOG-2859 owns that decision.
 *
 * @param roles - Array of role configurations
 * @param transactionType - 'purchase' or 'sale'
 * @param stepTitle - Title of the workflow step
 * @returns Filtered array of role configurations
 */
export function filterRolesByTransactionType(
  roles: RoleConfig[],
  transactionType: TransactionType,
  stepTitle: string,
): RoleConfig[] {
  // Only filter roles for Client & Agents step
  if (stepTitle !== "Client & Agents") {
    return roles; // Professional services - no filtering
  }

  return roles.filter((roleConfig) => {
    // Always show client
    if (roleConfig.role === SPECIFIC_ROLES.CLIENT) {
      return true;
    }

    // Pre-2850 premise (see the warning above): offers the seller side on a
    // purchase. Left as-is; re-scoping is BACKLOG-2859.
    if (transactionType === "purchase") {
      return (
        roleConfig.role === SPECIFIC_ROLES.SELLER ||
        roleConfig.role === SPECIFIC_ROLES.SELLER_AGENT ||
        roleConfig.role === SPECIFIC_ROLES.LISTING_AGENT
      );
    }

    // Pre-2850 premise (see the warning above): offers the buyer side on a
    // sale. Left as-is; re-scoping is BACKLOG-2859.
    if (transactionType === "sale") {
      return (
        roleConfig.role === SPECIFIC_ROLES.BUYER ||
        roleConfig.role === SPECIFIC_ROLES.BUYER_AGENT
      );
    }

    return false;
  });
}

/**
 * Flip a contact's default_role to the equivalent role for the given transaction type.
 *
 * When a contact's default_role isn't valid for the current transaction type,
 * this function returns the equivalent role on the other side.
 *
 * Valid "other side" sets — CORRECTED IN BACKLOG-2850, they were inverted:
 *   `purchase` (displays as "Listing"; the user is the listing agent)
 *        -> buyer, buyer's agent
 *   `sale` (the user is the buyer's agent)
 *        -> seller, seller's agent
 *
 * Symmetric by design: the principal and their agent on each side.
 *
 * The sale set accepts BOTH `seller_agent` and `listing_agent` because those
 * are TWO STORED VALUES FOR ONE ROLE — both render "Listing Agent"
 * (BACKLOG-2804). A contact saved as `listing_agent` is already on the correct
 * side of a Sale and must NOT be flipped. Consolidating the two enum values
 * needs a data migration and is filed separately; do not do it here.
 *
 * Flip mapping (side-agnostic — it maps a role to its counterpart, so the 2850
 * correction did not touch it):
 *   seller_agent <-> buyer_agent
 *   listing_agent -> buyer_agent (ONE-WAY — see below)
 *   seller <-> buyer
 *
 * !! KNOWN ONE-WAY DOOR — reported, deliberately NOT fixed here !!
 * `listing_agent` flips to `buyer_agent`, which flips back to `seller_agent` —
 * a DIFFERENT stored value than it started as. This is unavoidable while two
 * enum values share one role: the flip map is a function, so `buyer_agent` can
 * have only one counterpart. It is invisible today (both render "Listing
 * Agent"), but it means a contact's stored role can mutate simply by being
 * assigned across two deals. Closing it needs the enum consolidation and its
 * migration, not a change here. Pinned by a round-trip test so it cannot widen
 * unnoticed.
 *
 * `other` is deliberately NOT special-cased, and the ternary below is written
 * `=== "sale"` rather than `=== "purchase"` precisely so `other` keeps the
 * exact set it had BEFORE the 2850 correction. `other` names no side, so any
 * answer is arbitrary; holding it byte-identical means this fix moved only the
 * two cases it was meant to move. Pinned by test.
 *
 * @param defaultRole - The contact's default_role
 * @param transactionType - The current transaction type ('purchase' | 'sale' | 'other')
 * @returns The flipped role string if a valid flip exists, or null if no flip is possible
 */
export function flipRoleForTransactionType(
  defaultRole: string,
  transactionType: TransactionType,
): string | null {
  // Build the set of valid other-side roles for this transaction type
  // On a purchase (a Listing) the user is the listing agent, so the other side
  // is the BUYER side. BACKLOG-2850: these two sets were the wrong way round.
  const purchaseRoles = new Set([
    SPECIFIC_ROLES.BUYER_AGENT,
    SPECIFIC_ROLES.BUYER,
  ]);
  const saleRoles = new Set([
    SPECIFIC_ROLES.SELLER_AGENT,
    // Same role as SELLER_AGENT, different stored value. Present so a contact
    // saved as `listing_agent` is NOT flipped off the correct side of a Sale.
    SPECIFIC_ROLES.LISTING_AGENT,
    SPECIFIC_ROLES.SELLER,
  ]);

  // Determine which roles are valid for this transaction type.
  // `=== "sale"`, NOT `=== "purchase"`: this is what holds `other` on exactly
  // the set it had before the 2850 correction. See the note above.
  const validRoles = transactionType === "sale" ? saleRoles : purchaseRoles;

  // If already valid, return as-is
  if (validRoles.has(defaultRole)) {
    return defaultRole;
  }

  // Define the flip map
  const flipMap: Record<string, string> = {
    [SPECIFIC_ROLES.SELLER_AGENT]: SPECIFIC_ROLES.BUYER_AGENT,
    [SPECIFIC_ROLES.BUYER_AGENT]: SPECIFIC_ROLES.SELLER_AGENT,
    [SPECIFIC_ROLES.LISTING_AGENT]: SPECIFIC_ROLES.BUYER_AGENT,
    [SPECIFIC_ROLES.SELLER]: SPECIFIC_ROLES.BUYER,
    [SPECIFIC_ROLES.BUYER]: SPECIFIC_ROLES.SELLER,
  };

  const flipped = flipMap[defaultRole];
  if (!flipped) return null;

  // Only return the flipped role if it's valid for this transaction type
  if (validRoles.has(flipped)) {
    return flipped;
  }

  return null;
}

/**
 * Resolve the role to assign a contact when it is added to a transaction, so a
 * newly added contact is never left with an empty role. (BACKLOG-2358)
 *
 * Precedence:
 *  1. Smart auto-role (only when `autoRoleEnabled`): the contact's saved
 *     `default_role` — used directly if it's a valid option for this
 *     transaction type, otherwise flipped to the equivalent other-side role.
 *     The flip result is then re-checked against `isRoleValid`, and a role the
 *     caller would not offer is discarded in favour of the Client baseline.
 *
 *     THAT RE-CHECK IS LOAD-BEARING TODAY, and is not defensive padding.
 *     BACKLOG-2850 corrected the sides in `flipRoleForTransactionType`, but
 *     BOTH callers build `isRoleValid` from `filterRolesByTransactionType`,
 *     which still carries the pre-2850 premise (re-scoping it is BACKLOG-2859).
 *     The two therefore disagree: on a Listing the flip now correctly yields
 *     `buyer_agent`, while the picker still offers only seller-side roles.
 *     Without the re-check the contact is assigned a role its own dropdown
 *     cannot display — a blank select over a stored value, which is a worse
 *     failure than the wrong-but-visible role it replaced. Returning the
 *     Client baseline instead is at least true and renders the correct side.
 *     When BACKLOG-2859 corrects the filter, this re-check becomes a no-op.
 *  2. Baseline default (always): `client` — which renders as "Seller (Client)"
 *     on a purchase (a Listing) and "Buyer (Client)" on a sale (see
 *     getRoleDisplayName; corrected in BACKLOG-2850).
 *     This baseline applies regardless of the auto-role setting.
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
  transactionType: TransactionType,
  isRoleValid: (role: string) => boolean,
): string {
  if (autoRoleEnabled && defaultRole) {
    const effective = isRoleValid(defaultRole)
      ? defaultRole
      : flipRoleForTransactionType(defaultRole, transactionType);
    // Never hand back a role this caller would not offer — see the note above.
    // (When `effective` came from the `isRoleValid` branch this is trivially
    // true, so the only path it can reject is a flip result.)
    if (effective && isRoleValid(effective)) return effective;
  }
  return SPECIFIC_ROLES.CLIENT;
}

/**
 * Get context message for transaction type
 *
 * !! DEAD CODE, AND ITS COPY IS INVERTED AND STALE !!
 *
 * Measured 2026-08-24: no caller anywhere in src/ or electron/ — the only
 * references are this file's own test and a legacy doc under tests/. The copy
 * below is wrong twice over: it tells the user a purchase means "You're
 * representing the buyer" (the pre-2850 premise), and its title still reads
 * "Transaction Type: Purchase" after BACKLOG-2850 relabelled that enum to
 * "Listing".
 *
 * It is NOT rewritten here on purpose. This label is founder-ruled territory —
 * it has moved twice by explicit ruling (support ticket 112 -> BACKLOG-2805
 * "Listing/Purchase" -> BACKLOG-2850 "Listing") — and authoring replacement
 * copy that nothing renders would be inventing a ruling nobody made. Disposal
 * (delete, or rewrite under the 2859 model) is recommended in BACKLOG-2859.
 *
 * @param transactionType - 'purchase' or 'sale'
 * @returns Object with title and message
 */
export function getTransactionTypeContext(
  transactionType: TransactionType,
): TransactionTypeContext {
  if (transactionType === "purchase") {
    return {
      title: "Transaction Type: Purchase",
      message:
        "You're representing the buyer. Assign the seller's agent you're working with.",
    };
  }

  return {
    title: "Transaction Type: Sale",
    message:
      "You're representing the seller. Assign the buyer's agent you're working with.",
  };
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
 * Get role display name based on transaction type
 *
 * For CLIENT role (BACKLOG-2850 — these two were inverted and are now correct):
 * - Purchase (displayed "Listing"): "Seller (Client)". The user is the listing
 *   agent, so the user's client is the seller.
 * - Sale: "Buyer (Client)". The user is the buyer's agent, so the user's
 *   client is the buyer.
 * - Other: no side, so it falls through to the static "Client (Buyer/Seller)".
 *
 * Do not "simplify" this by reading `purchase` as buy-side — that reading is
 * what produced the inverted labels the founder reported on screen.
 *
 * @param role - The specific role constant
 * @param transactionType - 'purchase' or 'sale'
 * @returns Display name for the role
 */
export function getRoleDisplayName(
  role: string,
  transactionType: TransactionType,
): string {
  // Special handling for CLIENT role - changes based on transaction type
  if (role === SPECIFIC_ROLES.CLIENT) {
    if (transactionType === "purchase") {
      return "Seller (Client)";
    } else if (transactionType === "sale") {
      return "Buyer (Client)";
    }
  }

  // For all other roles, use the standard display name or format the role string
  return ROLE_DISPLAY_NAMES[role] || formatRoleLabel(role);
}
