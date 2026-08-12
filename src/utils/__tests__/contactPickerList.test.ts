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
  assembleContacts,
  assembleFilterSearch,
  sortContacts,
  projectOntoOrder,
  contactMatchesSearch,
  stableIdentityKey,
  mergeNewOrderKeys,
  type BuildVisibleContactsInput,
} from "../contactPickerList";
import type { ContactFilters } from "../contactFilterModel";
import { looksLikePhoneQuery } from "../phoneNormalization";

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
describe("contactMatchesSearch — a number is findable the way it is DISPLAYED (BACKLOG-2466)", () => {
  /**
   * The matcher EXACTLY as it stood before this fix: a single plain substring
   * pass over every field, phones included.
   *
   * This is the control. Asserting it here — rather than reverting the source
   * by hand once and trusting the memory of it — is what pins the ASYMMETRY
   * that identifies the defect: the formatted queries were red while the
   * bare-digit ones were green. A control that turns everything red would only
   * prove the test runs.
   */
  function preFixMatcher(c: ExtendedContact, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const haystacks: (string | null | undefined)[] = [
      c.display_name,
      c.name,
      c.email,
      c.phone,
      c.company,
      ...(c.allEmails || []),
      ...(c.allPhones || []),
    ];
    return haystacks.some((v) => !!v && v.toLowerCase().includes(q));
  }

  /** What the founder created in Contacts.app: a number and nothing else. */
  const stored = () =>
    contact({ id: "nameless", display_name: "", name: "", phone: "+14155550100" });

  /** Every form of that number that carries punctuation. Red before the fix. */
  const FORMATTED = [
    "+1 (415) 555-0100", // what `formatPhoneNumber` prints — the on-screen label
    "(415) 555-0100",
    "415-555-0100",
    "415 555 0100",
    "555-0100", // partial
  ];
  /** The two forms that already worked. They must STAY green. */
  const BARE_DIGITS = ["4155550100", "5550100"];

  it.each([...FORMATTED, ...BARE_DIGITS])("finds +14155550100 by %j", (query) => {
    expect(contactMatchesSearch(stored(), query)).toBe(true);
  });

  it.each(FORMATTED)("CONTROL: %j found NOTHING before the fix", (query) => {
    expect(preFixMatcher(stored(), query)).toBe(false);
  });

  it.each(BARE_DIGITS)("CONTROL: %j already worked before the fix", (query) => {
    expect(preFixMatcher(stored(), query)).toBe(true);
  });

  it("non-US numbers are not assumed to be 10 digits or US (founder's own data)", () => {
    const costaRica = contact({ id: "cr", display_name: "", name: "", phone: "+50664103686" });
    expect(contactMatchesSearch(costaRica, "+506 6410-3686")).toBe(true);
    expect(contactMatchesSearch(costaRica, "6410-3686")).toBe(true);
    // CONTROL: the punctuated form was red, the run-together form was green.
    expect(preFixMatcher(costaRica, "+506 6410-3686")).toBe(false);
    expect(preFixMatcher(costaRica, "+50664103686")).toBe(true);
  });

  it("a country code in the QUERY still finds a number stored without one", () => {
    // `formatPhoneNumber` prints a bare 10-digit number as "(415) 555-0100" and
    // an 11-digit "1…" one as "+1 (415) 555-0100". The UI teaches both forms and
    // Contacts.app supplies both storage shapes, so either must find either.
    const tenDigits = contact({ id: "ten", display_name: "", name: "", phone: "4155550100" });
    expect(contactMatchesSearch(tenDigits, "+1 (415) 555-0100")).toBe(true);
    expect(contactMatchesSearch(tenDigits, "14155550100")).toBe(true);
    const elevenDigits = contact({ id: "eleven", display_name: "", name: "", phone: "14155550100" });
    expect(contactMatchesSearch(elevenDigits, "(415) 555-0100")).toBe(true);
  });

  it("matches through allPhones, not just the primary", () => {
    const c = contact({ id: "multi", phone: "555-0000", allPhones: ["555-0000", "+14155550100"] });
    expect(contactMatchesSearch(c, "(415) 555-0100")).toBe(true);
  });

  it("digits in a NAME still match literally — the phone path is additive", () => {
    // The gate exists for this row: "415 Realty" has letters, so it never takes
    // the normalised path, and "415" reaches it through the company haystack —
    // before the fix and after it.
    const realty = contact({ id: "realty", display_name: "Zed Zulu", company: "415 Realty" });
    expect(contactMatchesSearch(realty, "415")).toBe(true);
    expect(preFixMatcher(realty, "415")).toBe(true);
    expect(contactMatchesSearch(realty, "415 Realty")).toBe(true);
  });

  it("does not match an unrelated number", () => {
    expect(contactMatchesSearch(stored(), "9999999")).toBe(false);
    expect(contactMatchesSearch(stored(), "(555) 555-0112")).toBe(false);
    expect(contactMatchesSearch(stored(), "5555550112")).toBe(false);
  });

  it('"#" is not a phone character — "#013" is an apartment, not an extension', () => {
    // Pins the exclusion from PHONE_QUERY_CHARS. Admit "#" and this goes red:
    // "#013" would become the needle "013", which matches the 013 inside this
    // number, so every contact with 013 anywhere in their digits would surface
    // for a query that is almost always a unit number.
    expect(looksLikePhoneQuery("#013")).toBe(false);
    const c = contact({ id: "unit", display_name: "", name: "", phone: "+14155550131" });
    expect(contactMatchesSearch(c, "#013")).toBe(false);
    // The digits alone still reach it — only the "#" form is excluded.
    expect(contactMatchesSearch(c, "013")).toBe(true);
  });

  it("an Apple ID parked in a phone column is not reduced to its digits", () => {
    const handle = contact({ id: "handle", display_name: "", name: "", phone: "chat123456789@icloud.com" });

    // "123-456" is the discriminating query: it is phone-SHAPED (no letters, 6
    // digits) and does NOT occur literally in the handle, so the plain
    // substring pass cannot match it. The only route left is the normalised
    // path — and `normalizePhoneForSearch` returns "" for an "@" value rather
    // than "123456789", so the handle is not treated as the number it isn't.
    expect(contactMatchesSearch(handle, "123-456")).toBe(false);

    // The plain substring pass still finds it as the text it actually is.
    expect(contactMatchesSearch(handle, "chat123")).toBe(true);
    expect(contactMatchesSearch(handle, "icloud.com")).toBe(true);
    // And a literal digit run inside it still matches exactly as it did before
    // the fix — the phone path is additive, so this is unchanged behaviour.
    expect(contactMatchesSearch(handle, "456")).toBe(true);
    expect(preFixMatcher(handle, "456")).toBe(true);
  });

  it("narrows the rendered list to the EXACT matching id set", () => {
    const target = contact({ id: "target", display_name: "", name: "", phone: "+14155550100" });
    const other = contact({ id: "other", display_name: "Bob Builder", phone: "+14155550134" });
    const out = buildVisibleContacts({
      contacts: [target, other],
      searchQuery: "+1 (415) 555-0100",
    });
    expect(idSet(out)).toEqual(new Set(["target"]));
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
describe("buildVisibleContacts — assembly: BACKLOG-2370 removed the dedup stage", () => {
  /**
   * =========================================================================
   * THIS BLOCK USED TO ASSERT THE OPPOSITE OF WHAT IT ASSERTS NOW
   * =========================================================================
   * It pinned a renderer-side rule that decided whether two records were the
   * same person and DROPPED one of them. The founder had that rule removed on
   * 2026-08-04: *"ok sounds good we can remove it then simple is better."*
   *
   * His reasoning is why the inversion below is a fix and not a regression. A
   * combination worth showing a user is worth STORING, and once stored it is a
   * link. This pass stored nothing and was recomputed every render, so a merge
   * it made could not be audited, undone or explained — and it silently reversed
   * an unlink he had just performed, hiding the released record on both surfaces
   * `ContactSearchList` backs.
   *
   * The remaining rule lives in `contacts:get-available`, writes a crosswalk row,
   * consults the user's `different_people` verdicts, and discloses what it
   * folded. `electron/__tests__/contact-handlers.oneMatchingRule.test.ts` pins
   * the whole path end to end through the real handler; these cases pin the pure
   * function's half of it.
   *
   * NEGATIVE CONTROL (executed, output in the PR): restore any identity rule to
   * `assembleContacts` and every case in this block goes red, naming the records
   * it removed.
   */
  it("keeps an external whose email matches a saved contact — main decides that, not this", () => {
    const saved = contact({ id: "imp-email", email: "shared@example.test", phone: "555-0101" });
    const ext = contact({ id: "ext-email", email: "SHARED@example.test" });

    const out = buildVisibleContacts({ contacts: [saved], externalContacts: [ext] });

    // Was: new Set(["imp-email"]).
    expect(idSet(out)).toEqual(new Set(["imp-email", "ext-email"]));
  });

  it("keeps an external matching a saved contact's NON-primary email", () => {
    // The shape that surfaces a real duplicate, because `contacts:get-available`
    // builds its already-imported set from PRIMARY values only and so returns
    // this record. Named and accepted rather than filtered back out — see
    // `contact-handlers.oneMatchingRule.test.ts` for the measurement and for how
    // far it reaches (only contacts with no crosswalk row).
    const saved = contact({
      id: "imp-all",
      email: "primary@example.test",
      allEmails: ["primary@example.test", "hidden@example.test"],
    });
    const ext = contact({ id: "ext-nonprimary", email: "hidden@example.test" });

    const out = buildVisibleContacts({ contacts: [saved], externalContacts: [ext] });

    expect(idSet(out)).toEqual(new Set(["imp-all", "ext-nonprimary"]));
  });

  it("keeps the same person recorded twice on one line — a fold is main's to make", () => {
    const saved = contact({
      id: "imp-phone",
      display_name: "Dana Reyes",
      name: "Dana Reyes",
      email: "dana@example.test",
      phone: "555-0102",
    });
    const ext = contact({
      id: "ext-phone",
      display_name: "Dana Reyes",
      name: "Dana Reyes",
      phone: "(555) 010-2",
    });

    const out = buildVisibleContacts({ contacts: [saved], externalContacts: [ext] });

    // Was: new Set(["imp-phone"]). Main still collapses this pair — with a
    // crosswalk row and a "1 record combined" disclosure on the row that
    // survives, which is the difference the founder cared about.
    expect(idSet(out)).toEqual(new Set(["imp-phone", "ext-phone"]));
  });

  // -------------------------------------------------------------------------
  // BACKLOG-2316 / BACKLOG-2416 — a shared line is not a shared identity.
  //
  // These cases predate BACKLOG-2370 and their EXPECTATIONS ARE UNCHANGED. They
  // are kept verbatim because they are the ones that must never regress in the
  // other direction: removing a dedup layer can only show more, and "more" must
  // still be exactly these people. Two Margarets on one brokerage line are two
  // Margarets whichever layer is asked.
  // -------------------------------------------------------------------------
  describe("BACKLOG-2416 — a shared line is not a shared identity", () => {
    const OFFICE_LINE = "(555) 010-0";

    it("keeps two DISTINCT people who share one office line", () => {
      const chen = contact({
        id: "chen",
        display_name: "Margaret Chen",
        name: "Margaret Chen",
        email: "chen@example.test",
        phone: OFFICE_LINE,
      });
      const torres = contact({
        id: "torres",
        display_name: "Margaret Torres",
        name: "Margaret Torres",
        email: "torres@example.test",
        phone: OFFICE_LINE,
      });

      const out = buildVisibleContacts({ contacts: [chen], externalContacts: [torres] });

      expect(idSet(out)).toEqual(new Set(["chen", "torres"]));
    });

    it("keeps three distinct people on one line, not just the first two", () => {
      const a = contact({ id: "a", display_name: "Margaret Chen", name: "Margaret Chen", phone: OFFICE_LINE });
      const b = contact({ id: "b", display_name: "Margaret Torres", name: "Margaret Torres", phone: OFFICE_LINE });
      const c = contact({ id: "c", display_name: "Margaret Okafor", name: "Margaret Okafor", phone: OFFICE_LINE });

      const out = buildVisibleContacts({ contacts: [], externalContacts: [a, b, c] });

      expect(idSet(out)).toEqual(new Set(["a", "b", "c"]));
    });
  });

  it("keeps duplicate externals, including name-only entries main deliberately keeps", () => {
    // Two name-only address-book cards with the same name. The removed pass kept
    // ONE. Each is a REACHABLE record with a source pill and an id the user can
    // select and assign, and they may simply be two different people — which is
    // exactly why BACKLOG-2316 removed name matching from the main process.
    const lucaA = contact({ id: "luca-a", display_name: "Luca Example", email: undefined, phone: undefined });
    const lucaB = contact({ id: "luca-b", display_name: "Luca Example", email: undefined, phone: undefined });
    const mara = contact({ id: "mara", display_name: "Mara Example", email: undefined, phone: undefined });

    const out = buildVisibleContacts({ contacts: [], externalContacts: [lucaA, lucaB, mara] });

    // Was: new Set(["luca-a", "mara"]).
    expect(idSet(out)).toEqual(new Set(["luca-a", "luca-b", "mara"]));
  });

  it("never merges two distinct IMPORTED DB rows that happen to share an email", () => {
    // Unchanged, and now true by construction rather than by a guarded branch:
    // a couple sharing one email are both real DB rows and must both render.
    const partnerA = contact({ id: "partner-a", display_name: "Partner A", email: "couple@example.test" });
    const partnerB = contact({ id: "partner-b", display_name: "Partner B", email: "couple@example.test" });
    const out = buildVisibleContacts({ contacts: [partnerA, partnerB] });
    expect(idSet(out)).toEqual(new Set(["partner-a", "partner-b"]));
  });

  it("still drops an EXACTLY repeated id — the same record twice is not a judgement", () => {
    // The one thing `assembleContacts` removes. It decides nothing about who
    // anyone is; it notices one row arriving twice, which is what keeps React
    // keys unique and what de-overlapped the deleted picker's union of its prop
    // with `searchContactsForSelection` (both project real `contacts.id`).
    const a = contact({ id: "same", display_name: "One Row", email: "one@example.test" });
    const alsoA = contact({ id: "same", display_name: "One Row", email: "one@example.test" });
    const other = contact({ id: "other", display_name: "Two Row", email: "two@example.test" });

    expect(idSet(buildVisibleContacts({ contacts: [a, alsoA, other] })))
      .toEqual(new Set(["same", "other"]));
    // Across the boundary too: a row in BOTH arrays appears once.
    expect(ids(buildVisibleContacts({ contacts: [a], externalContacts: [alsoA] })))
      .toEqual(["same"]);
  });

  it("preserves allEmails/allPhones on returned objects (BACKLOG-1270)", () => {
    const c = contact({ id: "keep", email: "p@example.test", allEmails: ["p@example.test", "s@example.test"], allPhones: ["555-0101", "555-0102"] });
    const out = buildVisibleContacts({ contacts: [c] });
    expect(out[0].allEmails).toEqual(["p@example.test", "s@example.test"]);
    expect(out[0].allPhones).toEqual(["555-0101", "555-0102"]);
    expect(out[0]).toBe(c); // same reference, never cloned
  });

  it("two rows sharing a stableIdentityKey both survive the SORT, not just the assembly", () => {
    // `projectOntoOrder` groups by `stableIdentityKey`, which is NOT unique. With
    // nothing upstream collapsing anymore, a Map<key, contact> there would drop
    // one of these — reintroducing the removed hiding rule inside the sort,
    // where it would be even harder to see.
    const partnerA = contact({ id: "partner-a", display_name: "Partner A", email: "couple@example.test" });
    const partnerB = contact({ id: "partner-b", display_name: "Partner B", email: "couple@example.test" });

    const out = buildVisibleContacts({ contacts: [partnerA, partnerB], sortOrder: "alphabetical" });
    expect(ids(out)).toEqual(["partner-a", "partner-b"]);
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
describe("buildVisibleContacts — nameless rows sort by the label they DISPLAY (BACKLOG-2466)", () => {
  it("the dedup key is NOT sentinel-aware — sorting must never make it so", () => {
    // THE pin. `sortName` is sentinel-aware; `normalizeName` must not become so.
    // If it did, a sentinel-named contact with no email and no phone would fall
    // through stableIdentityKey's chain to `i:${id}` — the DB UUID — and its
    // frozen orderKeys entry would change the moment it is imported, which is
    // the import-jump BACKLOG-2352/2355 exist to prevent. See
    // contactPickerList.ts:106.
    const sentinel = contact({ id: "sent", display_name: "Unknown", name: "Unknown" });
    expect(stableIdentityKey(sentinel)).toBe("n:unknown");
    expect(stableIdentityKey(sentinel)).not.toBe("i:sent");
  });

  it("a sentinel name leaves the alphabet instead of sorting under U", () => {
    // Since BACKLOG-2461 this row READS "+1 (415) 555-0100" on screen. It was
    // sorting under "unknown" — between Uber and Valdez — with nothing visible
    // explaining the position.
    const uber = contact({ id: "uber", display_name: "Uber Inc" });
    const valdez = contact({ id: "valdez", display_name: "Valdez" });
    const zed = contact({ id: "zed", display_name: "Zed Zulu" });
    const sentinel = contact({ id: "sentinel", display_name: "Unknown", phone: "+14155550100" });
    const out = buildVisibleContacts({
      contacts: [sentinel, zed, uber, valdez],
      sortOrder: "alphabetical",
    });
    expect(ids(out)).toEqual(["uber", "valdez", "zed", "sentinel"]);
  });

  it("nameless rows stay at the END, never hoisted to the top", () => {
    const nameless = contact({ id: "nameless", display_name: "", name: "", phone: "+14155550100" });
    const amy = contact({ id: "amy", display_name: "Amy Adams" });
    const zoe = contact({ id: "zoe", display_name: "Zoe Zhang" });
    expect(ids(buildVisibleContacts({ contacts: [nameless, zoe, amy], sortOrder: "alphabetical" })))
      .toEqual(["amy", "zoe", "nameless"]);
  });

  it("within the block they order by their displayed label, not by identity", () => {
    // Every other candidate key is set to the INVERSE of label order, so this
    // can only pass through `namelessSortKey`:
    //   - the ids "a-higher"/"z-lower" defeat a raw id tiebreaker;
    //   - the emails "a@x.com"/"z@x.com" defeat `compareIdentity`, which
    //     consults stableIdentityKey — EMAIL first — and would order these
    //     ["a-higher", "z-lower"], the opposite of the assertion.
    // The displayed label ignores the email (`contactDisplayLabel` takes the
    // phone first), so only the label produces the expected order.
    //
    // The earlier version of this test had no emails, which left both rows
    // keyed `p:<phone>` — and `compareIdentity` alone then produced the asserted
    // order, so it passed with `namelessSortKey` deleted. Verified red now:
    // see the PR's negative control.
    const higher = contact({ id: "a-higher", display_name: "", name: "", phone: "+14155550134", email: "a@x.com" });
    const lower = contact({ id: "z-lower", display_name: "", name: "", phone: "+14155550100", email: "z@x.com" });
    // "+1 (415) 555-0100" before "+1 (415) 555-0134".
    expect(ids(buildVisibleContacts({ contacts: [higher, lower], sortOrder: "alphabetical" })))
      .toEqual(["z-lower", "a-higher"]);
    // Determinism: the input order cannot change it.
    expect(ids(buildVisibleContacts({ contacts: [lower, higher], sortOrder: "alphabetical" })))
      .toEqual(["z-lower", "a-higher"]);
  });

  it("rows with NOTHING to show sort below rows that at least show something", () => {
    const blank = contact({ id: "blank", display_name: "", name: "" }); // renders "No name"
    const withPhone = contact({ id: "phone", display_name: "", name: "", phone: "+14155550100" });
    const withEmail = contact({ id: "email", display_name: "", name: "", email: "zoe@x.com" });
    const out = ids(buildVisibleContacts({ contacts: [blank, withEmail, withPhone], sortOrder: "alphabetical" }));
    expect(out[out.length - 1]).toBe("blank");
    // "+1 (415) 555-0100" collates before "zoe@x.com".
    expect(out).toEqual(["phone", "email", "blank"]);
  });

  it("is a TOTAL order across every sort tier, under every input permutation", () => {
    // The comparator now composes three tiers — hasName, then (placeholder,
    // label) for nameless rows, then compareIdentity. A non-total comparator
    // does not fail an assertion; it surfaces as INSTABILITY, an order that
    // depends on the input sequence Array.prototype.sort happened to see. The
    // only way to catch that is to shuffle.
    //
    // One contact per tier, plus a second named row so the named branch is
    // exercised too. All 5040 permutations must produce the identical order.
    const roster = [
      contact({ id: "amy", display_name: "Amy Adams" }),
      contact({ id: "zoe", display_name: "Zoe Zhang" }),
      contact({ id: "sentinel", display_name: "Unknown", phone: "+14155550100" }),
      contact({ id: "np-phone", display_name: "", name: "", phone: "+14155550134" }),
      contact({ id: "np-company", display_name: "", name: "", company: "Acme Realty" }),
      contact({ id: "np-email", display_name: "", name: "", email: "zoe@x.com" }),
      contact({ id: "blank", display_name: "", name: "" }),
    ];

    function permutations<T>(items: T[]): T[][] {
      if (items.length <= 1) return [items];
      const out: T[][] = [];
      items.forEach((item, i) => {
        const rest = [...items.slice(0, i), ...items.slice(i + 1)];
        for (const tail of permutations(rest)) out.push([item, ...tail]);
      });
      return out;
    }

    const all = permutations(roster);
    expect(all).toHaveLength(5040);

    for (const sortOrder of ["alphabetical", "recent"] as const) {
      // Every contact has null recency, so "recent" ties on every row and
      // delegates wholly to the alphabetical comparator.
      const expected = ids(buildVisibleContacts({ contacts: roster, sortOrder }));
      // Named rows A-Z; then nameless by displayed label — "+1 (415) 555-0100",
      // "+1 (415) 555-0134", "Acme Realty", "zoe@x.com"; then "No name" last.
      expect(expected).toEqual([
        "amy",
        "zoe",
        "sentinel",
        "np-phone",
        "np-company",
        "np-email",
        "blank",
      ]);
      for (const permutation of all) {
        expect(ids(buildVisibleContacts({ contacts: permutation, sortOrder }))).toEqual(expected);
      }
    }
  });

  it("the default RECENT view inherits it — that is where the founder looks", () => {
    // compareRecent delegates to compareAlphabetical on a timestamp tie, and a
    // list of never-contacted contacts ties on every row.
    const sentinel = contact({ id: "sentinel", display_name: "Unknown", phone: "+14155550100", last_communication_at: null });
    const amy = contact({ id: "amy", display_name: "Amy Adams", last_communication_at: null });
    expect(ids(buildVisibleContacts({ contacts: [sentinel, amy] }))).toEqual(["amy", "sentinel"]);
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
    // BACKLOG-2370: the "deduped against i1" row is now RENDERED — this list no
    // longer decides identity — so the count moved 3 -> 4. What the case is
    // actually about is unchanged and is the reason it stays: there is no
    // separate count channel that can disagree with the rows on screen.
    const imported = [
      contact({ id: "i1", email: "i1@example.test" }),
      contact({ id: "i2", email: "i2@example.test" }),
    ];
    const external = [
      contact({ id: "e-same-email", email: "I1@example.test" }),
      contact({ id: "e-new", email: "e@example.test" }),
    ];
    const out = buildVisibleContacts({ contacts: imported, externalContacts: external });
    expect(idSet(out)).toEqual(new Set(["i1", "i2", "e-same-email", "e-new"]));
    expect(out.length).toBe(4);
    // assembleContacts agrees (same engine stage).
    expect(assembleContacts(imported, external).length).toBe(4);
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
