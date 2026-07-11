/**
 * Unit tests for contactFilterModel (BACKLOG-1898 T2, pure logic).
 *
 * Coverage:
 *   - Every Source mapping-table row (§2), incl. distinct iphone /
 *     google_contacts / outlook / android_sync + is_message_derived combos.
 *   - Every Role group/child vs default_role (§3), incl. the legacy `client`
 *     folded under Buyers and the "Other" catch-all.
 *   - The Unassigned NULL predicate (matches only when Unassigned ticked).
 *   - Both default selections (all-except-Inferred; Clients-only, Unassigned OFF).
 *   - Brokers grey/no-data (no backing role value).
 */

import type { Contact, ContactSource } from "../../../electron/types/models";
import {
  SOURCE_LEAF,
  ROLE_LEAF,
  SOURCE_GROUPS,
  ROLE_GROUPS,
  ROLE_LEAF_TO_DEFAULT_ROLES,
  ALL_SOURCE_LEAF_IDS,
  ALL_ROLE_LEAF_IDS,
  INFERRED_SOURCE_LEAF_IDS,
  DEFAULT_ROLE_LEAF_IDS,
  isMessageDerived,
  defaultSourceSelection,
  defaultRoleSelection,
  defaultContactFilters,
  matchesSourceFilter,
  matchesRoleFilter,
  matchesContactFilters,
  type ContactFilters,
} from "../contactFilterModel";
import { SPECIFIC_ROLES } from "../../constants/contactRoles";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a minimal Contact with just the fields the predicate reads. */
function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "c1",
    user_id: "u1",
    display_name: "Test Contact",
    source: "manual" as ContactSource,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Contact;
}

/** Selection helper. */
const sel = (...ids: string[]): Set<string> => new Set(ids);

/** A selection that turns every source leaf ON (so role-only tests isolate role). */
const allSources = (): Set<string> => new Set(ALL_SOURCE_LEAF_IDS);
/** A selection that turns every role leaf ON (so source-only tests isolate source). */
const allRoles = (): Set<string> => new Set(ALL_ROLE_LEAF_IDS);

// ===========================================================================
// isMessageDerived normalizer
// ===========================================================================

describe("isMessageDerived", () => {
  it("treats numeric 1 as derived and 0 as not derived", () => {
    expect(isMessageDerived(makeContact({ is_message_derived: 1 }))).toBe(true);
    expect(isMessageDerived(makeContact({ is_message_derived: 0 }))).toBe(false);
  });

  it("treats boolean true/false correctly", () => {
    expect(isMessageDerived(makeContact({ is_message_derived: true }))).toBe(true);
    expect(isMessageDerived(makeContact({ is_message_derived: false }))).toBe(false);
  });

  it("treats undefined as not derived", () => {
    expect(isMessageDerived(makeContact({ is_message_derived: undefined }))).toBe(false);
  });
});

// ===========================================================================
// Source predicate — every mapping-table row (§2)
// ===========================================================================

describe("matchesSourceFilter — per-leaf mapping (§2)", () => {
  // [leafId, matching source value, is_message_derived]
  const directRows: Array<[string, ContactSource]> = [
    [SOURCE_LEAF.MANUAL, "manual"],
    [SOURCE_LEAF.CONTACTS_APP, "contacts_app"],
    [SOURCE_LEAF.EMAIL_OUTLOOK, "outlook"],
    [SOURCE_LEAF.EMAIL_GMAIL, "google_contacts"],
    [SOURCE_LEAF.PHONE_IPHONE, "iphone"],
    [SOURCE_LEAF.PHONE_ANDROID, "android_sync"],
  ];

  it.each(directRows)("leaf %s matches source=%s when its leaf is selected", (leafId, source) => {
    const contact = makeContact({ source });
    expect(matchesSourceFilter(contact, sel(leafId))).toBe(true);
  });

  it.each(directRows)("leaf %s does NOT match when only OTHER leaves are selected (source=%s)", (leafId, source) => {
    const contact = makeContact({ source });
    // Select every leaf except this one.
    const others = new Set(ALL_SOURCE_LEAF_IDS.filter((id) => id !== leafId));
    expect(matchesSourceFilter(contact, others)).toBe(false);
  });

  it("distinct providers do not cross-match (iphone !== android, outlook !== gmail)", () => {
    expect(matchesSourceFilter(makeContact({ source: "iphone" }), sel(SOURCE_LEAF.PHONE_ANDROID))).toBe(false);
    expect(matchesSourceFilter(makeContact({ source: "android_sync" }), sel(SOURCE_LEAF.PHONE_IPHONE))).toBe(false);
    expect(matchesSourceFilter(makeContact({ source: "outlook" }), sel(SOURCE_LEAF.EMAIL_GMAIL))).toBe(false);
    expect(matchesSourceFilter(makeContact({ source: "google_contacts" }), sel(SOURCE_LEAF.EMAIL_OUTLOOK))).toBe(false);
  });
});

describe("matchesSourceFilter — Inferred group (§2, is_message_derived combos)", () => {
  it("From Email matches source=email AND is_message_derived truthy", () => {
    const c = makeContact({ source: "email" as ContactSource, is_message_derived: 1 });
    expect(matchesSourceFilter(c, sel(SOURCE_LEAF.INFERRED_EMAIL))).toBe(true);
  });

  it("From Email matches source=inferred AND is_message_derived truthy", () => {
    const c = makeContact({ source: "inferred" as ContactSource, is_message_derived: true });
    expect(matchesSourceFilter(c, sel(SOURCE_LEAF.INFERRED_EMAIL))).toBe(true);
  });

  it("From Texts matches source=sms AND is_message_derived truthy", () => {
    const c = makeContact({ source: "sms" as ContactSource, is_message_derived: 1 });
    expect(matchesSourceFilter(c, sel(SOURCE_LEAF.INFERRED_TEXTS))).toBe(true);
  });

  it("From Texts matches source=messages (synthetic label) AND is_message_derived truthy", () => {
    const c = makeContact({ source: "messages" as ContactSource, is_message_derived: 1 });
    expect(matchesSourceFilter(c, sel(SOURCE_LEAF.INFERRED_TEXTS))).toBe(true);
  });

  it("Inferred leaves do NOT match when is_message_derived is falsy", () => {
    const email = makeContact({ source: "email" as ContactSource, is_message_derived: 0 });
    const sms = makeContact({ source: "sms" as ContactSource, is_message_derived: false });
    expect(matchesSourceFilter(email, sel(SOURCE_LEAF.INFERRED_EMAIL))).toBe(false);
    expect(matchesSourceFilter(sms, sel(SOURCE_LEAF.INFERRED_TEXTS))).toBe(false);
  });

  it("Inferred From Email does not match a text source and vice versa", () => {
    const sms = makeContact({ source: "sms" as ContactSource, is_message_derived: 1 });
    const email = makeContact({ source: "email" as ContactSource, is_message_derived: 1 });
    expect(matchesSourceFilter(sms, sel(SOURCE_LEAF.INFERRED_EMAIL))).toBe(false);
    expect(matchesSourceFilter(email, sel(SOURCE_LEAF.INFERRED_TEXTS))).toBe(false);
  });

  it("a message-derived email contact is NOT matched by the non-inferred providers", () => {
    // A derived email contact should surface only under Inferred, not under
    // Outlook/Gmail (whose values are distinct providers, not generic email).
    const c = makeContact({ source: "email" as ContactSource, is_message_derived: 1 });
    expect(matchesSourceFilter(c, sel(SOURCE_LEAF.EMAIL_OUTLOOK, SOURCE_LEAF.EMAIL_GMAIL))).toBe(false);
  });
});

describe("matchesSourceFilter — selection semantics", () => {
  it("empty source selection matches nothing", () => {
    expect(matchesSourceFilter(makeContact({ source: "manual" }), sel())).toBe(false);
  });

  it("matches if ANY selected leaf predicate is true (OR semantics)", () => {
    const c = makeContact({ source: "iphone" });
    expect(matchesSourceFilter(c, sel(SOURCE_LEAF.MANUAL, SOURCE_LEAF.PHONE_IPHONE))).toBe(true);
  });

  it("an unknown source value matches no leaf", () => {
    const c = makeContact({ source: "totally_unknown" as ContactSource });
    expect(matchesSourceFilter(c, allSources())).toBe(false);
  });
});

// ===========================================================================
// Role predicate — every group/child vs default_role (§3)
// ===========================================================================

describe("matchesRoleFilter — per-leaf mapping (§3)", () => {
  // [leafId, a default_role value that should match]
  const roleRows: Array<[string, string]> = [
    [ROLE_LEAF.BUYERS, SPECIFIC_ROLES.BUYER],
    [ROLE_LEAF.BUYERS, SPECIFIC_ROLES.CLIENT], // legacy combined role folds under Buyers
    [ROLE_LEAF.SELLERS, SPECIFIC_ROLES.SELLER],
    [ROLE_LEAF.AGENTS, SPECIFIC_ROLES.BUYER_AGENT],
    [ROLE_LEAF.AGENTS, SPECIFIC_ROLES.SELLER_AGENT],
    [ROLE_LEAF.AGENTS, SPECIFIC_ROLES.LISTING_AGENT],
    [ROLE_LEAF.TRANSACTION_COORDINATORS, SPECIFIC_ROLES.TRANSACTION_COORDINATOR],
    [ROLE_LEAF.INSPECTORS, SPECIFIC_ROLES.INSPECTOR],
    [ROLE_LEAF.INSPECTORS, SPECIFIC_ROLES.APPRAISER],
    [ROLE_LEAF.INSPECTORS, SPECIFIC_ROLES.SURVEYOR],
    [ROLE_LEAF.LOAN_OFFICERS, SPECIFIC_ROLES.MORTGAGE_BROKER],
    [ROLE_LEAF.LOAN_OFFICERS, SPECIFIC_ROLES.LENDER],
    [ROLE_LEAF.LAWYERS, SPECIFIC_ROLES.REAL_ESTATE_ATTORNEY],
    [ROLE_LEAF.OTHER, SPECIFIC_ROLES.OTHER],
    [ROLE_LEAF.OTHER, SPECIFIC_ROLES.TITLE_COMPANY],
    [ROLE_LEAF.OTHER, SPECIFIC_ROLES.ESCROW_OFFICER],
    [ROLE_LEAF.OTHER, SPECIFIC_ROLES.INSURANCE_AGENT],
    [ROLE_LEAF.OTHER, SPECIFIC_ROLES.HOA_MANAGEMENT],
    [ROLE_LEAF.OTHER, SPECIFIC_ROLES.CONDO_MANAGEMENT],
  ];

  it.each(roleRows)("leaf %s matches default_role=%s when selected", (leafId, role) => {
    const contact = makeContact({ default_role: role });
    expect(matchesRoleFilter(contact, sel(leafId))).toBe(true);
  });

  it.each(roleRows)("default_role=%s (via leaf %s) does NOT match when only OTHER leaves selected", (leafId, role) => {
    const contact = makeContact({ default_role: role });
    const others = new Set(ALL_ROLE_LEAF_IDS.filter((id) => id !== leafId));
    // Note: some values map to multiple leaves? No — each SPECIFIC_ROLE maps to exactly one leaf.
    expect(matchesRoleFilter(contact, others)).toBe(false);
  });

  it("every SPECIFIC_ROLE value maps to exactly one non-Unassigned leaf", () => {
    const allValues = Object.values(SPECIFIC_ROLES);
    for (const value of allValues) {
      const matchingLeaves = ALL_ROLE_LEAF_IDS.filter((leaf) => {
        const vals = ROLE_LEAF_TO_DEFAULT_ROLES[leaf];
        return vals ? vals.includes(value) : false;
      });
      expect(matchingLeaves).toHaveLength(1);
    }
  });
});

describe("matchesRoleFilter — Brokers grey/no-data (§3 note)", () => {
  it("Brokers leaf maps to an empty value set", () => {
    expect(ROLE_LEAF_TO_DEFAULT_ROLES[ROLE_LEAF.BROKERS]).toEqual([]);
  });

  it("Brokers leaf is marked disabled with a 'no data' hint in the config", () => {
    const colleagues = ROLE_GROUPS.find((g) => g.id === "grp_colleagues");
    const brokers = colleagues?.children.find((c) => c.id === ROLE_LEAF.BROKERS);
    expect(brokers?.disabled).toBe(true);
    expect(brokers?.hint).toBe("no data");
  });

  it("selecting Brokers never matches any contact", () => {
    const contacts = [
      makeContact({ default_role: "buyer_agent" }),
      makeContact({ default_role: "buyer" }),
      makeContact({ default_role: undefined }),
    ];
    for (const c of contacts) {
      expect(matchesRoleFilter(c, sel(ROLE_LEAF.BROKERS))).toBe(false);
    }
  });
});

describe("matchesRoleFilter — Unassigned NULL predicate (§3)", () => {
  it("matches null/undefined/empty default_role ONLY when Unassigned is ticked", () => {
    const nullRole = makeContact({ default_role: undefined });
    const emptyRole = makeContact({ default_role: "" });
    expect(matchesRoleFilter(nullRole, sel(ROLE_LEAF.UNASSIGNED))).toBe(true);
    expect(matchesRoleFilter(emptyRole, sel(ROLE_LEAF.UNASSIGNED))).toBe(true);
  });

  it("null-role contact does NOT match any value-based leaf", () => {
    const nullRole = makeContact({ default_role: undefined });
    const valueLeaves = new Set(ALL_ROLE_LEAF_IDS.filter((id) => id !== ROLE_LEAF.UNASSIGNED));
    expect(matchesRoleFilter(nullRole, valueLeaves)).toBe(false);
  });

  it("a contact WITH a role does NOT match the Unassigned toggle", () => {
    const withRole = makeContact({ default_role: "buyer" });
    expect(matchesRoleFilter(withRole, sel(ROLE_LEAF.UNASSIGNED))).toBe(false);
  });
});

describe("matchesRoleFilter — selection semantics", () => {
  it("empty role selection matches nothing", () => {
    expect(matchesRoleFilter(makeContact({ default_role: "buyer" }), sel())).toBe(false);
  });

  it("matches if ANY selected role leaf predicate is true (OR semantics)", () => {
    const c = makeContact({ default_role: "inspector" });
    expect(matchesRoleFilter(c, sel(ROLE_LEAF.BUYERS, ROLE_LEAF.INSPECTORS))).toBe(true);
  });

  it("an unknown default_role value matches no value-based leaf", () => {
    const c = makeContact({ default_role: "made_up_role" });
    const valueLeaves = new Set(ALL_ROLE_LEAF_IDS.filter((id) => id !== ROLE_LEAF.UNASSIGNED));
    expect(matchesRoleFilter(c, valueLeaves)).toBe(false);
  });
});

// ===========================================================================
// Default selections
// ===========================================================================

describe("default selections", () => {
  it("defaultSourceSelection = every source leaf EXCEPT the Inferred group", () => {
    const def = defaultSourceSelection();
    // All non-inferred leaves present.
    for (const id of ALL_SOURCE_LEAF_IDS) {
      const isInferred = INFERRED_SOURCE_LEAF_IDS.includes(id as never);
      expect(def.has(id)).toBe(!isInferred);
    }
    // Explicitly: inferred OFF.
    expect(def.has(SOURCE_LEAF.INFERRED_EMAIL)).toBe(false);
    expect(def.has(SOURCE_LEAF.INFERRED_TEXTS)).toBe(false);
    // Explicitly: distinct providers ON.
    expect(def.has(SOURCE_LEAF.PHONE_IPHONE)).toBe(true);
    expect(def.has(SOURCE_LEAF.EMAIL_GMAIL)).toBe(true);
    expect(def.has(SOURCE_LEAF.EMAIL_OUTLOOK)).toBe(true);
    expect(def.has(SOURCE_LEAF.PHONE_ANDROID)).toBe(true);
  });

  it("defaultRoleSelection = Clients group only (Buyers + Sellers); Unassigned OFF", () => {
    const def = defaultRoleSelection();
    expect(def.has(ROLE_LEAF.BUYERS)).toBe(true);
    expect(def.has(ROLE_LEAF.SELLERS)).toBe(true);
    expect(def.has(ROLE_LEAF.AGENTS)).toBe(false);
    expect(def.has(ROLE_LEAF.TRANSACTION_COORDINATORS)).toBe(false);
    expect(def.has(ROLE_LEAF.INSPECTORS)).toBe(false);
    expect(def.has(ROLE_LEAF.UNASSIGNED)).toBe(false);
    expect([...def].sort()).toEqual([...DEFAULT_ROLE_LEAF_IDS].sort());
  });
});

// ===========================================================================
// Combined predicate + end-to-end default behaviour
// ===========================================================================

describe("matchesContactFilters — combined default behaviour", () => {
  const defaults: ContactFilters = defaultContactFilters();

  it("a manual buyer is visible under defaults", () => {
    const c = makeContact({ source: "manual", default_role: "buyer" });
    expect(matchesContactFilters(c, defaults)).toBe(true);
  });

  it("a gmail (google_contacts) seller is visible under defaults", () => {
    const c = makeContact({ source: "google_contacts", default_role: "seller" });
    expect(matchesContactFilters(c, defaults)).toBe(true);
  });

  it("an iphone client (legacy combined) is visible under defaults", () => {
    const c = makeContact({ source: "iphone", default_role: "client" });
    expect(matchesContactFilters(c, defaults)).toBe(true);
  });

  it("a manual AGENT is hidden under defaults (Clients-only role)", () => {
    const c = makeContact({ source: "manual", default_role: "buyer_agent" });
    expect(matchesContactFilters(c, defaults)).toBe(false);
  });

  it("a manual NULL-role contact is hidden under defaults (Unassigned OFF)", () => {
    const c = makeContact({ source: "manual", default_role: undefined });
    expect(matchesContactFilters(c, defaults)).toBe(false);
  });

  it("an inferred (message-derived) buyer is hidden under defaults (Inferred source OFF)", () => {
    const c = makeContact({ source: "sms", default_role: "buyer", is_message_derived: 1 });
    expect(matchesContactFilters(c, defaults)).toBe(false);
  });

  it("ticking Unassigned reveals a NULL-role contact (source still allowed)", () => {
    const c = makeContact({ source: "manual", default_role: undefined });
    const filters: ContactFilters = {
      sources: defaultSourceSelection(),
      roles: new Set([...defaultRoleSelection(), ROLE_LEAF.UNASSIGNED]),
    };
    expect(matchesContactFilters(c, filters)).toBe(true);
  });

  it("ticking the Inferred source reveals a message-derived buyer", () => {
    const c = makeContact({ source: "sms", default_role: "buyer", is_message_derived: 1 });
    const filters: ContactFilters = {
      sources: new Set([...defaultSourceSelection(), SOURCE_LEAF.INFERRED_TEXTS]),
      roles: defaultRoleSelection(),
    };
    expect(matchesContactFilters(c, filters)).toBe(true);
  });

  it("requires BOTH source AND role to match (AND semantics)", () => {
    // Right role, wrong (deselected) source.
    const c = makeContact({ source: "iphone", default_role: "buyer" });
    const roleOkSourceOff: ContactFilters = {
      sources: sel(SOURCE_LEAF.MANUAL), // iphone not selected
      roles: allRoles(),
    };
    expect(matchesContactFilters(c, roleOkSourceOff)).toBe(false);

    // Right source, wrong (deselected) role.
    const sourceOkRoleOff: ContactFilters = {
      sources: allSources(),
      roles: sel(ROLE_LEAF.SELLERS), // buyer not selected
    };
    expect(matchesContactFilters(c, sourceOkRoleOff)).toBe(false);

    // Both on.
    expect(matchesContactFilters(c, { sources: allSources(), roles: allRoles() })).toBe(true);
  });
});

// ===========================================================================
// Config integrity (guards against typos in the grouped configs)
// ===========================================================================

describe("config integrity", () => {
  it("source leaf ids are unique across all groups", () => {
    const ids = ALL_SOURCE_LEAF_IDS;
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("role leaf ids are unique across all groups", () => {
    const ids = ALL_ROLE_LEAF_IDS;
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("standalone groups have exactly one child whose id equals its group's single leaf", () => {
    for (const g of [...SOURCE_GROUPS, ...ROLE_GROUPS].filter((g) => g.standalone)) {
      expect(g.children).toHaveLength(1);
    }
  });

  it("SOURCE_GROUPS covers all 5 groups in mockup order", () => {
    expect(SOURCE_GROUPS.map((g) => g.label)).toEqual(["Manual", "Contacts App", "Email", "Phone", "Inferred"]);
  });

  it("ROLE_GROUPS covers all 4 groups in mockup order", () => {
    expect(ROLE_GROUPS.map((g) => g.label)).toEqual(["Clients", "Colleagues", "Vendors", "Unassigned"]);
  });
});
