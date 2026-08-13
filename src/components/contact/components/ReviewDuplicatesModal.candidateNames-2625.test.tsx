/**
 * BACKLOG-2625 — THE CANDIDATE ROWS DID NOT SAY WHO THEY WERE.
 *
 * ===========================================================================
 * THE FOUNDER'S SCREEN
 * ===========================================================================
 * He imported one contact, four questions were filed, and the card read:
 *
 *   Mac address book   bianca@example.com
 *   Mac address book   +1 (503) 555-0130
 *   Mac address book   bianca@example.com
 *   Mac address book   +1 (503) 555-0130
 *
 * Four DIFFERENT PEOPLE, rendered as two byte-identical pairs, under a heading
 * asking him to answer *"each one on its own"*.
 *
 * The row's two fields — source and matched value — identify a record only while
 * candidates come from DIFFERENT sources with DIFFERENT values, which is what
 * his own mock drew. Four records out of ONE address book matching on TWO shared
 * values collapses that identifier entirely.
 *
 * ===========================================================================
 * THE RULE, AND ITS TWO REJECTED NEIGHBOURS
 * ===========================================================================
 * The row carries the NAME, the SOURCE and the MATCHED VALUE. When that triple
 * is not unique among the candidates on screen, the first differing field is
 * added — organisation, then the other phone or email.
 *
 * A FALLBACK, NOT A DEFAULT. He rejected showing everything (*"the card gets
 * tall fast at four candidates"*) as firmly as he rejected leaving identical
 * rows identical, so the single-candidate case must gain nothing — asserted
 * below by naming the fields a row renders, not by counting them.
 *
 * AND NEVER PROSE. Rejected twice: *"at five candidates that is ten sentences
 * saying what the header already made."*
 *
 * ===========================================================================
 * SCOPE
 * ===========================================================================
 * The queue's candidate rows ONLY. A comment widened this item to the contacts
 * list and the founder narrowed it back the same day — *"I can tell them apart,
 * one has a pill says combined"* — because the contact carries a record count
 * and a badge while a rejected address-book record carries neither. That is
 * already a visible difference and nothing is added there.
 *
 * Fixtures use `example.com` and `+1 <area> 555-01xx`, 555 in the exchange slot.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { ReviewDuplicatesModal } from "./ReviewDuplicatesModal";
import type { ContactReviewCluster } from "@/types/contactProvenance";

const USER = "u1";

/**
 * The shape `getReviewQueue` really returns, TRANSCRIBED from the producer —
 * same rule as the sibling suite. `sourceCompany` is the field this item adds;
 * it is asserted against the real reader in
 * `electron/services/__tests__/contactLinkReview.test.ts`, so this fixture
 * cannot drift into describing a state the queue never emits.
 */
function item(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: "p-1",
    contactId: "c-bianca",
    contactName: "Bianca Okafor",
    contactCompany: null,
    sourceType: "macos",
    sourceRecordId: "mac-1",
    sourceLabel: "Mac address book",
    sourceName: "Bianca Okafor",
    sourceCompany: null,
    recordEmails: ["bianca@example.com"],
    recordPhones: ["+1 (503) 555-0130"],
    reason: "name_not_unique",
    matchedOn: "email",
    identity: "possibly_same_person",
    identityPhrase: "possibly the same person",
    relationship: "possibly_connected",
    relationshipPhrase: "possibly connected",
    evidence: null,
    ...overrides,
  };
}

function clusterOf(items: ReturnType<typeof item>[]): ContactReviewCluster {
  return {
    clusterKey: "contact:c-bianca",
    question: "Which of these is Bianca Okafor?",
    exclusive: false,
    items,
  } as unknown as ContactReviewCluster;
}

function mountWith(items: ReturnType<typeof item>[]) {
  jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
    success: true,
    clusters: [clusterOf(items)],
  });
  return render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
}

/** The fields a row actually rendered, so "absent" and "blank" cannot be confused. */
function fieldsOf(proposalId: string) {
  return {
    name: screen.queryByTestId(`review-name-${proposalId}`)?.textContent ?? null,
    source: screen.queryByTestId(`review-source-${proposalId}`)?.textContent ?? null,
    value: screen.queryByTestId(`review-value-${proposalId}`)?.textContent ?? null,
    extra: screen.queryByTestId(`review-extra-${proposalId}`)?.textContent ?? null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("candidate rows say who they are (BACKLOG-2625)", () => {
  /**
   * CONTROL 4 — FOUR DISTINCT NAMES, AND NO FALLBACK FIRING.
   *
   * The founder's exact case: four records, one address book, matching on two
   * shared values. Two match the email and two the phone — the matcher is
   * correct and untouched; only the row's content was insufficient.
   *
   * The NAME SET is asserted, not the row count, because four rows reading the
   * same thing is precisely the defect. And the extra field is asserted ABSENT
   * on every row, so the fallback cannot quietly fire where it is not needed.
   *
   * OBSERVED RED: deleting the `review-name-*` element renders the founder's own
   * screen back — `Expected "Bianca Okafor", received null`.
   */
  it("renders four different people as four different names, adding nothing else", async () => {
    mountWith([
      item({
        proposalId: "p-vance",
        sourceName: "Bianca Okafor",
        sourceCompany: "Okafor & Co Realty",
        matchedOn: "email",
        recordEmails: ["bianca@example.com"],
        recordPhones: ["+1 (503) 555-0131"],
      }),
      item({
        proposalId: "p-roz",
        sourceName: "Bibi Okafor",
        matchedOn: "phone",
        recordEmails: [],
        recordPhones: ["+1 (503) 555-0130"],
      }),
      item({
        proposalId: "p-hale",
        sourceName: "Bianca Okafor-Hale",
        matchedOn: "email",
        recordEmails: ["bianca@example.com"],
        recordPhones: [],
      }),
      item({
        proposalId: "p-plain",
        sourceName: "Bianca Hale",
        matchedOn: "phone",
        recordEmails: [],
        recordPhones: ["+1 (503) 555-0130"],
      }),
    ]);

    expect(await screen.findByTestId("review-name-p-vance")).toBeInTheDocument();

    const names = ["p-vance", "p-roz", "p-hale", "p-plain"].map(
      (id) => fieldsOf(id).name,
    );
    expect(new Set(names)).toEqual(
      new Set(["Bianca Okafor", "Bibi Okafor", "Bianca Okafor-Hale", "Bianca Hale"]),
    );

    // THE FALLBACK MUST NOT FIRE. Four unique names means four unique triples,
    // so no row needs a second field — including the one that HOLDS a company.
    for (const id of ["p-vance", "p-roz", "p-hale", "p-plain"]) {
      expect(fieldsOf(id).extra).toBeNull();
    }
  });

  /**
   * CONTROL 5 — WHEN THE TRIPLE COLLIDES, THE FIRST DIFFERING FIELD IS ADDED,
   * AND WHICH ONE IT IS IS ASSERTED.
   *
   * His harder case, and the one the fixture set contains: two records both
   * named `Bianca Okafor`, both from the Mac address book, both matching on
   * `bianca@example.com`. They differ by organisation and by phone; organisation
   * is first, so organisation is what appears.
   *
   * Asserting merely "the rows differ" would pass on a row index, a colour, or
   * anything else — so the exact string is named, on both rows.
   *
   * OBSERVED RED: returning the phone before the company reads
   * `Expected "Okafor & Co Realty", received "+1 (503) 555-0131"` — the rows are
   * still distinguishable, and still wrong.
   */
  it("adds the organisation when name, source and matched value all collide", async () => {
    mountWith([
      item({
        proposalId: "p-realty",
        sourceName: "Bianca Okafor",
        sourceCompany: "Okafor & Co Realty",
        matchedOn: "email",
        recordEmails: ["bianca@example.com"],
        recordPhones: ["+1 (503) 555-0131"],
      }),
      item({
        proposalId: "p-solo",
        sourceName: "Bianca Okafor",
        sourceCompany: "Harbourline Escrow",
        matchedOn: "email",
        recordEmails: ["bianca@example.com"],
        recordPhones: ["+1 (503) 555-0132"],
      }),
    ]);

    expect(await screen.findByTestId("review-name-p-realty")).toBeInTheDocument();

    expect(fieldsOf("p-realty")).toEqual({
      name: "Bianca Okafor",
      source: "Mac address book",
      value: "bianca@example.com",
      extra: "Okafor & Co Realty",
    });
    expect(fieldsOf("p-solo").extra).toBe("Harbourline Escrow");
  });

  /**
   * THE SECOND RUNG OF THE LADDER — organisation cannot separate them, so the
   * identifier the matched value is NOT does.
   *
   * Both records are `Bianca Okafor` at the same firm, both matched on the same
   * email. The phone is the first field left that differs, and it is a VALUE,
   * not a sentence.
   *
   * OBSERVED RED: stopping after the organisation rung leaves both rows with no
   * extra field at all — `Expected "+1 (503) 555-0131", received null` — which
   * is the founder's two identical rows, restored.
   */
  it("falls through to the other identifier when the organisation matches too", async () => {
    mountWith([
      item({
        proposalId: "p-a",
        sourceName: "Bianca Okafor",
        sourceCompany: "Okafor & Co Realty",
        matchedOn: "email",
        recordEmails: ["bianca@example.com"],
        recordPhones: ["+1 (503) 555-0131"],
      }),
      item({
        proposalId: "p-b",
        sourceName: "Bianca Okafor",
        sourceCompany: "Okafor & Co Realty",
        matchedOn: "email",
        recordEmails: ["bianca@example.com"],
        recordPhones: ["+1 (503) 555-0132"],
      }),
    ]);

    expect(await screen.findByTestId("review-name-p-a")).toBeInTheDocument();

    expect(fieldsOf("p-a").extra).toBe("+1 (503) 555-0131");
    expect(fieldsOf("p-b").extra).toBe("+1 (503) 555-0132");
    // AND STILL NOT PROSE. The added field is the value itself, with no sentence
    // wrapped round it — rejected twice, so asserted rather than remembered.
    expect(fieldsOf("p-a").extra).not.toMatch(/[a-z]{4}/);
  });

  /**
   * CONTROL 6 — THE COMMON SHAPE GAINS NOTHING.
   *
   * One candidate can never collide with another, so it can never earn a second
   * field. This is the guard on *"the card gets tall fast"*, and it is asserted
   * by naming every field the row renders rather than by counting elements — a
   * count passes while rendering the wrong thing.
   *
   * The record HOLDS a company and a phone, so a rule that added fields
   * unconditionally would have both to add. It adds neither.
   */
  it("adds no second field to a single candidate that has one to spare", async () => {
    mountWith([
      item({
        proposalId: "p-only",
        sourceName: "Petra Lindqvist",
        sourceCompany: "Northshore Title",
        matchedOn: "email",
        recordEmails: ["petra@example.com"],
        recordPhones: ["+1 (503) 555-0144"],
      }),
    ]);

    expect(await screen.findByTestId("review-name-p-only")).toBeInTheDocument();

    expect(fieldsOf("p-only")).toEqual({
      name: "Petra Lindqvist",
      source: "Mac address book",
      value: "petra@example.com",
      extra: null,
    });
  });

  /**
   * A COLLIDING PAIR DOES NOT MAKE THE WHOLE CARD NOISY.
   *
   * Three candidates, two of which read alike. Only the two gain a field; the
   * third is already unique and is left as it was. Without this, "add a field on
   * collision" and "add a field to every row on a card that has one" both pass
   * every other test here.
   *
   * OBSERVED RED: computing the fallback per-CARD rather than per-ROW gives the
   * unique row an extra field too — `Expected null, received "Northshore Title"`.
   */
  it("gives the extra field only to the rows that collide", async () => {
    mountWith([
      item({
        proposalId: "p-twin-a",
        sourceName: "Bianca Okafor",
        sourceCompany: "Okafor & Co Realty",
        matchedOn: "email",
        recordEmails: ["bianca@example.com"],
      }),
      item({
        proposalId: "p-twin-b",
        sourceName: "Bianca Okafor",
        sourceCompany: "Harbourline Escrow",
        matchedOn: "email",
        recordEmails: ["bianca@example.com"],
      }),
      item({
        proposalId: "p-unique",
        sourceName: "Petra Lindqvist",
        sourceCompany: "Northshore Title",
        matchedOn: "email",
        recordEmails: ["petra@example.com"],
      }),
    ]);

    expect(await screen.findByTestId("review-name-p-unique")).toBeInTheDocument();

    expect(fieldsOf("p-twin-a").extra).toBe("Okafor & Co Realty");
    expect(fieldsOf("p-twin-b").extra).toBe("Harbourline Escrow");
    expect(fieldsOf("p-unique").extra).toBeNull();
  });

  /**
   * GENUINELY INDISTINGUISHABLE RECORDS — his control 3: *"state what happens.
   * Do not invent a disambiguator that misleads."*
   *
   * Two address-book entries alike in name, organisation, every email and every
   * phone ARE indistinguishable, and the screen says so by adding nothing. A
   * fabricated difference here would be the screen lying about the only thing it
   * is for.
   *
   * RAISED, not silently accepted: two records identical in every field the
   * address book holds are almost certainly the same record duplicated, and the
   * user is being asked a question that has no answerable difference. That is a
   * matcher-side observation and it is recorded on BACKLOG-2625 rather than
   * papered over here.
   */
  it("adds nothing when two records are identical in every field they hold", async () => {
    mountWith([
      item({
        proposalId: "p-same-1",
        sourceName: "Bianca Okafor",
        sourceCompany: "Okafor & Co Realty",
        matchedOn: "email",
        recordEmails: ["bianca@example.com"],
        recordPhones: ["+1 (503) 555-0130"],
      }),
      item({
        proposalId: "p-same-2",
        sourceName: "Bianca Okafor",
        sourceCompany: "Okafor & Co Realty",
        matchedOn: "email",
        recordEmails: ["bianca@example.com"],
        recordPhones: ["+1 (503) 555-0130"],
      }),
    ]);

    expect(await screen.findByTestId("review-name-p-same-1")).toBeInTheDocument();

    expect(fieldsOf("p-same-1").extra).toBeNull();
    expect(fieldsOf("p-same-2").extra).toBeNull();
    // The rows still say WHO they are — the name is unconditional, so the
    // failure mode is "these two look alike", not "these have no identity".
    expect(fieldsOf("p-same-1").name).toBe("Bianca Okafor");
  });

  /**
   * A nameless record falls back to the contact's name rather than to a
   * placeholder. 18 of 1,124 macOS contacts on a verified store have no name
   * (BACKLOG-2461), and "the Bianca Okafor this might be" is truer than
   * "Unknown" — which would also make every nameless candidate read alike, the
   * exact defect this item is about.
   */
  it("falls back to the contact's name rather than to a placeholder", async () => {
    mountWith([
      item({ proposalId: "p-nameless", sourceName: null, contactName: "Bianca Okafor" }),
    ]);

    expect(await screen.findByTestId("review-name-p-nameless")).toHaveTextContent(
      "Bianca Okafor",
    );
  });
});
