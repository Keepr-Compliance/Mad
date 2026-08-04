/**
 * contactPickerList — the collapse EVIDENCE (BACKLOG-2459).
 *
 * The founder watched `picker: 1126 in -> dup-suppressed 21 -> shown 1105` and
 * said "a user must have a way to see that". These tests pin the half of the
 * dedup pass that used to be thrown away: which record was folded into which
 * row, and on what detail the two agreed.
 *
 * Every assertion is on EXACT ID SETS (house rule — never a bare count), and the
 * first block pins the thing that must NOT change: the rows themselves.
 */

import type { ExtendedContact } from "../../types/components";
import {
  assembleDedupedContacts,
  assembleDedupedContactsWithEvidence,
  type CollapsedContactRecord,
} from "../contactPickerList";

let seq = 0;
function contact(overrides: Partial<ExtendedContact> = {}): ExtendedContact {
  seq += 1;
  return {
    id: `c${seq}`,
    user_id: "u1",
    source: "contacts_app",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    display_name: `Contact ${seq}`,
    name: `Contact ${seq}`,
    ...overrides,
  } as ExtendedContact;
}

const ids = (list: ExtendedContact[]): string[] => list.map((c) => c.id);

/** keeper id -> exact set of folded record ids. */
function foldedIdSets(
  collapsed: Map<string, CollapsedContactRecord[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [keeperId, records] of collapsed) {
    out[keeperId] = records.map((r) => r.contact.id);
  }
  return out;
}

beforeEach(() => {
  seq = 0;
});

// ---------------------------------------------------------------------------
describe("assembleDedupedContactsWithEvidence — the rows are unchanged", () => {
  /**
   * `assembleDedupedContacts` is now a projection of the evidence-carrying
   * function. If the refactor moved a single row, every picker surface in the
   * app changed shape. Pinned on a case that exercises all three match rules at
   * once.
   */
  it("returns exactly what assembleDedupedContacts returns, in the same order", () => {
    const imported = [
      contact({ id: "db-alice", display_name: "Alice Example", email: "Alice@Example.test" }),
      contact({ id: "db-bea", display_name: "Bea Example", phone: "+1 (415) 555-0177" }),
    ];
    const external = [
      contact({ id: "ext-alice", display_name: "Alice Example", email: "alice@example.test" }),
      contact({ id: "ext-bea", display_name: "Bea Example", phone: "4155550177" }),
      contact({ id: "ext-nameonly-a", display_name: "Elm Example", email: "", phone: "" }),
      contact({ id: "ext-nameonly-b", display_name: "elm example", email: "", phone: "" }),
      contact({ id: "ext-distinct", display_name: "Fenn Example", email: "fenn@example.test" }),
    ];

    const plain = assembleDedupedContacts(imported, external);
    const withEvidence = assembleDedupedContactsWithEvidence(imported, external);

    expect(ids(plain)).toEqual([
      "db-alice",
      "db-bea",
      "ext-nameonly-a",
      "ext-distinct",
    ]);
    expect(ids(withEvidence.contacts)).toEqual(ids(plain));
    // Same object references, not clones — every downstream surface relies on it.
    withEvidence.contacts.forEach((c, i) => expect(c).toBe(plain[i]));
  });

  it("does not fold two SAVED contacts together, even when they share an email", () => {
    const a = contact({ id: "db-a", display_name: "A", email: "shared@example.test" });
    const b = contact({ id: "db-b", display_name: "B", email: "shared@example.test" });

    const result = assembleDedupedContactsWithEvidence([a, b], []);

    expect(ids(result.contacts)).toEqual(["db-a", "db-b"]);
    expect(foldedIdSets(result.collapsedByKeeperId)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
describe("assembleDedupedContactsWithEvidence — what was folded into what", () => {
  it("attributes an email collapse to the row that survived, naming the address as saved", () => {
    const keeper = contact({
      id: "db-alice",
      display_name: "Alice Example",
      email: "Alice.Example@Example.test",
    });
    const dropped = contact({
      id: "ext-alice",
      display_name: "Alice E",
      email: "alice.example@example.test",
    });

    const result = assembleDedupedContactsWithEvidence([keeper], [dropped]);

    expect(ids(result.contacts)).toEqual(["db-alice"]);
    expect(foldedIdSets(result.collapsedByKeeperId)).toEqual({ "db-alice": ["ext-alice"] });

    const record = result.collapsedByKeeperId.get("db-alice")?.[0];
    expect(record?.matchedOn).toBe("email");
    // The value the USER has saved on the dropped record, not the lowercased
    // comparison key — the sentence has to name something they can recognise.
    expect(record?.matchedValue).toBe("alice.example@example.test");
  });

  it("attributes a phone collapse, naming the number in the form it is stored", () => {
    const keeper = contact({
      id: "db-bea",
      display_name: "Bea Example",
      email: "",
      phone: "4155550177",
    });
    const dropped = contact({
      id: "ext-bea",
      display_name: "Bea Example",
      email: "",
      phone: "+1 (415) 555-0177",
    });

    const result = assembleDedupedContactsWithEvidence([keeper], [dropped]);

    expect(foldedIdSets(result.collapsedByKeeperId)).toEqual({ "db-bea": ["ext-bea"] });
    const record = result.collapsedByKeeperId.get("db-bea")?.[0];
    expect(record?.matchedOn).toBe("phone");
    expect(record?.matchedValue).toBe("+1 (415) 555-0177");
  });

  it("attributes a name-only collapse, naming the name as saved (not lowercased)", () => {
    const keeper = contact({ id: "ext-a", display_name: "Elm Example", email: "", phone: "" });
    const dropped = contact({ id: "ext-b", display_name: "elm example", email: "", phone: "" });

    const result = assembleDedupedContactsWithEvidence([], [keeper, dropped]);

    expect(ids(result.contacts)).toEqual(["ext-a"]);
    expect(foldedIdSets(result.collapsedByKeeperId)).toEqual({ "ext-a": ["ext-b"] });
    const record = result.collapsedByKeeperId.get("ext-a")?.[0];
    expect(record?.matchedOn).toBe("name");
    expect(record?.matchedValue).toBe("elm example");
  });

  it("keeps a shared office line from folding two DIFFERENT people together (BACKLOG-2416)", () => {
    // The name rule guards the phone rule. If this regressed, the evidence map
    // would happily report a collapse that must never happen.
    const keeper = contact({
      id: "ext-cleo",
      display_name: "Cleo Example",
      email: "",
      phone: "415-555-0100",
    });
    const other = contact({
      id: "ext-dov",
      display_name: "Dov Example",
      email: "",
      phone: "415-555-0100",
    });

    const result = assembleDedupedContactsWithEvidence([], [keeper, other]);

    expect(ids(result.contacts)).toEqual(["ext-cleo", "ext-dov"]);
    expect(foldedIdSets(result.collapsedByKeeperId)).toEqual({});
  });

  it("groups every record folded into one keeper under that keeper's id", () => {
    const keeper = contact({
      id: "db-alice",
      display_name: "Alice Example",
      email: "alice@example.test",
    });
    const dupA = contact({
      id: "ext-1",
      display_name: "Alice Example",
      email: "ALICE@Example.test",
    });
    const dupB = contact({
      id: "ext-2",
      display_name: "Alice Example",
      email: "alice@example.test",
      phone: "415-555-0155",
    });
    const unrelated = contact({
      id: "ext-3",
      display_name: "Fenn Example",
      email: "fenn@example.test",
    });

    const result = assembleDedupedContactsWithEvidence([keeper], [dupA, dupB, unrelated]);

    expect(ids(result.contacts)).toEqual(["db-alice", "ext-3"]);
    expect(foldedIdSets(result.collapsedByKeeperId)).toEqual({
      "db-alice": ["ext-1", "ext-2"],
    });
    // Suppression order is preserved, so the disclosure lists them the way the
    // pass encountered them rather than in an arbitrary Map order.
    expect(
      result.collapsedByKeeperId.get("db-alice")?.map((r) => r.contact.id),
    ).toEqual(["ext-1", "ext-2"]);
  });

  it("attributes a collapse to an EXTERNAL keeper when the survivor is itself external", () => {
    const first = contact({ id: "ext-first", display_name: "Fenn Example", email: "fenn@example.test" });
    const second = contact({ id: "ext-second", display_name: "F Example", email: "FENN@example.test" });

    const result = assembleDedupedContactsWithEvidence([], [first, second]);

    expect(ids(result.contacts)).toEqual(["ext-first"]);
    expect(foldedIdSets(result.collapsedByKeeperId)).toEqual({ "ext-first": ["ext-second"] });
  });

  it("reports nothing for a list with no duplicates at all (the common case)", () => {
    const a = contact({ id: "db-a", email: "a@example.test" });
    const b = contact({ id: "ext-b", email: "b@example.test" });

    const result = assembleDedupedContactsWithEvidence([a], [b]);

    expect(ids(result.contacts)).toEqual(["db-a", "ext-b"]);
    expect(result.collapsedByKeeperId.size).toBe(0);
    // Absent, not an empty array — the row renders nothing without a length check.
    expect(result.collapsedByKeeperId.get("db-a")).toBeUndefined();
  });
});
