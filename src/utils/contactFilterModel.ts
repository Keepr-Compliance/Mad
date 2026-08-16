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
 *   - Default selections: all sources except Inferred; ALL roles incl.
 *     Unassigned (BACKLOG-2141 — a fresh profile shows every synced contact).
 *
 * Locked decisions (see BACKLOG-1898 plan §2/§3):
 *   - Role filter matches each contact's `default_role` ONLY (single value,
 *     NO transaction_contacts join).
 *   - Source values are the DISTINCT set that exists AFTER prerequisite
 *     BACKLOG-1900 (manual, contacts_app, outlook, google_contacts, iphone,
 *     android_sync, plus the inferred/message-derived group).
 *   - "Unassigned" role child (NULL `default_role`) is ON by default
 *     (BACKLOG-2141; was OFF pre-2141).
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

/** The fields the source predicate reads. */
export type SourceFilterable = Pick<Contact, "source" | "source_types" | "is_message_derived">;

/**
 * Map each ADDRESS-BOOK source leaf to the `contacts.source` values it matches.
 *
 * Explicit, and not `leafId === sourceValue`, even though every pair below
 * happens to be equal today: SOURCE_LEAF's own contract says the ids are chosen
 * to read clearly and are "NOT necessarily equal to the DB `source` value (a leaf
 * may match several source values)". A predicate that compares the id to the
 * value would quietly break the first time someone takes the module at its word
 * — and it would break by returning `false`, i.e. by making contacts vanish from
 * a filter, which is the exact failure BACKLOG-2472 exists to fix.
 *
 * The Inferred leaves are deliberately ABSENT: they are not address books and
 * carry an `is_message_derived` gate that no value list can express. They are
 * handled as their own cases in `matchesSourceLeaf`.
 *
 * Mirrors ROLE_LEAF_TO_DEFAULT_ROLES below.
 */
export const SOURCE_LEAF_TO_CONTACT_SOURCES: Record<string, readonly string[]> = {
  [SOURCE_LEAF.MANUAL]: ["manual"],
  [SOURCE_LEAF.CONTACTS_APP]: ["contacts_app"],
  [SOURCE_LEAF.EMAIL_OUTLOOK]: ["outlook"],
  [SOURCE_LEAF.EMAIL_GMAIL]: ["google_contacts"],
  [SOURCE_LEAF.PHONE_IPHONE]: ["iphone"],
  [SOURCE_LEAF.PHONE_ANDROID]: ["android_sync"],
};

/**
 * A contact's LIVE sources — the set the source filter must answer to
 * (BACKLOG-2472).
 *
 * `source_types` is the set of `contact_source_links` rows still attached to this
 * contact, mapped into this same vocabulary by the electron read path. When it
 * is present it is the whole truth and the `source` scalar is IGNORED, which is
 * the entire fix: `source` is written once at INSERT and no unlink revises it,
 * so a contact whose Outlook link was removed kept `source = 'outlook'` and kept
 * appearing under Outlook while carrying only macOS data.
 *
 * `undefined`/empty means no crosswalk rows were found, and the scalar is used
 * unchanged. That is not a degraded path — it is the CORRECT answer for the two
 * populations that legitimately have no links: manual contacts (there is no
 * `manual` source_type for them to link to) and contacts predating the v57
 * crosswalk. Returning `[]` for them instead would hide them from every leaf.
 *
 * Note the UNION is deliberately not taken. Scalar-plus-links would keep Casey
 * Lane under Outlook forever, which is the bug.
 */
export function liveSourcesOf(contact: SourceFilterable): readonly string[] {
  const links = contact.source_types;
  if (links && links.length > 0) return links;
  return contact.source ? [contact.source as string] : [];
}

/**
 * Per-leaf source predicate. A contact matches a source leaf when this returns
 * true.
 *
 * The address-book leaves (Manual / Contacts App / Outlook / Gmail / iPhone /
 * Android) match when ANY live source matches — a contact in both the Mac
 * address book and Outlook belongs under BOTH, which the pre-2472 scalar could
 * not express.
 *
 * The Inferred leaves are UNCHANGED and read the `source` scalar directly. They
 * are not an address book: a message-derived contact is synthesised from message
 * participants and has no source record to link to, so it has no crosswalk rows
 * by construction and `liveSourcesOf` would return its scalar anyway. Reading
 * the scalar explicitly keeps that independent of the fallback rule above, and
 * keeps the `is_message_derived` gate — which is what stops an inferred contact
 * double-counting under a provider child, and what stops a non-derived contact
 * appearing under Inferred — provably untouched by this change.
 */
function matchesSourceLeaf(leafId: string, contact: SourceFilterable): boolean {
  const source = contact.source as string | undefined;
  const derived = isMessageDerived(contact);

  switch (leafId) {
    case SOURCE_LEAF.INFERRED_EMAIL:
      return derived && source !== undefined && EMAIL_SOURCES.has(source);
    case SOURCE_LEAF.INFERRED_TEXTS:
      return derived && source !== undefined && TEXT_SOURCES.has(source);
    default: {
      const values = SOURCE_LEAF_TO_CONTACT_SOURCES[leafId];
      if (!values) return false; // unknown leaf id
      const live = liveSourcesOf(contact);
      return values.some((value) => live.includes(value));
    }
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
// Source DISPLAY labels (BACKLOG-2483)
// ============================================================================

/**
 * What to call a `contacts.source` value on screen.
 *
 * ===========================================================================
 * WHY THIS LIVES HERE AND NOT AT THE CALL SITE
 * ===========================================================================
 * The import picker used to badge sources with a TWO-WAY ternary over a
 * vocabulary of nine:
 *
 *     {contact.source === "contacts_app" ? "Contacts App" : "Outlook"}
 *
 * So an Android, Google or iPhone record announced itself as Outlook. The data
 * path had already been taught to keep those origins distinct (BACKLOG-1900);
 * only the renderer still flattened them, and it flattened them to a specific
 * provider the record demonstrably did not come from.
 *
 * The fix is not a fourth object literal spelling out source names — BACKLOG-2472
 * and BACKLOG-2473 both exist because one fact was written down twice and the
 * copies drifted. So the labels are DERIVED from `SOURCE_GROUPS`, which is
 * already the one place these words are written, via the same
 * `SOURCE_LEAF_TO_CONTACT_SOURCES` mapping the filter predicate uses. Rename a
 * leaf and the badge follows; add a source to a leaf and the badge follows.
 *
 * The consequence worth stating: a badge and the filter dropdown on the same
 * screen cannot disagree, because they now read the same string. That is why
 * `google_contacts` badges as "Gmail" and not "Google" — "Gmail" is what the
 * filter calls it, and two names for one source is the defect class this is
 * fixing, not a style choice.
 *
 * NOT to be confused with `electron/services/contactLinkEvidence.sourceLabel`,
 * which is keyed on the CROSSWALK vocabulary (`macos`, not `contacts_app`) and
 * returns possessive sentence fragments for prose ("Mac address book",
 * "contacts you added yourself"). Correct there, wrong in a pill badge, and
 * keyed on a vocabulary the picker does not speak.
 */

/**
 * `contacts.source` value -> every filter leaf that claims it.
 *
 * Built by INVERTING `SOURCE_LEAF_TO_CONTACT_SOURCES` rather than by retyping
 * the pairs, so the inverse cannot drift from the forward map.
 *
 * The Inferred leaves are absent from that map by design (see its note — they
 * carry an `is_message_derived` gate no value list can express), so their
 * backing values are folded in here from the same `EMAIL_SOURCES` /
 * `TEXT_SOURCES` sets `matchesSourceLeaf` tests against. Without them a
 * message-derived row badges as "Other" while the filter happily files it under
 * Inferred — the two surfaces disagreeing again, one module apart.
 *
 * A LIST per source, not a single leaf — see
 * `AMBIGUOUSLY_LABELLED_CONTACT_SOURCES` below for why that distinction is
 * load-bearing rather than defensive.
 */
const SOURCE_LEAF_CLAIMS: Record<string, string[]> = (() => {
  const claims: Record<string, string[]> = {};
  const claim = (value: string, leafId: string): void => {
    (claims[value] ??= []).push(leafId);
  };
  for (const [leafId, values] of Object.entries(SOURCE_LEAF_TO_CONTACT_SOURCES)) {
    for (const value of values) claim(value, leafId);
  }
  for (const value of EMAIL_SOURCES) claim(value, SOURCE_LEAF.INFERRED_EMAIL);
  for (const value of TEXT_SOURCES) claim(value, SOURCE_LEAF.INFERRED_TEXTS);
  return claims;
})();

/**
 * Sources claimed by MORE THAN ONE leaf. Expected to be empty, and asserted
 * empty by `contactSourceLabel.test.ts`.
 *
 * ===========================================================================
 * WHY THIS IS EXPORTED RATHER THAN QUIETLY HANDLED
 * ===========================================================================
 * This constant exists because a negative control REFUSED TO GO RED.
 *
 * The first version of the inversion above was a plain overwrite,
 * `bySource[value] = leafId`. Adding `google_contacts` to the Outlook leaf — a
 * realistic drift, and the exact shape of this ticket's bug — SHOULD have
 * produced a Gmail contact badged "Outlook". It did not: `EMAIL_GMAIL` is
 * iterated after `EMAIL_OUTLOOK`, the later write won, and the label silently
 * stayed "Gmail". The test passed for a reason that had nothing to do with the
 * code being correct.
 *
 * That is not a harmless tie-break. `matchesSourceLeaf` uses `.some()`, so a
 * doubly-claimed source appears under BOTH leaves in the filter dropdown while
 * the badge shows whichever leaf happened to be enumerated last. Badge and
 * filter disagree — the one outcome that deriving both from a shared vocabulary
 * is supposed to make impossible.
 *
 * So ambiguity is RECORDED instead of absorbed, and `contactSourceLabel`
 * resolves first-claim-wins so the answer is at least deterministic instead of
 * depending on object key order. A source claimed twice now fails a test rather
 * than picking a winner in silence.
 */
export const AMBIGUOUSLY_LABELLED_CONTACT_SOURCES: readonly string[] = Object.entries(
  SOURCE_LEAF_CLAIMS,
)
  .filter(([, leafIds]) => leafIds.length > 1)
  .map(([source]) => source)
  .sort();

/**
 * Leaf id -> its human label, read straight off `SOURCE_GROUPS`.
 *
 * `SOURCE_GROUPS` is the display vocabulary; this is a lookup INTO it, not a
 * copy OF it.
 */
const SOURCE_LEAF_LABELS: Record<string, string> = Object.fromEntries(
  SOURCE_GROUPS.flatMap((group) => group.children.map((leaf) => [leaf.id, leaf.label])),
);

/**
 * Shown for a source this build has no name for.
 *
 * Deliberately not a provider name. An unrecognised source is a source we
 * cannot identify, and the one thing the badge must never do is answer that
 * question with a confident guess — which is precisely how every non-Mac
 * contact came to claim it was from Outlook.
 */
export const UNKNOWN_CONTACT_SOURCE_LABEL = "Other";

/**
 * The badge text for a `contacts.source` value.
 *
 * Total by construction: any value with no leaf — unknown, NULL, empty, or a
 * source added to the CHECK without a filter leaf — returns "Other" rather than
 * naming a provider the record did not come from.
 *
 * First claim wins when a source is claimed twice. That case is a bug the test
 * suite fails on (`AMBIGUOUSLY_LABELLED_CONTACT_SOURCES`); resolving it in
 * declaration order here just means the symptom is reproducible while it lasts,
 * rather than varying with object key order.
 */
export function contactSourceLabel(source: string | null | undefined): string {
  if (!source) return UNKNOWN_CONTACT_SOURCE_LABEL;
  const leafId = SOURCE_LEAF_CLAIMS[source]?.[0];
  if (!leafId) return UNKNOWN_CONTACT_SOURCE_LABEL;
  return SOURCE_LEAF_LABELS[leafId] ?? UNKNOWN_CONTACT_SOURCE_LABEL;
}

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

/**
 * Default role leaves that are ON: ALL role leaves (Clients + Colleagues +
 * Vendors + Unassigned), incl. the inert disabled `brokers` leaf (BACKLOG-2141).
 *
 * A fresh profile must show EVERY synced contact — freshly-imported contacts
 * carry `default_role = null` (→ the Unassigned leaf), so a Clients-only default
 * silently hid them and broke the "where are my contacts?" trust. Sourced from
 * the canonical `ALL_ROLE_LEAF_IDS` (NOT a hand-listed array) so this default
 * can never drift as roles are added. The inert `brokers` leaf is harmless:
 * `formatRoleSummary` computes "All" over ENABLED leaves only, so including it
 * keeps the stored default identically equal to true select-all.
 *
 * NOTE — the SOURCE default is unchanged (Inferred still OFF); message-derived
 * contacts stay hidden by design. Only the ROLE default widens here.
 */
export const DEFAULT_ROLE_LEAF_IDS: RoleLeafId[] = ALL_ROLE_LEAF_IDS;

/**
 * The ROLE default that shipped BEFORE BACKLOG-2141 (Clients group only). Frozen
 * so the one-time migration in `ContactSearchList` can detect a stored selection
 * that equals exactly the old seed and upgrade it to the new all-leaves default,
 * WITHOUT clobbering deliberate user selections.
 */
export const OLD_DEFAULT_ROLE_LEAF_IDS: readonly RoleLeafId[] = Object.freeze([
  ROLE_LEAF.BUYERS,
  ROLE_LEAF.SELLERS,
]);

/**
 * Default role selection: ALL role leaves (Clients + Colleagues + Vendors +
 * Unassigned). A fresh profile shows every synced contact regardless of role,
 * including no-role (Unassigned) contacts (BACKLOG-2141).
 */
export function defaultRoleSelection(): Set<string> {
  return new Set<string>(DEFAULT_ROLE_LEAF_IDS);
}

/** Convenience constant of the default role selection. */
export const DEFAULT_ROLE_SELECTION: ReadonlySet<string> = defaultRoleSelection();

/**
 * True iff `roles` equals EXACTLY the old pre-BACKLOG-2141 seed {buyers, sellers}
 * — i.e. a stored selection that is indistinguishable from "never touched the old
 * default". Used to gate the one-time role-default migration so deliberate
 * selections (e.g. {sellers}, {buyers, sellers, agents}) are left untouched.
 */
export function isOldSeededRoleSelection(roles: Set<string>): boolean {
  if (roles.size !== OLD_DEFAULT_ROLE_LEAF_IDS.length) return false;
  return OLD_DEFAULT_ROLE_LEAF_IDS.every((id) => roles.has(id));
}

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

/** The default filter selection (ALL roles incl. Unassigned; all sources except Inferred). */
export function defaultContactFilters(): ContactFilters {
  return { sources: defaultSourceSelection(), roles: defaultRoleSelection() };
}

/**
 * True when the contact matches ANY selected source leaf. An empty source
 * selection matches nothing (the UI should never persist an empty set for a
 * required dimension, but the predicate is honest about it).
 */
export function matchesSourceFilter(
  contact: SourceFilterable,
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
  contact: SourceFilterable & Pick<Contact, "default_role">,
  filters: ContactFilters,
): boolean {
  return matchesSourceFilter(contact, filters.sources) && matchesRoleFilter(contact, filters.roles);
}
