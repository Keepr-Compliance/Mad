import { SPECIFIC_ROLES, ROLE_DISPLAY_NAMES } from "../constants/contactRoles";

/**
 * Format a role string as a human-readable label.
 *
 * First attempts to look up the role in ROLE_DISPLAY_NAMES.
 * If not found, formats the string by splitting on underscores
 * and title-casing each word.
 *
 * Examples:
 *   "seller_agent" -> "Seller Agent"
 *   "buyer_agent" -> "Buyer Agent"
 *   "inspector" -> "Inspector"
 *
 * @param role - The role string (e.g., "seller_agent", "buyer_agent")
 * @returns Human-readable label (e.g., "Seller Agent", "Buyer Agent")
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
 * Transaction type - represents which side of the deal the user represents
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
 * Logic:
 * - For PURCHASE: User represents buyer, so show seller's agent
 * - For SALE: User represents seller, so show buyer's agent
 * - Always show client role
 * - Professional services roles are not filtered
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

    // For purchase transactions: user is buyer, so show seller + seller's agents
    if (transactionType === "purchase") {
      return (
        roleConfig.role === SPECIFIC_ROLES.SELLER ||
        roleConfig.role === SPECIFIC_ROLES.SELLER_AGENT ||
        roleConfig.role === SPECIFIC_ROLES.LISTING_AGENT
      );
    }

    // For sale transactions: user is seller, so show buyer + buyer's agent
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
 * Flip mapping:
 *   seller_agent <-> buyer_agent
 *   listing_agent -> buyer_agent (one-way; listing_agent is seller-side specific)
 *   seller <-> buyer
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
  const purchaseRoles = new Set([
    SPECIFIC_ROLES.SELLER_AGENT,
    SPECIFIC_ROLES.LISTING_AGENT,
    SPECIFIC_ROLES.SELLER,
  ]);
  const saleRoles = new Set([
    SPECIFIC_ROLES.BUYER_AGENT,
    SPECIFIC_ROLES.BUYER,
  ]);

  // Determine which roles are valid for this transaction type
  const validRoles = transactionType === "purchase" ? purchaseRoles : saleRoles;

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
 *  2. Baseline default (always): `client` — which renders as "Buyer (Client)"
 *     on a purchase and "Seller (Client)" on a sale (see getRoleDisplayName).
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
    if (effective) return effective;
  }
  return SPECIFIC_ROLES.CLIENT;
}

/**
 * Get context message for transaction type
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
 * For CLIENT role:
 * - Purchase: "Buyer (Client)" - agent represents the buyer
 * - Sale: "Seller (Client)" - agent represents the seller
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
      return "Buyer (Client)";
    } else if (transactionType === "sale") {
      return "Seller (Client)";
    }
  }

  // For all other roles, use the standard display name or format the role string
  return ROLE_DISPLAY_NAMES[role] || formatRoleLabel(role);
}
