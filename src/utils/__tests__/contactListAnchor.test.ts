/**
 * contactListAnchor — keeping the user's place when the list changes under them
 * (BACKLOG-2459).
 *
 * The founder's clause is the whole test suite: *"the place in the list the user
 * just was on should stay put — even if there were changes made to the list
 * since, maybe 2 got linked and one needed to be consolidated"*.
 *
 * Every assertion names the CONTACT the user lands on, never an index and never
 * an offset — because the entire point of the module is that an index is the
 * wrong thing to remember.
 */

import type { ExtendedContact } from "../../types/components";
import {
  contactsShareIdentity,
  resolveContactAnchor,
  scrollTopForAnchor,
  type ContactListAnchor,
} from "../contactListAnchor";

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

function anchorFor(
  c: ExtendedContact,
  order: ExtendedContact[],
  viewportOffset = 240,
): ContactListAnchor {
  return { contact: c, orderIds: order.map((x) => x.id), viewportOffset };
}

beforeEach(() => {
  seq = 0;
});

// ---------------------------------------------------------------------------
describe("contactsShareIdentity", () => {
  it("treats a shared email as the same person regardless of case or spacing", () => {
    const a = contact({ id: "a", email: " Alice@Example.test " });
    const b = contact({ id: "b", email: "alice@example.test", display_name: "A Example" });
    expect(contactsShareIdentity(a, b)).toBe(true);
  });

  it("matches on any of allEmails, not just the primary", () => {
    const a = contact({ id: "a", email: "work@example.test", allEmails: ["home@example.test"] });
    const b = contact({ id: "b", email: "home@example.test" });
    expect(contactsShareIdentity(a, b)).toBe(true);
  });

  it("matches a phone across formatting, but ONLY when the names are compatible", () => {
    const cleo = contact({
      id: "cleo",
      display_name: "Cleo Example",
      email: "",
      phone: "+1 (415) 555-0100",
    });
    const cleoAgain = contact({
      id: "cleo2",
      display_name: "Cleo Example",
      email: "",
      phone: "4155550100",
    });
    const dov = contact({
      id: "dov",
      display_name: "Dov Example",
      email: "",
      phone: "4155550100",
    });

    expect(contactsShareIdentity(cleo, cleoAgain)).toBe(true);
    // A shared office line is not a shared identity (BACKLOG-2416).
    expect(contactsShareIdentity(cleo, dov)).toBe(false);
  });

  it("uses the name only when NEITHER side has a stronger token", () => {
    const nameOnlyA = contact({ id: "a", display_name: "Elm Example", email: "", phone: "" });
    const nameOnlyB = contact({ id: "b", display_name: "elm example", email: "", phone: "" });
    expect(contactsShareIdentity(nameOnlyA, nameOnlyB)).toBe(true);

    // Same name, but one of them has an email — two people can share a name.
    const withEmail = contact({ id: "c", display_name: "Elm Example", email: "q@example.test" });
    expect(contactsShareIdentity(nameOnlyA, withEmail)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("resolveContactAnchor", () => {
  it("1. EXACT — returns the same contact when the list is unchanged", () => {
    const rows = [contact({ id: "a" }), contact({ id: "b" }), contact({ id: "c" })];
    const anchor = anchorFor(rows[1], rows);

    const result = resolveContactAnchor(rows, anchor);

    expect(result.match).toBe("exact");
    expect(result.contact?.id).toBe("b");
    expect(result.index).toBe(1);
  });

  it("1. EXACT — survives rows being inserted ABOVE it (the index moved, the identity did not)", () => {
    const before = [contact({ id: "a" }), contact({ id: "b" }), contact({ id: "c" })];
    const anchor = anchorFor(before[2], before);
    const after = [contact({ id: "new1" }), contact({ id: "new2" }), ...before];

    const result = resolveContactAnchor(after, anchor);

    expect(result.match).toBe("exact");
    expect(result.contact?.id).toBe("c");
    // The index it lands on is NOT the index it was opened at.
    expect(result.index).toBe(4);
  });

  it("2. SURVIVOR — lands on the merged contact after two records are linked", () => {
    // The founder's case. The user opens the external Alice Example; while the card is
    // open the two records are linked, so that row is gone and the list is
    // SHORTER. Landing on the merged contact is part of showing the merge.
    const externalAlice = contact({
      id: "ext-alice",
      display_name: "Alice Example",
      email: "alice@example.test",
      // An address-book row: not saved, still offering its import button.
      is_message_derived: true,
    });
    const before = [
      contact({ id: "row-a" }),
      externalAlice,
      contact({ id: "row-b" }),
      contact({ id: "row-c" }),
    ];
    const anchor = anchorFor(externalAlice, before);

    const mergedAlice = contact({
      id: "db-alice",
      display_name: "Alice Example",
      email: "Alice@Example.test",
    });
    const after = [
      before[0],
      mergedAlice, // one row where there were two
      before[2],
      before[3],
    ];

    const result = resolveContactAnchor(after, anchor);

    expect(result.match).toBe("survivor");
    expect(result.contact?.id).toBe("db-alice");
  });

  it("2. SURVIVOR — beats the positional answer when they disagree", () => {
    // This is the assertion that fails if anyone reintroduces offset/index
    // restoring: the row now sitting at the anchor's old INDEX is a different
    // person from the one the user was looking at.
    const externalAlice = contact({
      id: "ext-alice",
      display_name: "Alice Example",
      email: "alice@example.test",
      is_message_derived: true,
    });
    const before = [contact({ id: "row-a" }), externalAlice, contact({ id: "row-b" })];
    const anchor = anchorFor(externalAlice, before);

    const mergedAlice = contact({
      id: "db-alice",
      display_name: "Alice Example",
      email: "alice@example.test",
    });
    // Two rows above collapsed into one, so index 1 is now a stranger and the
    // merged Alice Example has moved DOWN.
    const after = [contact({ id: "row-a" }), before[2], mergedAlice];

    const result = resolveContactAnchor(after, anchor);

    expect(result.contact?.id).toBe("db-alice");
    expect(result.contact?.id).not.toBe(after[1].id);
  });

  it("2. SURVIVOR — an imported external contact is found under its NEW database id", () => {
    // Import swaps the row's id and keeps its email. Anchoring on the id alone
    // would lose the contact the user just created.
    const external = contact({
      id: "ext-1",
      display_name: "Fenn Example",
      email: "fenn@example.test",
      is_message_derived: true,
    });
    const before = [external, contact({ id: "row-b" })];
    const anchor = anchorFor(external, before);

    const imported = contact({ id: "db-99", display_name: "Fenn Example", email: "fenn@example.test" });
    const after = [imported, before[1]];

    const result = resolveContactAnchor(after, anchor);

    expect(result.match).toBe("survivor");
    expect(result.contact?.id).toBe("db-99");
  });

  it("3. NEIGHBOUR — a deleted contact lands on the row that closed the gap, not the top", () => {
    const removed = contact({ id: "gone", email: "gone@example.test" });
    const before = [
      contact({ id: "row-a", email: "a@example.test" }),
      contact({ id: "row-b", email: "b@example.test" }),
      removed,
      contact({ id: "row-d", email: "d@example.test" }),
      contact({ id: "row-e", email: "e@example.test" }),
    ];
    const anchor = anchorFor(removed, before);
    const after = [before[0], before[1], before[3], before[4]];

    const result = resolveContactAnchor(after, anchor);

    expect(result.match).toBe("neighbour");
    // Forward first: the row that now occupies the vacated slot.
    expect(result.contact?.id).toBe("row-d");
    expect(result.contact?.id).not.toBe("row-a");
  });

  it("3. NEIGHBOUR — falls BACKWARD when nothing below the anchor survived", () => {
    const removed = contact({ id: "gone", email: "gone@example.test" });
    const before = [
      contact({ id: "row-a", email: "a@example.test" }),
      contact({ id: "row-b", email: "b@example.test" }),
      removed,
      contact({ id: "row-d", email: "d@example.test" }),
    ];
    const anchor = anchorFor(removed, before);
    // Everything after the anchor is gone too (a filter narrowed the list).
    const after = [before[0], before[1]];

    const result = resolveContactAnchor(after, anchor);

    expect(result.match).toBe("neighbour");
    expect(result.contact?.id).toBe("row-b");
  });

  it("does NOT call a saved twin a survivor — the picker never merges two saved rows", () => {
    // BACKLOG-2459 SR issue 5. `assembleDedupedContactsWithEvidence` keeps BOTH
    // saved rows when they share an email (pinned by its own test), so if the
    // user deletes saved contact A, no merge happened and landing on saved
    // contact B would assert one that never occurred. It must fall through to
    // the neighbour rule, which claims nothing about identity.
    const savedA = contact({
      id: "db-a",
      display_name: "Alice Example",
      email: "shared@example.test",
    });
    const savedB = contact({
      id: "db-b",
      display_name: "Bea Example",
      email: "shared@example.test",
    });
    const other = contact({ id: "db-c", display_name: "Cleo Example", email: "cleo@example.test" });
    const anchor = anchorFor(savedA, [savedA, savedB, other]);

    const result = resolveContactAnchor([savedB, other], anchor);

    expect(result.match).toBe("neighbour");
    expect(result.contact?.id).toBe("db-b");

    // The SAME shape with an EXTERNAL anchor IS a survivor — that one really was
    // folded in. So this is the saved-vs-saved rule, not the survivor branch
    // being accidentally disabled.
    const externalA = contact({
      id: "ext-a",
      display_name: "Alice Example",
      email: "shared@example.test",
      is_message_derived: true,
    });
    const merged = resolveContactAnchor(
      [savedB, other],
      anchorFor(externalA, [externalA, savedB, other]),
    );

    expect(merged.match).toBe("survivor");
    expect(merged.contact?.id).toBe("db-b");
  });

  it("4. NONE — no identity match and no surviving neighbour resolves to nothing", () => {
    const removed = contact({ id: "gone", email: "gone@example.test" });
    const before = [removed];
    const anchor = anchorFor(removed, before);
    const after = [contact({ id: "brand-new", email: "new@example.test" })];

    const result = resolveContactAnchor(after, anchor);

    expect(result.match).toBe("none");
    expect(result.contact).toBeNull();
    expect(result.index).toBe(-1);
  });

  it("4. NONE — an empty list resolves to nothing rather than index 0", () => {
    const opened = contact({ id: "a" });
    const result = resolveContactAnchor([], anchorFor(opened, [opened]));

    expect(result.match).toBe("none");
    expect(result.index).toBe(-1);
  });

  it("prefers EXACT over SURVIVOR when both records are still on screen", () => {
    // Two saved contacts sharing an email are deliberately never merged by the
    // picker. The anchor must not wander to the other one.
    const opened = contact({ id: "db-a", display_name: "A", email: "shared@example.test" });
    const twin = contact({ id: "db-b", display_name: "B", email: "shared@example.test" });
    const rows = [twin, opened];

    const result = resolveContactAnchor(rows, anchorFor(opened, rows));

    expect(result.match).toBe("exact");
    expect(result.contact?.id).toBe("db-a");
  });
});

// ---------------------------------------------------------------------------
describe("scrollTopForAnchor", () => {
  it("returns the current position unchanged when the row is already where it was", () => {
    expect(
      scrollTopForAnchor({
        currentScrollTop: 8400,
        containerTop: 100,
        rowTop: 340,
        viewportOffset: 240,
      }),
    ).toBe(8400);
  });

  it("scrolls down by the amount the row rose", () => {
    // The row is now 150px higher in the container than it was, so the container
    // must scroll 150px further down to put it back.
    expect(
      scrollTopForAnchor({
        currentScrollTop: 8400,
        containerTop: 100,
        rowTop: 190,
        viewportOffset: 240,
      }),
    ).toBe(8250);
  });

  it("never returns a negative scroll position", () => {
    expect(
      scrollTopForAnchor({
        currentScrollTop: 20,
        containerTop: 100,
        rowTop: 120,
        viewportOffset: 900,
      }),
    ).toBe(0);
  });
});
