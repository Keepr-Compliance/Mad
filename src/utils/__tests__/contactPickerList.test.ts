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
  assembleFilterSearch,
  sortContacts,
  projectOntoOrder,
  contactMatchesSearch,
  stableIdentityKey,
  mergeNewOrderKeys,
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

  it("recency ties break on NAME (A-Z) FIRST, not email (BACKLOG-2354)", () => {
    const t = "2026-05-05T00:00:00Z";
    const p = contact({ id: "p", display_name: "Zeta", email: "aaa@x.com", last_communication_at: t });
    const q = contact({ id: "q", display_name: "Alpha", email: "bbb@x.com", last_communication_at: t });
    // Equal timestamps -> NAME wins: "Alpha" (q) before "Zeta" (p), EVEN THOUGH
    // q's email (bbb) sorts after p's (aaa). Pre-2354 the email tiebreaker made
    // this ["p","q"]; the visible order must now be alphabetical-by-name.
    expect(ids(buildVisibleContacts({ contacts: [q, p] }))).toEqual(["q", "p"]);
    expect(ids(buildVisibleContacts({ contacts: [p, q] }))).toEqual(["q", "p"]);
  });

  it("recency + name BOTH tie -> stable identity (email) is the final tiebreaker (BACKLOG-2354)", () => {
    const t = "2026-05-05T00:00:00Z";
    // Same display_name, same timestamp -> name cannot decide, so the invisible
    // stableIdentityKey (smallest email) preserves determinism/import-stability.
    const p = contact({ id: "p", display_name: "Same Name", email: "aaa@x.com", last_communication_at: t });
    const q = contact({ id: "q", display_name: "Same Name", email: "bbb@x.com", last_communication_at: t });
    // aaa < bbb -> p before q, regardless of input order.
    expect(ids(buildVisibleContacts({ contacts: [q, p] }))).toEqual(["p", "q"]);
    expect(ids(buildVisibleContacts({ contacts: [p, q] }))).toEqual(["p", "q"]);
  });

  it("a fully no-recency list reads alphabetically by NAME, never by email (BACKLOG-2354)", () => {
    // The founder-QA bug: every contact tied on an empty timestamp, so the list
    // rendered alphabetical-by-EMAIL with never-contacted people at the top.
    const nameZ = contact({ id: "z", display_name: "Zoe", email: "aaa@x.com", last_communication_at: null });
    const nameA = contact({ id: "a", display_name: "Amy", email: "zzz@x.com", last_communication_at: null });
    const nameM = contact({ id: "m", display_name: "Mia", email: "mmm@x.com", last_communication_at: null });
    // Emails are the INVERSE of name order on purpose: name must win.
    expect(ids(buildVisibleContacts({ contacts: [nameZ, nameA, nameM] }))).toEqual(["a", "m", "z"]);
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

// ---------------------------------------------------------------------------
// BACKLOG-2355 — projectOntoOrder: freeze the visible order, project live data.
// ---------------------------------------------------------------------------
describe("projectOntoOrder — the picker order-freeze primitive", () => {
  it("empty orderKeys -> full sort (identical to sortContacts / buildVisibleContacts)", () => {
    const zed = contact({ id: "z", display_name: "Zed", email: "z@x.com", last_communication_at: "2026-01-01T00:00:00Z" });
    const mike = contact({ id: "m", display_name: "Mike", email: "m@x.com", last_communication_at: "2026-06-01T00:00:00Z" });
    const list = [zed, mike];

    const projected = projectOntoOrder(list, [], "recent");
    expect(ids(projected)).toEqual(ids(sortContacts(list, "recent")));
    expect(ids(projected)).toEqual(["m", "z"]); // recency DESC
  });

  it("THE 2355 CASE: slot survives a UUID swap AND a recency null->real change", () => {
    // Frozen order captured while B was an un-imported external with NULL recency,
    // so it sat LAST under Recent sort.
    const a = contact({ id: "imp-a", display_name: "A", email: "a@x.com", last_communication_at: "2026-06-03T00:00:00Z" });
    const c = contact({ id: "imp-c", display_name: "C", email: "c@x.com", last_communication_at: "2026-06-01T00:00:00Z" });
    const extB = contact({ id: "ext_b", display_name: "B", email: "b@x.com", last_communication_at: null });

    const frozen = sortContacts([a, c, extB], "recent");
    const orderKeys = frozen.map(stableIdentityKey);
    expect(ids(frozen)).toEqual(["imp-a", "imp-c", "ext_b"]); // B last (null recency)

    // Import B: brand-NEW UUID, and recency flips null -> a REAL (newest) date —
    // exactly what dragged the row to the TOP under a live re-sort (the jump).
    const importedB = contact({
      id: "uuid-b-new",
      display_name: "B",
      email: "b@x.com",
      source: "contacts_app",
      last_communication_at: "2026-06-05T00:00:00Z",
    });
    const live = [a, c, importedB];

    const projected = projectOntoOrder(live, orderKeys, "recent");
    // B stays in its FROZEN slot (index 2) despite the new UUID and newer date.
    expect(ids(projected)).toEqual(["imp-a", "imp-c", "uuid-b-new"]);
    // Identity keys unchanged position-for-position -> the row did not move.
    expect(projected.map(stableIdentityKey)).toEqual(orderKeys);
  });

  it("drops orderKeys whose identity is no longer present (removed / filtered / searched out)", () => {
    const a = contact({ id: "a", email: "a@x.com" });
    const b = contact({ id: "b", email: "b@x.com" });
    const c = contact({ id: "c", email: "c@x.com" });
    const orderKeys = [a, b, c].map(stableIdentityKey);

    // b vanished from the live list.
    const projected = projectOntoOrder([a, c], orderKeys, "recent");
    expect(ids(projected)).toEqual(["a", "c"]);
  });

  it("merges a brand-new identity into its sorted position, frozen rows unmoved", () => {
    const a = contact({ id: "a", display_name: "A", email: "a@x.com", last_communication_at: "2026-06-03T00:00:00Z" });
    const c = contact({ id: "c", display_name: "C", email: "c@x.com", last_communication_at: "2026-06-01T00:00:00Z" });
    const frozenKeys = sortContacts([a, c], "recent").map(stableIdentityKey); // [a, c]

    // A new contact arrives with a recency BETWEEN a and c.
    const nw = contact({ id: "new", display_name: "New", email: "new@x.com", last_communication_at: "2026-06-02T00:00:00Z" });
    const projected = projectOntoOrder([a, c, nw], frozenKeys, "recent");

    // Frozen backbone [a, c] preserved; new row inserted at its recency slot.
    expect(ids(projected)).toEqual(["a", "new", "c"]);
  });

  it("appends a brand-new identity when it sorts after every frozen row", () => {
    const a = contact({ id: "a", display_name: "A", email: "a@x.com", last_communication_at: "2026-06-03T00:00:00Z" });
    const c = contact({ id: "c", display_name: "C", email: "c@x.com", last_communication_at: "2026-06-02T00:00:00Z" });
    const frozenKeys = sortContacts([a, c], "recent").map(stableIdentityKey);

    const older = contact({ id: "old", display_name: "Old", email: "old@x.com", last_communication_at: "2026-01-01T00:00:00Z" });
    expect(ids(projectOntoOrder([a, c, older], frozenKeys, "recent"))).toEqual(["a", "c", "old"]);
  });

  it("an explicit re-sort (new orderKeys) refreshes the frozen order", () => {
    const zed = contact({ id: "z", display_name: "Zed", email: "z@x.com", last_communication_at: "2026-06-01T00:00:00Z" });
    const ann = contact({ id: "an", display_name: "Ann", email: "an@x.com", last_communication_at: "2026-01-01T00:00:00Z" });
    const list = [zed, ann];

    // Recent freeze: Zed (newer) first.
    const recentKeys = sortContacts(list, "recent").map(stableIdentityKey);
    expect(ids(projectOntoOrder(list, recentKeys, "recent"))).toEqual(["z", "an"]);

    // User toggles to Alphabetical -> the effect recomputes orderKeys -> Ann first.
    const alphaKeys = sortContacts(list, "alphabetical").map(stableIdentityKey);
    expect(ids(projectOntoOrder(list, alphaKeys, "alphabetical"))).toEqual(["an", "z"]);
  });

  it("never drops a live row when two distinct contacts share a stableIdentityKey", () => {
    // The dedup stage keeps two distinct imported rows that share an email; both
    // therefore share a stableIdentityKey. projectOntoOrder must surface BOTH
    // (a key-indexed map would collapse them — the bug that dropped rows).
    const c1 = contact({ id: "c1", display_name: "Dup One", email: "dup@x.com" });
    const c2 = contact({ id: "c2", display_name: "Dup Two", email: "dup@x.com" });
    expect(stableIdentityKey(c1)).toEqual(stableIdentityKey(c2)); // precondition

    const orderKeys = sortContacts([c1, c2], "recent").map(stableIdentityKey);
    const projected = projectOntoOrder([c1, c2], orderKeys, "recent");
    expect(idSet(projected)).toEqual(new Set(["c1", "c2"]));
    expect(projected).toHaveLength(2);
  });

  it("does not mutate its inputs", () => {
    const a = contact({ id: "a", email: "a@x.com" });
    const b = contact({ id: "b", email: "b@x.com" });
    const list = [a, b];
    const keys = sortContacts(list, "recent").map(stableIdentityKey);
    const before = ids(list);
    projectOntoOrder(list, keys, "recent");
    expect(ids(list)).toEqual(before);
  });

  it("assembleFilterSearch + projectOntoOrder composes to the same set buildVisibleContacts produces", () => {
    const imported = [contact({ id: "i1", email: "i1@x.com" }), contact({ id: "i2", email: "i2@x.com" })];
    const external = [contact({ id: "e-new", email: "e@x.com" })];
    const input: BuildVisibleContactsInput = { contacts: imported, externalContacts: external, sortOrder: "recent" };

    const composed = projectOntoOrder(assembleFilterSearch(input), [], "recent");
    expect(idSet(composed)).toEqual(idSet(buildVisibleContacts(input)));
    expect(ids(composed)).toEqual(ids(buildVisibleContacts(input)));
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-2357 — mergeNewOrderKeys: additively merge late-arriving identity keys
// into a frozen order WITHOUT re-sorting existing keys.
// ---------------------------------------------------------------------------
describe("mergeNewOrderKeys — additive freeze merge (BACKLOG-2357)", () => {
  it("returns the SAME reference when nothing is new (background refresh -> React bails)", () => {
    const existing = ["e:a@x.com", "e:b@x.com", "e:c@x.com"];
    // Current list is the SAME identities (data refreshed in place, no new rows).
    const sorted = ["e:a@x.com", "e:b@x.com", "e:c@x.com"];
    expect(mergeNewOrderKeys(existing, sorted)).toBe(existing); // reference equality
  });

  it("returns the SAME reference even when the current sort REORDERS existing keys", () => {
    // The whole point of the freeze: a recency flip re-sorts `sorted` but must NOT
    // disturb the frozen order. No new keys -> same frozen array, same reference.
    const existing = ["e:a@x.com", "e:b@x.com", "e:c@x.com"];
    const sortedAfterRecencyFlip = ["e:c@x.com", "e:a@x.com", "e:b@x.com"];
    expect(mergeNewOrderKeys(existing, sortedAfterRecencyFlip)).toBe(existing);
  });

  it("appends a late-arriving external key at its sorted position (the founder case)", () => {
    // Frozen order was seeded from imported-only rows [a, c]. An external contact
    // (b) loads a beat later; in the current sort it belongs between a and c.
    const existing = ["e:a@x.com", "e:c@x.com"];
    const sorted = ["e:a@x.com", "e:b@x.com", "e:c@x.com"];
    expect(mergeNewOrderKeys(existing, sorted)).toEqual([
      "e:a@x.com",
      "e:b@x.com",
      "e:c@x.com",
    ]);
  });

  it("preserves the EXACT existing order while inserting a new key, even if existing is 'stale' vs sorted", () => {
    // Existing frozen order is [c, a] (frozen before a recency change). Current
    // sort is [a, b, c]. `b` is new. `a`/`c` keep their FROZEN relative order [c, a];
    // `b` (sorted index 1) is inserted before the first existing key that sorts
    // after it — `c` is at sorted index 2 (> 1) so b goes before c: [b, c, a].
    const existing = ["e:c@x.com", "e:a@x.com"];
    const sorted = ["e:a@x.com", "e:b@x.com", "e:c@x.com"];
    expect(mergeNewOrderKeys(existing, sorted)).toEqual([
      "e:b@x.com",
      "e:c@x.com",
      "e:a@x.com",
    ]);
  });

  it("appends a new key that sorts last to the very end", () => {
    const existing = ["e:a@x.com", "e:b@x.com"];
    const sorted = ["e:a@x.com", "e:b@x.com", "e:z@x.com"];
    expect(mergeNewOrderKeys(existing, sorted)).toEqual([
      "e:a@x.com",
      "e:b@x.com",
      "e:z@x.com",
    ]);
  });

  it("MULTISET-aware: a second row sharing an existing key gets its own appended slot", () => {
    // Two distinct imported rows share stableIdentityKey `e:a@x.com` (dedup keeps
    // both). Existing froze one; the second occurrence is genuinely new.
    const existing = ["e:a@x.com", "e:b@x.com"];
    const sorted = ["e:a@x.com", "e:a@x.com", "e:b@x.com"];
    expect(mergeNewOrderKeys(existing, sorted)).toEqual([
      "e:a@x.com",
      "e:a@x.com",
      "e:b@x.com",
    ]);
  });

  it("keeps existing keys that vanished from the current sort (removed rows stay in the order)", () => {
    // `b` is no longer in the current list (filtered/searched/removed) but was
    // frozen. It is preserved (projectOntoOrder drops it at render time). A new
    // key `d` is still placed by sorted position.
    const existing = ["e:a@x.com", "e:b@x.com", "e:c@x.com"];
    const sorted = ["e:a@x.com", "e:c@x.com", "e:d@x.com"];
    expect(mergeNewOrderKeys(existing, sorted)).toEqual([
      "e:a@x.com",
      "e:b@x.com",
      "e:c@x.com",
      "e:d@x.com",
    ]);
  });

  it("seeds from empty (first data) with every key in sorted order", () => {
    const sorted = ["e:a@x.com", "e:b@x.com", "e:c@x.com"];
    expect(mergeNewOrderKeys([], sorted)).toEqual(sorted);
  });

  it("does not mutate the input arrays", () => {
    const existing = ["e:c@x.com", "e:a@x.com"];
    const sorted = ["e:a@x.com", "e:b@x.com", "e:c@x.com"];
    const existingCopy = [...existing];
    const sortedCopy = [...sorted];
    mergeNewOrderKeys(existing, sorted);
    expect(existing).toEqual(existingCopy);
    expect(sorted).toEqual(sortedCopy);
  });

  it("end-to-end: a merged key gets a FROZEN slot so projectOntoOrder holds it through a recency flip", () => {
    // Model the real bug. Imported [a, c] frozen; external `b` (email-only) loads
    // late and is merged in. Then b's recency flips (null->real on import); the
    // merged frozen slot must keep b in place, not re-sort it.
    const a = contact({ id: "a", email: "a@x.com", last_communication_at: "2026-06-03T00:00:00Z" });
    const c = contact({ id: "c", email: "c@x.com", last_communication_at: "2026-06-01T00:00:00Z" });
    const bBefore = contact({ id: "b", email: "b@x.com", last_communication_at: "2026-06-02T00:00:00Z" });

    // 1. Freeze from imported-only [a, c] (b not present yet).
    const frozen0 = sortContacts([a, c], "recent").map(stableIdentityKey); // [a, c]
    // 2. b arrives late -> additive merge places it at its sorted slot (between a, c).
    const frozen1 = mergeNewOrderKeys(frozen0, sortContacts([a, c, bBefore], "recent").map(stableIdentityKey));
    expect(frozen1).toEqual([a, bBefore, c].map(stableIdentityKey));

    // 3. b's recency flips to the NEWEST (as if import surfaced a newer date).
    const bAfter = contact({ id: "b2", email: "b@x.com", last_communication_at: "2026-06-10T00:00:00Z" });
    // projectOntoOrder against the frozen order must NOT move b to the top.
    const projected = projectOntoOrder([a, c, bAfter], frozen1, "recent");
    expect(projected.map((x) => x.id)).toEqual(["a", "b2", "c"]);
  });
});
