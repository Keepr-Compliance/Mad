/**
 * BACKLOG-2673 — the duplicate question composes no article with a name.
 *
 * The founder hit this at gate 4, check 18, on his own machine:
 *
 *   > Your Mac address book has **a** Ingrid Halvorsen with the same phone
 *   > number as this contact.
 *
 * `reasonFor` hardcoded `a ${sourceName}`. `sourceName` is a person's name out
 * of the user's own address book — an unbounded set, so no hardcoded article is
 * right for all of it.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS ONE NAME TEST HERE AND NOT THREE
 * ---------------------------------------------------------------------------
 * The obvious control set is "a vowel-initial name, a consonant-initial name,
 * and a name whose spelling and sound disagree". After the rewrite THOSE THREE
 * CANNOT DISTINGUISH ANYTHING: the sentence contains no article at all, so the
 * name is copied through verbatim and all three assertions are the same
 * assertion with different strings in it. A test that cannot fail is not a
 * control, and three of them dressed as a matrix is worse than one — it reads
 * as coverage.
 *
 * So: ONE assertion on the vowel-initial name the founder actually reported
 * ("Ingrid Halvorsen", the case that was broken), plus the negative that no
 * article precedes it. The consonant case is already pinned by the main suite
 * ("Nina Stone"), which is the one that used to pass while this was broken.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE REAL MATRIX IS
 * ---------------------------------------------------------------------------
 * The values that DO vary the output are the SOURCE LABELS, and that set is
 * finite and knowable. `contact_link_proposals.source_type` carries a CHECK
 * constraint (`contactIdentitySchemaSql.ts`) admitting exactly five values, and
 * `SOURCE_LABELS` in `contactLinkEvidence.ts` maps each to its label. Every one
 * of the five is composed below — that is the enumeration, derived by reading
 * the producer rather than by grepping for `"a "`.
 *
 * Two of the five are PLURAL ("Outlook contacts", "Google contacts"), and the
 * old frame `Your ${label} has` read *"Your Outlook contacts has"*. The rewrite
 * makes the verb agree with the singular subject, so that defect is pinned here
 * too rather than left to be rediscovered.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { ReviewDuplicatesModal } from "./ReviewDuplicatesModal";
import type { ContactReviewCluster } from "@/types/contactProvenance";

const USER = "u1";

/**
 * Same shape as `ReviewDuplicatesModal.test.tsx`, which transcribes it from
 * `getReviewQueue`. Kept in step with that file deliberately: a fixture that
 * drifts from the producer describes a state the app cannot emit.
 */
function item(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: "p-1",
    contactId: "c-daniel",
    contactName: "Daniel Haim",
    contactCompany: null,
    sourceType: "macos",
    sourceRecordId: "mac-ingrid",
    sourceLabel: "Mac address book",
    sourceName: "Ingrid Halvorsen",
    recordEmails: [],
    recordPhones: ["+14155550134"],
    reason: "identifier_reassigned",
    matchedOn: "phone",
    identity: "possibly_same_person",
    identityPhrase: "possibly the same person",
    relationship: "possibly_connected",
    relationshipPhrase: "possibly connected",
    evidence: {
      summary:
        "A record in your Mac address book carries the phone number …0134, which you also have saved against Daniel Haim.",
      details: ['The Mac address book entry is saved as "Ingrid Halvorsen".'],
      contactLabel: "Daniel Haim",
      sourceLabel: "Mac address book",
      sourceName: "Ingrid Halvorsen",
    },
    ...overrides,
  };
}

function cluster(overrides: Record<string, unknown> = {}): ContactReviewCluster {
  return {
    clusterKey: "contact:c-daniel",
    question: 'Is "Ingrid Halvorsen" the same person as Daniel Haim?',
    exclusive: false,
    items: [item()],
    ...overrides,
  } as unknown as ContactReviewCluster;
}

async function reasonText(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
    success: true,
    clusters: [cluster({ items: [item(overrides)] })],
  });
  render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
  return (await screen.findByTestId("review-reason-c-daniel")).textContent ?? "";
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("BACKLOG-2673 — the reason sentence composes no article with a name", () => {
  it("names the vowel-initial record the founder reported, with no article before it", async () => {
    const text = await reasonText();

    // The founder's exact case. Exact sentence, not a substring — a substring
    // assertion would survive the very defect this file exists for.
    expect(text).toBe(
      "Ingrid Halvorsen in your Mac address book has the same phone number as this contact.",
    );

    // The defect stated as a negative, so a future rewrite that reintroduces an
    // article in front of the name fails here even if the wording moves.
    expect(text).not.toMatch(/\b(a|an|A|An)\s+Ingrid\b/);
  });

  /**
   * Falls back to a hardcoded noun, so the article binds to a word this code
   * owns rather than to anything interpolated. The queue can carry a nameless
   * external record (name-less rows are ~18-in-1,124 on a verified store,
   * BACKLOG-2461), so this branch ships.
   */
  it("says 'A record' when the external record has no name", async () => {
    expect(await reasonText({ sourceName: null })).toBe(
      "A record in your Mac address book has the same phone number as this contact.",
    );
  });

  it("treats a whitespace-only name as no name", async () => {
    expect(await reasonText({ sourceName: "   " })).toBe(
      "A record in your Mac address book has the same phone number as this contact.",
    );
  });

  /**
   * THE ENUMERATION. All five `source_type` values the proposals table admits,
   * with the labels their producer emits. This is the matrix that can actually
   * differ, unlike three spellings of a name.
   */
  it.each([
    ["macos", "Mac address book"],
    ["iphone", "iPhone"],
    ["outlook", "Outlook contacts"],
    ["google_contacts", "Google contacts"],
    ["android_sync", "Android phone"],
  ])("reads correctly for source_type %s (%s)", async (sourceType, sourceLabel) => {
    const text = await reasonText({ sourceType, sourceLabel });

    expect(text).toBe(
      `Ingrid Halvorsen in your ${sourceLabel} has the same phone number as this contact.`,
    );

    // No article anywhere before the label either — the second half of the same
    // class of bug (`a ${sourceLabel}`), which "a iPhone entry" used to hit.
    expect(text).not.toMatch(new RegExp(`\\b(a|an|A|An)\\s+${sourceLabel}\\b`));

    // LEADS WITH THE NAME, which is the property the rewrite is for — the user
    // is deciding about a person, not about an address book.
    expect(text).toMatch(/^Ingrid Halvorsen\b/);

    // SUBJECT–VERB AGREEMENT. The old frame was `Your ${label} has ${who}`, and
    // two of these five labels are PLURAL, so it read "Your Outlook contacts
    // has". The verb now agrees with the singular name. Asserted as the absence
    // of the old frame: `not.toContain(`${sourceLabel} has`)` would be a test
    // that cannot pass, because the new sentence contains exactly that
    // substring with "has" correctly agreeing with the name in front of it.
    expect(text).not.toContain(`Your ${sourceLabel} has`);
  });

  /**
   * The other three `matched_on` branches use the same subject, so they are
   * asserted for the shape rather than re-asserting the whole enumeration.
   */
  it.each([
    [
      "email",
      "Ingrid Halvorsen in your Mac address book has the same email address as this contact.",
    ],
    [
      "name",
      "Ingrid Halvorsen in your Mac address book has the same full name as this contact. The name is all that matched.",
    ],
    [
      "unique_name",
      "Ingrid Halvorsen in your Mac address book has the same full name as this contact. The name is all that matched.",
    ],
    ["something_else", "Ingrid Halvorsen in your Mac address book could be this contact."],
  ])("leads with the name on matched_on=%s", async (matchedOn, expected) => {
    expect(await reasonText({ matchedOn })).toBe(expected);
  });
});
