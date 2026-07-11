/**
 * Contact Filter Model — Source + Role grouped filter config & pure predicate.
 *
 * BACKLOG-1898 Phase 1, T2 (pure logic — NO UI).
 *
 * This module is the single source of truth for the grouped Source and Role
 * filters used by the Clients & Contacts screen. It exposes:
 *   - Grouped filter configs (label -> leaf values) consumable by the
 *     `GroupedMultiSelect` component (T1) and wired up by T3.
 *   - Pure predicates that decide whether a `Contact` matches a selection.
 *   - Default selections matching the legacy behaviour
 *     (all sources except Inferred; Clients-only role; Unassigned OFF).
 *
 * Locked decisions (see BACKLOG-1898 plan §2/§3):
 *   - Role filter matches each contact's `default_role` ONLY (single value,
 *     NO transaction_contacts join).
 *   - Source values are the DISTINCT set that exists AFTER prerequisite
 *     BACKLOG-1900 (manual, contacts_app, outlook, google_contacts, iphone,
 *     android_sync, plus the inferred/message-derived group).
 *   - "Unassigned" role child (NULL `default_role`) is OFF by default.
 *   - "Brokers" has NO backing role value today — see BROKERS note below.
 *
 * The component (GroupedMultiSelect) is generic and stateless; selection is a
 * `Set<string>` of leaf ids owned by the parent. This module therefore keys
 * everything by stable string leaf ids.
 */

import type { Contact } from "../../electron/types/models";

// ============================================================================
// Shared group/leaf config types (mirror GroupedMultiSelect's OptionGroup API)
// ============================================================================

/** A single selectable leaf inside a group (or a standalone top-level toggle). */
export interface FilterLeaf {
  /** Stable id used as the Set<string> selection key. */
  id: string;
  /** Human-readable label shown in the dropdown. */
  label: string;
  /**
   * True when this leaf has no backing data value today and should render as a
   * disabled "no data" option (e.g. Brokers — see §3 note). Runtime data-driven
   * "no rows in current dataset" disabling is a UI concern handled by T3, NOT
   * this flag.
   */
  disabled?: boolean;
  /** Optional hint shown next to a disabled leaf (e.g. "no data"). */
  hint?: string;
}

/** A group of leaves rendered under a tri-state parent header. */
export interface FilterGroup {
  /** Stable group id. */
  id: string;
  /** Group header label. */
  label: string;
  /** Child leaves. Empty for standalone groups. */
  children: FilterLeaf[];
  /**
   * When true this group renders as a single top-level toggle with no
   * parent/child tri-state (e.g. Manual, Contacts App, Unassigned). Its single
   * leaf id equals the group id.
   */
  standalone?: boolean;
}

// ============================================================================
// Source filter model
// ============================================================================

/**
 * Source leaf ids. These are the localStorage/selection keys — keep stable.
 * Values chosen to read clearly; they are NOT necessarily equal to the DB
 * `source` value (a leaf may match several source values).
 */
export const SOURCE_LEAF = {
  MANUAL: "manual",
  CONTACTS_APP: "contacts_app",
  EMAIL_OUTLOOK: "outlook",
  EMAIL_GMAIL: "google_contacts",
  PHONE_IPHONE: "iphone",
  PHONE_ANDROID: "android_sync",
  INFERRED_EMAIL: "inferred_email",
  INFERRED_TEXTS: "inferred_texts",
} as const;

export type SourceLeafId = (typeof SOURCE_LEAF)[keyof typeof SOURCE_LEAF];

/** Source group ids. */
export const SOURCE_GROUP = {
  MANUAL: "grp_manual",
  CONTACTS_APP: "grp_contacts_app",
  EMAIL: "grp_email",
  PHONE: "grp_phone",
  INFERRED: "grp_inferred",
} as const;

/**
 * Grouped Source config (label -> leaves), POST-BACKLOG-1900 distinct values.
 * Order matches the mockup: Manual, Contacts App, Email, Phone, Inferred.
 */
export const SOURCE_GROUPS: FilterGroup[] = [
  { id: SOURCE_GROUP.MANUAL, label: "Manual", standalone: true, children: [{ id: SOURCE_LEAF.MANUAL, label: "Manual" }] },
  {
    id: SOURCE_GROUP.CONTACTS_APP,
    label: "Contacts App",
    standalone: true,
    children: [{ id: SOURCE_LEAF.CONTACTS_APP, label: "Contacts App" }],
  },
  {
    id: SOURCE_GROUP.EMAIL,
    label: "Email",
    children: [
      { id: SOURCE_LEAF.EMAIL_OUTLOOK, label: "Outlook" },
      { id: SOURCE_LEAF.EMAIL_GMAIL, label: "Gmail" },
    ],
  },
  {
    id: SOURCE_GROUP.PHONE,
    label: "Phone",
    children: [
      { id: SOURCE_LEAF.PHONE_IPHONE, label: "iPhone" },
      { id: SOURCE_LEAF.PHONE_ANDROID, label: "Android" },
    ],
  },
  {
    id: SOURCE_GROUP.INFERRED,
    label: "Inferred",
    children: [
      { id: SOURCE_LEAF.INFERRED_EMAIL, label: "From Email" },
      { id: SOURCE_LEAF.INFERRED_TEXTS, label: "From Texts" },
    ],
  },
];

/** Text `source` values treated as message-derived text channels. */
const TEXT_SOURCES: ReadonlySet<string> = new Set(["sms", "messages"]);
/** Email-channel `source` values (also the Inferred>From Email backing). */
const EMAIL_SOURCES: ReadonlySet<string> = new Set(["email", "inferred"]);

/**
 * Normalize the `is_message_derived` field, which may be a number (0/1),
 * a boolean, or undefined depending on the read path.
 */
export function isMessageDerived(contact: Pick<Contact, "is_message_derived">): boolean {
  const v = contact.is_message_derived;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return false;
}

/**
 * Per-leaf source predicate. A contact matches a source leaf when this returns
 * true. The Inferred leaves require `is_message_derived` to be truthy; the
 * non-inferred Email/Phone/Manual/Contacts-App leaves match the raw `source`
 * and (for Email/Phone) must NOT be message-derived so an inferred contact does
 * not double-count under a provider child.
 */
function matchesSourceLeaf(leafId: string, contact: Pick<Contact, "source" | "is_message_derived">): boolean {
  const source = contact.source as string | undefined;
  const derived = isMessageDerived(contact);

  switch (leafId) {
    case SOURCE_LEAF.MANUAL:
      return source === "manual";
    case SOURCE_LEAF.CONTACTS_APP:
      return source === "contacts_app";
    case SOURCE_LEAF.EMAIL_OUTLOOK:
      return source === "outlook";
    case SOURCE_LEAF.EMAIL_GMAIL:
      return source === "google_contacts";
    case SOURCE_LEAF.PHONE_IPHONE:
      return source === "iphone";
    case SOURCE_LEAF.PHONE_ANDROID:
      return source === "android_sync";
    case SOURCE_LEAF.INFERRED_EMAIL:
      return derived && source !== undefined && EMAIL_SOURCES.has(source);
    case SOURCE_LEAF.INFERRED_TEXTS:
      return derived && source !== undefined && TEXT_SOURCES.has(source);
    default:
      return false;
  }
}

/**
 * All source leaf ids in canonical order. Useful for "select all" and defaults.
 */
export const ALL_SOURCE_LEAF_IDS: SourceLeafId[] = SOURCE_GROUPS.flatMap((g) =>
  g.children.map((c) => c.id as SourceLeafId),
);

/** Inferred group leaf ids (OFF by default). */
export const INFERRED_SOURCE_LEAF_IDS: SourceLeafId[] = [SOURCE_LEAF.INFERRED_EMAIL, SOURCE_LEAF.INFERRED_TEXTS];

/**
 * Default source selection: every source leaf ON EXCEPT the entire Inferred
 * group (matches legacy `DEFAULT_CATEGORY_FILTER.messageDerived = false`).
 */
export function defaultSourceSelection(): Set<string> {
  const inferred = new Set<string>(INFERRED_SOURCE_LEAF_IDS);
  return new Set(ALL_SOURCE_LEAF_IDS.filter((id) => !inferred.has(id)));
}

/** Convenience constant of the default source selection. */
export const DEFAULT_SOURCE_SELECTION: ReadonlySet<string> = defaultSourceSelection();

// ============================================================================
// Role filter model
// ============================================================================

/**
 * Role leaf ids (selection keys). Distinct from `default_role` values because a
 * single leaf ("Buyers", "Agents", ...) maps to several `default_role` values.
 */
export const ROLE_LEAF = {
  // Clients group (default ON)
  BUYERS: "buyers",
  SELLERS: "sellers",
  // Colleagues group
  AGENTS: "agents",
  BROKERS: "brokers",
  TRANSACTION_COORDINATORS: "transaction_coordinators",
  // Vendors group
  INSPECTORS: "inspectors",
  LOAN_OFFICERS: "loan_officers",
  LAWYERS: "lawyers",
  OTHER: "other",
  // Standalone (default OFF)
  UNASSIGNED: "unassigned",
} as const;

export type RoleLeafId = (typeof ROLE_LEAF)[keyof typeof ROLE_LEAF];

/** Role group ids. */
export const ROLE_GROUP = {
  CLIENTS: "grp_clients",
  COLLEAGUES: "grp_colleagues",
  VENDORS: "grp_vendors",
  UNASSIGNED: "grp_unassigned",
} as const;

/**
 * Map each role leaf id to the set of `default_role` values it matches.
 *
 * NOTE — "Brokers": there is NO distinct broker role in `SPECIFIC_ROLES` today
 * (see BACKLOG-1898 plan §3). The leaf is therefore rendered greyed/"no data"
 * (`disabled: true` in ROLE_GROUPS) and maps to an EMPTY value set — it can
 * never match a contact until a broker role is introduced. This is the only
 * remaining greyed label in Phase 1. When a broker role is added, populate this
 * set and drop the `disabled` flag on the leaf.
 */
export const ROLE_LEAF_TO_DEFAULT_ROLES: Record<string, readonly string[]> = {
  // Clients — `client` is the legacy combined "Buyer/Seller" role, folded under Buyers.
  [ROLE_LEAF.BUYERS]: ["buyer", "client"],
  [ROLE_LEAF.SELLERS]: ["seller"],
  // Colleagues
  [ROLE_LEAF.AGENTS]: ["buyer_agent", "seller_agent", "listing_agent"],
  [ROLE_LEAF.BROKERS]: [], // no backing role value — greyed "no data"
  [ROLE_LEAF.TRANSACTION_COORDINATORS]: ["transaction_coordinator"],
  // Vendors
  [ROLE_LEAF.INSPECTORS]: ["inspector", "appraiser", "surveyor"],
  [ROLE_LEAF.LOAN_OFFICERS]: ["mortgage_broker", "lender"],
  [ROLE_LEAF.LAWYERS]: ["real_estate_attorney"],
  [ROLE_LEAF.OTHER]: [
    "other",
    "title_company",
    "escrow_officer",
    "insurance_agent",
    "hoa_management",
    "condo_management",
  ],
  // Unassigned is a NULL predicate, not a value set — intentionally absent here.
};

/**
 * Grouped Role config (label -> leaves). Order matches the mockup:
 * Clients, Colleagues, Vendors, Unassigned.
 */
export const ROLE_GROUPS: FilterGroup[] = [
  {
    id: ROLE_GROUP.CLIENTS,
    label: "Clients",
    children: [
      { id: ROLE_LEAF.BUYERS, label: "Buyers" },
      { id: ROLE_LEAF.SELLERS, label: "Sellers" },
    ],
  },
  {
    id: ROLE_GROUP.COLLEAGUES,
    label: "Colleagues",
    children: [
      { id: ROLE_LEAF.AGENTS, label: "Agents" },
      { id: ROLE_LEAF.BROKERS, label: "Brokers", disabled: true, hint: "no data" },
      { id: ROLE_LEAF.TRANSACTION_COORDINATORS, label: "Transaction Coordinators" },
    ],
  },
  {
    id: ROLE_GROUP.VENDORS,
    label: "Vendors",
    children: [
      { id: ROLE_LEAF.INSPECTORS, label: "Inspectors" },
      { id: ROLE_LEAF.LOAN_OFFICERS, label: "Loan Officers" },
      { id: ROLE_LEAF.LAWYERS, label: "Lawyers" },
      { id: ROLE_LEAF.OTHER, label: "Other" },
    ],
  },
  {
    id: ROLE_GROUP.UNASSIGNED,
    label: "Unassigned",
    standalone: true,
    children: [{ id: ROLE_LEAF.UNASSIGNED, label: "Unassigned" }],
  },
];

/**
 * Per-leaf role predicate against `contact.default_role` ONLY.
 * The Unassigned leaf matches when `default_role` is null/undefined/empty.
 */
function matchesRoleLeaf(leafId: string, contact: Pick<Contact, "default_role">): boolean {
  const role = contact.default_role;
  if (leafId === ROLE_LEAF.UNASSIGNED) {
    return role === null || role === undefined || role === "";
  }
  const values = ROLE_LEAF_TO_DEFAULT_ROLES[leafId];
  if (!values || values.length === 0) return false; // e.g. Brokers
  return role !== null && role !== undefined && values.includes(role);
}

/** All role leaf ids in canonical order. */
export const ALL_ROLE_LEAF_IDS: RoleLeafId[] = ROLE_GROUPS.flatMap((g) =>
  g.children.map((c) => c.id as RoleLeafId),
);

/** Default role leaves that are ON: the Clients group only (Buyers + Sellers). */
export const DEFAULT_ROLE_LEAF_IDS: RoleLeafId[] = [ROLE_LEAF.BUYERS, ROLE_LEAF.SELLERS];

/**
 * Default role selection: Clients group only (Buyers + Sellers, i.e. buyer /
 * seller / client). Colleagues, Vendors and Unassigned are OFF.
 */
export function defaultRoleSelection(): Set<string> {
  return new Set<string>(DEFAULT_ROLE_LEAF_IDS);
}

/** Convenience constant of the default role selection. */
export const DEFAULT_ROLE_SELECTION: ReadonlySet<string> = defaultRoleSelection();

// ============================================================================
// Combined filter state + top-level predicate
// ============================================================================

/**
 * The full contact filter selection. Both dimensions are sets of leaf ids.
 * Owned by the parent (ContactSearchList) and persisted to localStorage there.
 */
export interface ContactFilters {
  /** Selected Source leaf ids. */
  sources: Set<string>;
  /** Selected Role leaf ids. */
  roles: Set<string>;
}

/** The default filter selection (Clients-only role; all sources except Inferred). */
export function defaultContactFilters(): ContactFilters {
  return { sources: defaultSourceSelection(), roles: defaultRoleSelection() };
}

/**
 * True when the contact matches ANY selected source leaf. An empty source
 * selection matches nothing (the UI should never persist an empty set for a
 * required dimension, but the predicate is honest about it).
 */
export function matchesSourceFilter(
  contact: Pick<Contact, "source" | "is_message_derived">,
  selected: Set<string>,
): boolean {
  if (selected.size === 0) return false;
  for (const leafId of selected) {
    if (matchesSourceLeaf(leafId, contact)) return true;
  }
  return false;
}

/**
 * True when the contact matches ANY selected role leaf (including the
 * Unassigned NULL predicate). An empty role selection matches nothing.
 */
export function matchesRoleFilter(contact: Pick<Contact, "default_role">, selected: Set<string>): boolean {
  if (selected.size === 0) return false;
  for (const leafId of selected) {
    if (matchesRoleLeaf(leafId, contact)) return true;
  }
  return false;
}

/**
 * Pure top-level predicate: a contact passes the filter when it matches the
 * source selection AND the role selection.
 */
export function matchesContactFilters(
  contact: Pick<Contact, "source" | "is_message_derived" | "default_role">,
  filters: ContactFilters,
): boolean {
  return matchesSourceFilter(contact, filters.sources) && matchesRoleFilter(contact, filters.roles);
}
