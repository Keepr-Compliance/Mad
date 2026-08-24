/**
 * Contact Role Constants
 * Defines all available contact roles and categories for transaction management
 */

export const ROLE_CATEGORIES = {
  CLIENT: "client",
  AGENT: "agent",
  LENDING: "lending",
  INSPECTION: "inspection",
  TITLE_ESCROW: "title_escrow",
  LEGAL: "legal",
  SUPPORT: "support",
  PROPERTY_MANAGEMENT: "property_management",
  INSURANCE: "insurance",
};

export const SPECIFIC_ROLES = {
  // Client — the party THIS USER represents. Side-neutral by design: it means
  // a relationship, not a role in the deal, so it is correct on every
  // transaction type and only its LABEL moves (BACKLOG-2859).
  CLIENT: "client",

  // The other side's agent. ONE value replacing buyer_agent / seller_agent /
  // listing_agent (BACKLOG-2859). The side is already implied by the deal type,
  // so storing it three ways stored the same fact twice and let the two copies
  // disagree — that is what the deleted flip map existed to paper over.
  AGENT: "agent",

  // The user's colleague on the user's own side. Deliberately NOT dynamic —
  // founder: "same as the other, not dynamic co agent". One label on both types.
  CO_AGENT: "co_agent",

  // Inspection & Appraisal
  APPRAISER: "appraiser",
  INSPECTOR: "inspector",
  SURVEYOR: "surveyor",

  // Title & Escrow
  TITLE_COMPANY: "title_company",
  ESCROW_OFFICER: "escrow_officer",

  // Lending
  MORTGAGE_BROKER: "mortgage_broker",
  LENDER: "lender",

  // Legal
  REAL_ESTATE_ATTORNEY: "real_estate_attorney",

  // Support
  TRANSACTION_COORDINATOR: "transaction_coordinator",

  // Insurance
  INSURANCE_AGENT: "insurance_agent",

  // Property Management
  HOA_MANAGEMENT: "hoa_management",
  CONDO_MANAGEMENT: "condo_management",

  // Other
  OTHER: "other",
};

/**
 * Role values that are NO LONGER OFFERED but may still be sitting in a database
 * (BACKLOG-2859).
 *
 * `buyer_agent` / `seller_agent` / `listing_agent` all collapsed to `agent`, and
 * migration v66 rewrites every stored occurrence. This list is the SINGLE source
 * of that set — the migration, the write-boundary normalizer in
 * `transactionContactDbService` and the display fallback below all read it, so
 * the three cannot drift apart.
 *
 * It is kept AFTER the migration, not deleted with it, for one reason: a row can
 * still arrive at a legacy value from outside the migrated tables — the LLM
 * extraction path proposes roles, and a backup restored from an older install
 * replays old data through a chain that has already run. A value that reaches a
 * screen must still humanize to something a person recognises.
 */
export const LEGACY_AGENT_ROLES = [
  "buyer_agent",
  "seller_agent",
  "listing_agent",
] as const;

/**
 * Principal roles for the OTHER side of the deal, removed entirely
 * (BACKLOG-2859). Founder: "lets remove the Seller / other side, Buyer / other
 * side completely. agents normally don't contact them." An agent communicates
 * through the other agent, not the party that agent represents.
 *
 * Migration v66 DELETES these assignments outright — founder-approved silent
 * drop, recorded on the item after the concern was raised twice and overruled
 * twice. Retained here as named constants so the migration and its tests refer
 * to one definition rather than re-typing string literals.
 */
export const REMOVED_PRINCIPAL_ROLES = ["buyer", "seller"] as const;

export const ROLE_DISPLAY_NAMES = {
  // STATIC FALLBACKS ONLY — these are what a role reads as when there is NO
  // transaction in scope (a contact's saved `default_role` on the contact card).
  //
  // On any surface that belongs to a transaction, `client` and `agent` are
  // TYPE-DEPENDENT and must go through `getRoleDisplayName(role, transactionType)`
  // instead (BACKLOG-2859). Reading either of the two strings below on a
  // transaction screen is the bug, not the fallback.
  [SPECIFIC_ROLES.CLIENT]: "Client (Buyer/Seller)",
  [SPECIFIC_ROLES.AGENT]: "Agent",

  // Co-Agent is the one party role that is NOT type-dependent — founder:
  // "same as the other, not dynamic co agent". One string, both types. It is
  // therefore complete here and has no entry in the type-dependent resolver.
  [SPECIFIC_ROLES.CO_AGENT]: "Co-Agent",

  // LEGACY (see LEGACY_AGENT_ROLES / REMOVED_PRINCIPAL_ROLES). Not offered by
  // any picker; present so a straggler row still humanizes. Without these,
  // `formatRoleLabel` falls through to its generic title-caser and prints
  // "Seller Agent" — the exact string BACKLOG-2804 ruled against.
  buyer: "Buyer",
  seller: "Seller",
  buyer_agent: "Buyer's Agent",
  seller_agent: "Listing Agent",
  listing_agent: "Listing Agent",

  [SPECIFIC_ROLES.APPRAISER]: "Appraiser",
  [SPECIFIC_ROLES.INSPECTOR]: "Inspector",
  [SPECIFIC_ROLES.SURVEYOR]: "Surveyor",
  [SPECIFIC_ROLES.TITLE_COMPANY]: "Title Company",
  [SPECIFIC_ROLES.ESCROW_OFFICER]: "Escrow Officer",
  [SPECIFIC_ROLES.MORTGAGE_BROKER]: "Lender (Mortgage Broker)",
  [SPECIFIC_ROLES.LENDER]: "Lender",
  [SPECIFIC_ROLES.REAL_ESTATE_ATTORNEY]: "Real Estate Attorney",
  [SPECIFIC_ROLES.TRANSACTION_COORDINATOR]: "Transaction Coordinator (TC)",
  [SPECIFIC_ROLES.INSURANCE_AGENT]: "Insurance Agent",
  [SPECIFIC_ROLES.HOA_MANAGEMENT]: "HOA Management",
  [SPECIFIC_ROLES.CONDO_MANAGEMENT]: "Condo Management",
  [SPECIFIC_ROLES.OTHER]: "Other",
};

export const CATEGORY_DISPLAY_NAMES = {
  [ROLE_CATEGORIES.CLIENT]: "Client & Agent",
  [ROLE_CATEGORIES.AGENT]: "Agents",
  [ROLE_CATEGORIES.LENDING]: "Lending",
  [ROLE_CATEGORIES.INSPECTION]: "Inspection & Appraisal",
  [ROLE_CATEGORIES.TITLE_ESCROW]: "Title & Escrow",
  [ROLE_CATEGORIES.LEGAL]: "Legal",
  [ROLE_CATEGORIES.SUPPORT]: "Support Services",
  [ROLE_CATEGORIES.PROPERTY_MANAGEMENT]: "Property Management",
  [ROLE_CATEGORIES.INSURANCE]: "Insurance",
};

// Map specific roles to their categories
export const ROLE_TO_CATEGORY = {
  [SPECIFIC_ROLES.CLIENT]: ROLE_CATEGORIES.CLIENT,
  [SPECIFIC_ROLES.AGENT]: ROLE_CATEGORIES.AGENT,
  [SPECIFIC_ROLES.CO_AGENT]: ROLE_CATEGORIES.AGENT,
  // Legacy values kept mapped so an un-migrated row still lands in a category
  // rather than falling out of every grouping (BACKLOG-2859).
  buyer: ROLE_CATEGORIES.CLIENT,
  seller: ROLE_CATEGORIES.CLIENT,
  buyer_agent: ROLE_CATEGORIES.AGENT,
  seller_agent: ROLE_CATEGORIES.AGENT,
  listing_agent: ROLE_CATEGORIES.AGENT,
  [SPECIFIC_ROLES.APPRAISER]: ROLE_CATEGORIES.INSPECTION,
  [SPECIFIC_ROLES.INSPECTOR]: ROLE_CATEGORIES.INSPECTION,
  [SPECIFIC_ROLES.SURVEYOR]: ROLE_CATEGORIES.INSPECTION,
  [SPECIFIC_ROLES.TITLE_COMPANY]: ROLE_CATEGORIES.TITLE_ESCROW,
  [SPECIFIC_ROLES.ESCROW_OFFICER]: ROLE_CATEGORIES.TITLE_ESCROW,
  [SPECIFIC_ROLES.MORTGAGE_BROKER]: ROLE_CATEGORIES.LENDING,
  [SPECIFIC_ROLES.LENDER]: ROLE_CATEGORIES.LENDING,
  [SPECIFIC_ROLES.REAL_ESTATE_ATTORNEY]: ROLE_CATEGORIES.LEGAL,
  [SPECIFIC_ROLES.TRANSACTION_COORDINATOR]: ROLE_CATEGORIES.SUPPORT,
  [SPECIFIC_ROLES.INSURANCE_AGENT]: ROLE_CATEGORIES.INSURANCE,
  [SPECIFIC_ROLES.HOA_MANAGEMENT]: ROLE_CATEGORIES.PROPERTY_MANAGEMENT,
  [SPECIFIC_ROLES.CONDO_MANAGEMENT]: ROLE_CATEGORIES.PROPERTY_MANAGEMENT,
  [SPECIFIC_ROLES.OTHER]: ROLE_CATEGORIES.SUPPORT,
};

/**
 * Roles organized by step in the wizard — and THE definition of what every
 * picker in the app offers (BACKLOG-2859).
 *
 * The "Client & Agents" step carries exactly THREE party roles, and the same
 * three on every transaction type. That is not an oversight, it is the model:
 *
 *   client    the party the user represents  -> "Seller (Client)" on a Listing,
 *                                               "Buyer (Client)" on a Sale
 *   agent     the OTHER side's agent         -> "Buyer's Agent" on a Listing,
 *                                               "Listing Agent" on a Sale
 *   co_agent  the user's own colleague       -> "Co-Agent" on both
 *
 * WHAT IS DELIBERATELY ABSENT, because this list is the only thing enforcing it:
 *
 *  - THE USER'S OWN ROLE. On a Listing the user IS the listing agent; on a Sale
 *    the user IS the buyer's agent. Neither is a contact, so neither is offered.
 *    The app previously offered "Listing Agent" on a Listing — i.e. the user.
 *  - THE OTHER SIDE'S PRINCIPAL (`buyer` on a Listing, `seller` on a Sale).
 *    Removed by founder ruling: an agent communicates through the other agent,
 *    not the party that agent represents.
 *
 * Because the offered set no longer varies by type, NOTHING filters this list
 * per transaction type — the enum collapse IS the scoping. `buildRoleOptions`
 * in transactionRoleUtils reads it directly and only the LABELS resolve by type.
 * The old `filterRolesByTransactionType` was deleted rather than left as an
 * identity function that reads as though it still scopes something.
 */
export const AUDIT_WORKFLOW_STEPS = [
  {
    title: "Client & Agents",
    description: "Core parties to the transaction",
    roles: [
      { role: SPECIFIC_ROLES.CLIENT, required: true, multiple: true },
      { role: SPECIFIC_ROLES.AGENT, required: false, multiple: true },
      { role: SPECIFIC_ROLES.CO_AGENT, required: false, multiple: true },
    ],
  },
  {
    title: "Professional Services",
    description: "Title, escrow, inspection, and other professionals",
    roles: [
      { role: SPECIFIC_ROLES.TITLE_COMPANY, required: false, multiple: true },
      { role: SPECIFIC_ROLES.ESCROW_OFFICER, required: false, multiple: true },
      { role: SPECIFIC_ROLES.INSPECTOR, required: false, multiple: true },
      { role: SPECIFIC_ROLES.APPRAISER, required: false, multiple: true },
      { role: SPECIFIC_ROLES.SURVEYOR, required: false, multiple: true },
      { role: SPECIFIC_ROLES.MORTGAGE_BROKER, required: false, multiple: true },
      {
        role: SPECIFIC_ROLES.REAL_ESTATE_ATTORNEY,
        required: false,
        multiple: true,
      },
      {
        role: SPECIFIC_ROLES.TRANSACTION_COORDINATOR,
        required: false,
        multiple: true,
      },
      { role: SPECIFIC_ROLES.INSURANCE_AGENT, required: false, multiple: true },
      { role: SPECIFIC_ROLES.HOA_MANAGEMENT, required: false, multiple: true },
      {
        role: SPECIFIC_ROLES.CONDO_MANAGEMENT,
        required: false,
        multiple: true,
      },
      { role: SPECIFIC_ROLES.OTHER, required: false, multiple: true },
    ],
  },
];
