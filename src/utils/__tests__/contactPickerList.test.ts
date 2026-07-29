/**
 * contactPickerList — pure engine tests (BACKLOG-2352).
 *
 * The behavioral guardrail against the recurrence of the contact search/select
 * bugs (search not narrowing, duplicate rows, non-deterministic order). Every
 * assertion checks EXACT ID SETS/ORDER (house rule — never bare counts).
 */

import type { ExtendedContact } from "../../types/components";
import {
  buildVisibleContacts,
  assembleDedupedContacts,
  contactMatchesSearch,
  stableIdentityKey,
  type BuildVisibleContactsInput,
} from "../contactPickerList";
import type { ContactFilters } from "../contactFilterModel";

// --- Factory ---------------------------------------------------------------

let seq = 0;
function contact(overrides: Partial<ExtendedContact> = {}): ExtendedContact {
  seq += 1;
  return {
    id: `c${seq}`,
    user_id: "u1",
    source: "manual",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    display_name: `Contact ${seq}`,
    name: `Contact ${seq}`,
    ...overrides,
  } as ExtendedContact;
}

const ids = (list: ExtendedContact[]): string[] => list.map((c) => c.id);
const idSet = (list: ExtendedContact[]): Set<string> => new Set(ids(list));

/** All leaf ids selected — a pass-everything filter. */
function selectAllFilters(sources: string[], roles: string[]): ContactFilters {
  return { sources: new Set(sources), roles: new Set(roles) };
}

beforeEach(() => {
  seq = 0;
});

// ---------------------------------------------------------------------------
describe("contactMatchesSearch", () => {
  it("matches across name, email, company, phone, allEmails, allPhones (case-insensitive, trimmed)", () => {
    const c = contact({
      display_name: "Alice Anderson",
      email: "alice@company.com",
      phone: "555-1234",
      company: "Keepr Realty",
      allEmails: ["alice@company.com", "a.anderson@work.io"],
      allPhones: ["555-1234", "555-9999"],
    });
    expect(contactMatchesSearch(c, "  ALICE ")).toBe(true); // name, trimmed + case
    expect(contactMatchesSearch(c, "company.com")).toBe(true); // email
    expect(contactMatchesSearch(c, "keepr")).toBe(true); // company
    expect(contactMatchesSearch(c, "9999")).toBe(true); // allPhones
    expect(contactMatchesSearch(c, "work.io")).toBe(true); // allEmails
    expect(contactMatchesSearch(c, "")).toBe(true); // empty = everything
    expect(contactMatchesSearch(c, "   ")).toBe(true); // whitespace = everything
    expect(contactMatchesSearch(c, "zzz-none")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("buildVisibleContacts — search narrows to the exact matching set", () => {
  const alice = contact({ id: "alice", display_name: "Alice Anderson", email: "alice@company.com", phone: "555-1111" });
  const bob = contact({ id: "bob", display_name: "Bob Builder", email: "bob@builders.com", phone: "555-2222", company: "Builders Inc" });
  const carol = contact({ id: "carol", display_name: "Carol Chen", email: "carol@realty.com", phone: "555-3333" });

  it("returns ONLY contacts whose searched fields contain the query", () => {
    const out = buildVisibleContacts({ contacts: [alice, bob, carol], searchQuery: "builder" });
    expect(idSet(out)).toEqual(new Set(["bob"])); // name "Builder" + company "Builders Inc"
  });

  it("empty query returns everyone", () => {
    const out = buildVisibleContacts({ contacts: [alice, bob, carol], searchQuery: "  " });
    expect(idSet(out)).toEqual(new Set(["alice", "bob", "carol"]));
  });

  it("no match returns empty", () => {
    const out = buildVisibleContacts({ contacts: [alice, bob, carol], searchQuery: "nobody" });
    expect(out).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("buildVisibleContacts — dedup: zero duplicate IDs, ever", () => {
  it("drops externals already imported (email, phone, and NON-primary/allEmails match)", () => {
    const impByEmail = contact({ id: "imp-email", email: "shared@x.com", phone: "555-0001" });
    const impByPhone = contact({ id: "imp-phone", email: "unique1@x.com", phone: "555-0002" });
    const impByAllEmails = contact({ id: "imp-all", email: "primary@x.com", allEmails: ["primary@x.com", "hidden@x.com"] });

    const extDupEmail = contact({ id: "ext-email", email: "SHARED@x.com" }); // case-insensitive email match
    const extDupPhone = contact({ id: "ext-phone", email: "unique2@x.com", phone: "(555) 000-2" }); // last-10 phone match -> 5550002
    const extDupNonPrimary = contact({ id: "ext-nonprimary", email: "hidden@x.com" }); // matches impByAllEmails via allEmails
    const extFresh = contact({ id: "ext-fresh", email: "brandnew@x.com" });

    const out = buildVisibleContacts({
      contacts: [impByEmail, impByPhone, impByAllEmails],
      externalContacts: [extDupEmail, extDupPhone, extDupNonPrimary, extFresh],
    });

    expect(idSet(out)).toEqual(new Set(["imp-email", "imp-phone", "imp-all", "ext-fresh"]));
    // No id appears twice.
    expect(ids(out).length).toBe(new Set(ids(out)).size);
  });

  it("collapses duplicate externals, incl. junk-in-email and name-only entries", () => {
    // Two externals sharing a junk (Zoom URL) 'email' -> deduped by email token.
    const zoomA = contact({ id: "zoom-a", display_name: "Zoom Room", email: "https://zoom.us/j/12345" });
    const zoomB = contact({ id: "zoom-b", display_name: "Zoom Room", email: "https://zoom.us/j/12345" });
    // Two name-only externals (no email/phone) with the same name -> deduped by name.
    const lucaA = contact({ id: "luca-a", display_name: "Luca", email: undefined, phone: undefined });
    const lucaB = contact({ id: "luca-b", display_name: "Luca", email: undefined, phone: undefined });
    // A distinct name-only external survives.
    const mara = contact({ id: "mara", display_name: "Mara", email: undefined, phone: undefined });

    const out = buildVisibleContacts({
      contacts: [],
      externalContacts: [zoomA, zoomB, lucaA, lucaB, mara],
    });

    // First-seen wins for each identity; every id unique.
    expect(idSet(out)).toEqual(new Set(["zoom-a", "luca-a", "mara"]));
    expect(ids(out).length).toBe(new Set(ids(out)).size);
  });

  it("never merges two distinct IMPORTED DB rows that happen to share an email", () => {
    // A couple sharing one email — both are real DB rows and must both render.
    const partnerA = contact({ id: "partner-a", display_name: "Partner A", email: "couple@home.com" });
    const partnerB = contact({ id: "partner-b", display_name: "Partner B", email: "couple@home.com" });
    const out = buildVisibleContacts({ contacts: [partnerA, partnerB] });
    expect(idSet(out)).toEqual(new Set(["partner-a", "partner-b"]));
  });

  it("preserves allEmails/allPhones on returned objects (BACKLOG-1270)", () => {
    const c = contact({ id: "keep", email: "p@x.com", allEmails: ["p@x.com", "s@x.com"], allPhones: ["555-1", "555-2"] });
    const out = buildVisibleContacts({ contacts: [c] });
    expect(out[0].allEmails).toEqual(["p@x.com", "s@x.com"]);
    expect(out[0].allPhones).toEqual(["555-1", "555-2"]);
    expect(out[0]).toBe(c); // same reference, never cloned
  });
});

// ---------------------------------------------------------------------------
describe("buildVisibleContacts — determinism", () => {
  const build = (): ExtendedContact[] => [
    contact({ id: "d1", display_name: "Same Name", email: "d1@x.com", last_communication_at: "2026-05-01T00:00:00Z" }),
    contact({ id: "d2", display_name: "Same Name", email: "d2@x.com", last_communication_at: "2026-05-01T00:00:00Z" }),
    contact({ id: "d3", display_name: "Same Name", email: "d3@x.com", last_communication_at: "2026-05-01T00:00:00Z" }),
  ];

  it("same input twice -> identical ORDER (even with equal sort fields)", () => {
    seq = 0;
    const a = buildVisibleContacts({ contacts: build() });
    seq = 0;
    const b = buildVisibleContacts({ contacts: build() });
    expect(ids(a)).toEqual(ids(b));
  });

  it("re-invocation on the SAME array does not drift (simulates a re-render)", () => {
    const input: BuildVisibleContactsInput = { contacts: build(), externalContacts: [] };
    const first = ids(buildVisibleContacts(input));
    const second = ids(buildVisibleContacts(input));
    const third = ids(buildVisibleContacts(input));
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("input array order does not affect output (fully sorted, total order)", () => {
    const list = build();
    const forward = ids(buildVisibleContacts({ contacts: list }));
    const reversed = ids(buildVisibleContacts({ contacts: [...list].reverse() }));
    expect(reversed).toEqual(forward);
  });
});

// ---------------------------------------------------------------------------
describe("buildVisibleContacts — sort", () => {
  // Names chosen so alphabetical order differs from recency order.
  const zed = contact({ id: "zed", display_name: "Zed Zulu", email: "zed@x.com", last_communication_at: "2026-06-01T00:00:00Z" });
  const mike = contact({ id: "mike", display_name: "Mike Mike", email: "mike@x.com", last_communication_at: "2026-05-01T00:00:00Z" });
  const alphaNull = contact({ id: "alpha", display_name: "Alpha Alpha", email: "alpha@x.com", last_communication_at: null });

  it("recent (default): last_communication_at DESC, nulls LAST", () => {
    const out = buildVisibleContacts({ contacts: [alphaNull, mike, zed] });
    expect(ids(out)).toEqual(["zed", "mike", "alpha"]);
  });

  it("alphabetical: A-Z by display_name", () => {
    const out = buildVisibleContacts({ contacts: [zed, mike, alphaNull], sortOrder: "alphabetical" });
    expect(ids(out)).toEqual(["alpha", "mike", "zed"]);
  });

  it("recency ties break on a STABLE identity key (deterministic)", () => {
    const t = "2026-05-05T00:00:00Z";
    const p = contact({ id: "p", display_name: "Zeta", email: "aaa@x.com", last_communication_at: t });
    const q = contact({ id: "q", display_name: "Alpha", email: "bbb@x.com", last_communication_at: t });
    // Equal timestamps -> tiebreaker = smallest email key: aaa < bbb -> p before q.
    expect(ids(buildVisibleContacts({ contacts: [q, p] }))).toEqual(["p", "q"]);
    expect(ids(buildVisibleContacts({ contacts: [p, q] }))).toEqual(["p", "q"]);
  });

  it("toggling recent -> alphabetical -> recent restores recency order", () => {
    const recent1 = ids(buildVisibleContacts({ contacts: [zed, mike, alphaNull], sortOrder: "recent" }));
    const alpha = ids(buildVisibleContacts({ contacts: [zed, mike, alphaNull], sortOrder: "alphabetical" }));
    const recent2 = ids(buildVisibleContacts({ contacts: [zed, mike, alphaNull], sortOrder: "recent" }));
    expect(alpha).not.toEqual(recent1);
    expect(recent2).toEqual(recent1);
  });
});

// ---------------------------------------------------------------------------
describe("buildVisibleContacts — filter", () => {
  const outlookBuyer = contact({ id: "outlook-buyer", source: "outlook", default_role: "buyer" });
  const gmailAgent = contact({ id: "gmail-agent", source: "google_contacts", default_role: "buyer_agent" });

  it("null filters = show everyone (transaction-flow default)", () => {
    const out = buildVisibleContacts({ contacts: [outlookBuyer, gmailAgent], filters: null });
    expect(idSet(out)).toEqual(new Set(["outlook-buyer", "gmail-agent"]));
  });

  it("narrows to the exact expected ID set (source outlook + role buyers)", () => {
    const filters = selectAllFilters(["outlook"], ["buyers"]);
    const out = buildVisibleContacts({ contacts: [outlookBuyer, gmailAgent], filters });
    expect(idSet(out)).toEqual(new Set(["outlook-buyer"]));
  });
});

// ---------------------------------------------------------------------------
describe("buildVisibleContacts — import stability (the SVO replacement)", () => {
  it("a contact whose id changes ext_* -> DB UUID (same email, same sort data) keeps its position", () => {
    const a = contact({ id: "imp-a", display_name: "A", email: "a@x.com", last_communication_at: "2026-06-03T00:00:00Z" });
    const extB = contact({ id: "ext_b", display_name: "B", email: "b@x.com", last_communication_at: "2026-06-02T00:00:00Z" });
    const c = contact({ id: "imp-c", display_name: "C", email: "c@x.com", last_communication_at: "2026-06-01T00:00:00Z" });

    const before = buildVisibleContacts({ contacts: [a, c], externalContacts: [extB] });
    expect(ids(before)).toEqual(["imp-a", "ext_b", "imp-c"]); // recency order

    // Import B: brand-new UUID, is now imported, SAME email + SAME timestamp.
    const importedB = contact({
      id: "uuid-b-new",
      display_name: "B",
      email: "b@x.com",
      source: "contacts_app",
      last_communication_at: "2026-06-02T00:00:00Z",
    });
    const after = buildVisibleContacts({ contacts: [a, c, importedB], externalContacts: [] });

    // B's row keeps its slot (index 1) — only the id changed underneath.
    expect(ids(after)).toEqual(["imp-a", "uuid-b-new", "imp-c"]);
    // The stable identity keys are unchanged position-for-position.
    expect(before.map(stableIdentityKey)).toEqual(after.map(stableIdentityKey));
  });
});

// ---------------------------------------------------------------------------
describe("buildVisibleContacts — count equals rendered rows", () => {
  it("result.length is the single source of truth for the visible count", () => {
    const imported = [contact({ id: "i1", email: "i1@x.com" }), contact({ id: "i2", email: "i2@x.com" })];
    const external = [
      contact({ id: "e-dup", email: "I1@x.com" }), // deduped against i1
      contact({ id: "e-new", email: "e@x.com" }),
    ];
    const out = buildVisibleContacts({ contacts: imported, externalContacts: external });
    expect(out.length).toBe(3);
    expect(idSet(out)).toEqual(new Set(["i1", "i2", "e-new"]));
    // assembleDedupedContacts agrees (same engine stage).
    expect(assembleDedupedContacts(imported, external).length).toBe(3);
  });
});
