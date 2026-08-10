/**
 * BACKLOG-2410 — the review surface.
 * BACKLOG-2502 R2 — the tucked review card.
 *
 * Pins the things the founder was specific about: the evidence is shown in
 * WORDS and never as a score, the reason IS the heading, and every candidate
 * answers on its own.
 *
 * Assertions name exact proposal ids, exact contact ids and exact strings. A
 * count assertion would pass while rendering the wrong question.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReviewDuplicatesModal } from "./ReviewDuplicatesModal";
import type { ContactReviewCluster } from "@/types/contactProvenance";

const USER = "u1";

/**
 * The shape `getReviewQueue` really returns, TRANSCRIBED from the producer.
 *
 * `recordPhones`/`recordEmails`/`contactCompany` are asserted against the real
 * linker in `electron/services/__tests__/contactLinkReview.test.ts` ("carries
 * the candidate's own values and the contact's company"); the phone below is the
 * same value that test observes, so this fixture cannot drift into describing a
 * state the producer never emits.
 */
function item(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: "p-1",
    contactId: "c-daniel",
    contactName: "Daniel Haim",
    contactCompany: null,
    sourceType: "macos",
    sourceRecordId: "mac-lilly",
    sourceLabel: "Mac address book",
    sourceName: "Nina Stone",
    recordEmails: [],
    recordPhones: ["+14155550134"],
    reason: "identifier_reassigned",
    // BACKLOG-2502: `matched_on` as the producer writes it — the crosswalk's own
    // vocabulary (`email` | `phone` | `name` | `unique_name`), copied onto the
    // item by `getReviewQueue`. This fixture's evidence describes a phone match,
    // so the field agrees with the prose it replaces.
    matchedOn: "phone",
    identity: "possibly_same_person",
    identityPhrase: "possibly the same person",
    relationship: "possibly_connected",
    relationshipPhrase: "possibly connected",
    evidence: {
      summary:
        "A record in your Mac address book carries the phone number …0134, which you also have saved against Daniel Haim.",
      details: ['The Mac address book entry is saved as "Nina Stone".'],
      contactLabel: "Daniel Haim",
      sourceLabel: "Mac address book",
      sourceName: "Nina Stone",
    },
    ...overrides,
  };
}

function cluster(overrides: Record<string, unknown> = {}): ContactReviewCluster {
  return {
    clusterKey: "contact:c-daniel",
    question: 'Is "Nina Stone" the same person as Daniel Haim?',
    exclusive: false,
    items: [item()],
    ...overrides,
  } as unknown as ContactReviewCluster;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ReviewDuplicatesModal", () => {
  /**
   * BACKLOG-2502 — THE CARD NO LONGER PRINTS THE EVIDENCE, AND THAT IS THE POINT.
   *
   * The founder opened this at five candidates and got roughly 500 words:
   * *"the window that pops up is very verbos"*. Six blocks per candidate — a
   * frozen-audit summary, three detail sentences, and two hedged axis labels.
   *
   * The evidence is NOT deleted. It is frozen in the proposal's `evidence_json`
   * and now renders behind the compare screen's "How we decided this", which is
   * where he asked for it: *"you can add the verbose description that explains
   * why in a button on the compare screens"*.
   *
   * The no-score guarantee did not move with it — it is asserted here, on what
   * the card DOES show, because a screen that reintroduced a percentage would do
   * it in the heading rather than in a panel nobody opened.
   */
  it("leads with the reason, in words, with no score and no paragraph", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [cluster()],
    });

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);

    // THE REASON IS THE HEADING. Exact sentence, not a substring: a heading that
    // drifted into hedging again would still contain these words.
    expect((await screen.findByTestId("review-reason-c-daniel")).textContent).toBe(
      "Your Mac address book has a Nina Stone with the same phone number as this contact.",
    );

    // CONTROL: restore the evidence block and this goes red.
    expect(screen.queryByTestId("review-evidence-p-1")).not.toBeInTheDocument();
    const modal = screen.getByTestId("review-duplicates-modal");
    expect(modal.textContent).not.toMatch(/\d+%|0\.\d+|confidence/i);
    // The frozen-audit sentence is made ONCE, by the header — not per candidate.
    expect(modal.textContent).not.toContain("Nothing has been linked.");
  });

  /**
   * "POSSIBLE DUPLICATE N" IS GONE, AND SO IS THE HEDGE THAT REPLACED IT.
   *
   * Founder, on the design: *"'Possibly the same person' said nothing you could
   * act on; the reason tells you what to weigh"*. The wrapper label and the
   * identity phrase both told the user what they already knew — that this is the
   * duplicates list — while the thing they had to weigh stayed off screen.
   */
  it("labels neither the card nor the axes", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [
        cluster({
          items: [item({ relationship: "connected", relationshipPhrase: "connected" })],
        }),
      ],
    });

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    await screen.findByTestId("review-item-p-1");

    const modal = screen.getByTestId("review-duplicates-modal");
    // CONTROL: restore the "Possible duplicate" wrapper heading, or either axis
    // label, and this goes red. The modal's own <h2> is "Possible duplicates" —
    // plural, once, in the header — so the singular is what pins the wrapper.
    expect(screen.queryByText(/Possible duplicate \d/)).not.toBeInTheDocument();
    expect(modal.textContent).not.toContain("possibly the same person");
    expect(modal.textContent).not.toContain("possibly connected");
    expect(modal.textContent).not.toContain("Identity:");
    expect(modal.textContent).not.toContain("Relationship:");
    expect(screen.queryByTestId("review-identity-p-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("review-relationship-p-1")).not.toBeInTheDocument();
  });

  /**
   * THE CANDIDATE ROW SHOWS A VALUE, NOT A DESCRIPTION OF ONE.
   *
   * The old row said "matched on the same phone number". With two candidates
   * that sentence is identical on both, and the user cannot tell them apart —
   * which is the case the founder's design puts the value there for.
   */
  it("shows each candidate's source and its own value", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [cluster()],
    });

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);

    expect((await screen.findByTestId("review-source-p-1")).textContent).toBe("Mac address book");
    // The value itself — the evidence prose masks it to "…0134", the card does
    // not, because this is the thing being judged.
    expect(screen.getByTestId("review-value-p-1").textContent).toBe("+14155550134");
  });

  /**
   * THE CONTACT CARD, AND THE SUBLINE THAT IS HONEST ABOUT WHAT IT KNOWS.
   *
   * The design draws a transaction role ("Client (Buyer/Seller)"). This queue is
   * not scoped to a transaction, so the company stands in, and an absent company
   * renders NOTHING rather than a placeholder.
   */
  it("renders the contact card with its company, or with no subline at all", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [cluster({ items: [item({ contactCompany: "Blue Spaces LLC" })] })],
    });

    const { unmount } = render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);

    expect((await screen.findByTestId("review-contact-name-c-daniel")).textContent).toBe(
      "Daniel Haim",
    );
    expect(screen.getByTestId("review-contact-company-c-daniel").textContent).toBe(
      "Blue Spaces LLC",
    );
    unmount();

    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [cluster()],
    });
    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    await screen.findByTestId("review-contact-name-c-daniel");
    // CONTROL: render a placeholder subline and this goes red.
    expect(screen.queryByTestId("review-contact-company-c-daniel")).not.toBeInTheDocument();
  });

  /**
   * MULTIPLE CANDIDATES STACK UNDER ONE CONTACT, AND ANSWER INDEPENDENTLY.
   *
   * Founder: *"Accepting Outlook does not decide the Mac record. With two
   * records that could both be him, they usually both are."*
   *
   * The two candidates arrive in SEPARATE clusters — the linker clusters by its
   * own reasoning, and two independent name matches on one contact are two
   * clusters — which is precisely why the card groups by CONTACT and not by
   * cluster. CONTROL: group by `clusterKey` again and this renders two cards.
   */
  it("stacks two candidates on one card and answers only the one clicked", async () => {
    jest
      .mocked(window.api.contacts.getReviewQueue)
      .mockResolvedValueOnce({
        success: true,
        clusters: [
          cluster({
            clusterKey: "name:daniel-haim",
            items: [
              item({
                proposalId: "p-out",
                sourceType: "outlook",
                sourceRecordId: "out-1",
                sourceLabel: "Outlook contacts",
                matchedOn: "name",
                recordEmails: ["dorian@example.com"],
                recordPhones: [],
              }),
            ],
          }),
          cluster({
            clusterKey: "name:daniel-haim-2",
            items: [
              item({
                proposalId: "p-mac",
                sourceRecordId: "mac-2",
                matchedOn: "name",
                recordEmails: [],
                recordPhones: ["+14155550188"],
              }),
            ],
          }),
        ],
      })
      .mockResolvedValueOnce({ success: true, clusters: [] });
    jest.mocked(window.api.contacts.confirmLink).mockResolvedValue({ success: true, linked: true });

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);

    // ONE card, both candidates, each with its OWN source and value.
    await screen.findByTestId("review-contact-c-daniel");
    expect(screen.getAllByTestId(/^review-contact-c-/)).toHaveLength(1);
    expect(screen.getByTestId("review-source-p-out").textContent).toBe("Outlook contacts");
    expect(screen.getByTestId("review-value-p-out").textContent).toBe("dorian@example.com");
    expect(screen.getByTestId("review-source-p-mac").textContent).toBe("Mac address book");
    expect(screen.getByTestId("review-value-p-mac").textContent).toBe("+14155550188");

    // The reason counts the candidates rather than labelling them.
    expect(screen.getByTestId("review-reason-c-daniel").textContent).toBe(
      "Two records share this name. Accept the ones that are this Daniel.",
    );

    // Answering the Outlook record must not decide the Mac one.
    fireEvent.click(screen.getByTestId("review-confirm-p-out"));
    await waitFor(() =>
      expect(window.api.contacts.confirmLink).toHaveBeenCalledWith(USER, "p-out"),
    );
    expect(window.api.contacts.confirmLink).toHaveBeenCalledTimes(1);
    expect(window.api.contacts.rejectLink).not.toHaveBeenCalled();
  });

  it("confirms the exact proposal clicked and refreshes", async () => {
    jest.mocked(window.api.contacts.getReviewQueue)
      .mockResolvedValueOnce({
        success: true,
        clusters: [cluster({ items: [item(), item({ proposalId: "p-2", contactId: "c-other" })] })],
      })
      .mockResolvedValueOnce({ success: true, clusters: [] });
    jest.mocked(window.api.contacts.confirmLink).mockResolvedValue({ success: true, linked: true });
    const onResolved = jest.fn();

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} onResolved={onResolved} />);

    fireEvent.click(await screen.findByTestId("review-confirm-p-2"));

    await waitFor(() => expect(window.api.contacts.confirmLink).toHaveBeenCalledWith(USER, "p-2"));
    expect(window.api.contacts.confirmLink).toHaveBeenCalledTimes(1);
    expect(window.api.contacts.rejectLink).not.toHaveBeenCalled();
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    // Reloaded rather than spliced locally — a cluster answer can settle
    // siblings only the main process knows about.
    await waitFor(() => expect(window.api.contacts.getReviewQueue).toHaveBeenCalledTimes(2));
  });

  it("rejects the exact proposal clicked", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [cluster()],
    });
    jest.mocked(window.api.contacts.rejectLink).mockResolvedValue({ success: true });

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByTestId("review-reject-p-1"));

    await waitFor(() => expect(window.api.contacts.rejectLink).toHaveBeenCalledWith(USER, "p-1"));
    expect(window.api.contacts.confirmLink).not.toHaveBeenCalled();
  });

  /**
   * "SAME PERSON" AND "NOT THIS PERSON", NEVER "APPROVE".
   *
   * Founder: *"approve reads like sign-off on a document. This is you saying two
   * records are one person."* — and "Not this person" is already the exact
   * phrase the contact card uses to detach a source. One phrase for one concept,
   * in both places. The buttons are icon-only, so the words live in the
   * accessible name and there is nowhere else for them to be right.
   */
  it("names the three actions the way the rest of the app does", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [cluster()],
    });

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);

    const view = await screen.findByTestId("review-view-p-1");
    expect(view.getAttribute("title")).toBe("View this record in full");
    expect(view.getAttribute("aria-label")).toBe("View this record in full");

    const same = screen.getByTestId("review-confirm-p-1");
    expect(same.getAttribute("title")).toBe("Same person — link them");
    expect(same.getAttribute("aria-label")).toBe("Same person, link them");

    const not = screen.getByTestId("review-reject-p-1");
    expect(not.getAttribute("title")).toBe("Not this person");
    expect(not.getAttribute("aria-label")).toBe("Not this person");

    // CONTROL: reintroduce "approve" anywhere and this goes red.
    expect(screen.getByTestId("review-duplicates-modal").textContent).not.toMatch(/approve/i);
  });

  /**
   * The exclusivity fact survives the regroup.
   *
   * A `record:` cluster is ONE source record several CONTACTS are competing for,
   * so its members land on different cards once the list groups by contact. The
   * warning is the one thing the old cluster header said that a candidate row
   * cannot, so it moves onto every card the cluster touched.
   */
  it("keeps the multiple-choice warning after grouping by contact", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [
        cluster({
          clusterKey: "record:macos:mac-x",
          question: 'Which of these is "A. Stone"?',
          exclusive: true,
          items: [
            item({ proposalId: "p-a" }),
            item({ proposalId: "p-b", contactId: "c-other", contactName: "Nina Stone" }),
          ],
        }),
      ],
    });

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);

    // The cluster question is GONE. Founder: *"espically this seems redundant
    // 'Is \"Romina\" the same person as Romina?'"*. `cluster.question` is still
    // produced for any other caller; this screen no longer leads with it.
    // CONTROL: render `cluster.question` again and this goes red.
    expect(await screen.findByTestId("review-item-p-a")).toBeInTheDocument();
    expect(screen.queryByText('Which of these is "A. Stone"?')).not.toBeInTheDocument();

    // One card per CONTACT, and the warning on both.
    expect(screen.getByTestId("review-item-p-b")).toBeInTheDocument();
    expect(screen.getByTestId("review-exclusive-c-daniel").textContent).toBe(
      "Only one contact can be this record — answering here answers the others.",
    );
    expect(screen.getByTestId("review-exclusive-c-other")).toBeInTheDocument();
  });

  it("shows no multiple-choice warning when the cluster is not exclusive", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [cluster()],
    });
    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    await screen.findByTestId("review-item-p-1");
    expect(screen.queryByTestId("review-exclusive-c-daniel")).not.toBeInTheDocument();
  });

  it("says so plainly when there is nothing to review", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({ success: true, clusters: [] });
    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    expect(await screen.findByTestId("review-duplicates-empty")).toBeInTheDocument();
  });

  it("surfaces a failed answer instead of pretending it worked", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [cluster()],
    });
    jest.mocked(window.api.contacts.confirmLink).mockResolvedValue({
      success: false,
      error: "That review item has already been answered.",
    });

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByTestId("review-confirm-p-1"));

    expect(await screen.findByTestId("review-duplicates-error")).toHaveTextContent(
      "That review item has already been answered.",
    );
  });
});

// ===========================================================================
// BACKLOG-2502 — THE CARD SETTLES WHAT IT CAN; THE COMPARE SCREEN TAKES THE REST
// ===========================================================================

/**
 * The compare view the QUEUE route produces: the contact, and the candidate as
 * `kind: "proposed"`.
 *
 * `isConfirmed: false` is what the service now returns for this shape — a
 * contact with an open proposal against it. Before the BACKLOG-2502 blocker fix
 * it returned `true` here (`[].every(...)` on a contact with no non-origin
 * links), which is what replaced the decision buttons with "You have confirmed
 * these records are the same person". `contactCompare.test.ts` pins the producer
 * on that shape, so this fixture is not describing a state it cannot emit.
 */
function compareView(overrides: Record<string, unknown> = {}) {
  return {
    contactId: "c-daniel",
    isConfirmed: false,
    title: "Is this the same Daniel Haim?",
    reason: "Both records list the phone number +1 (415) 555-0134.",
    namesMatch: false,
    columns: [
      {
        linkId: "l-origin",
        kind: "contact",
        columnLabel: "Mac address book",
        displayName: "Daniel Haim",
        name: { value: "Daniel Haim", matched: false },
        emails: [],
        phones: [],
        company: null,
        transactions: [],
        recentCommunication: [],
        sourceRecordPresent: true,
      },
      {
        linkId: "proposed:macos:mac-lilly",
        kind: "proposed",
        columnLabel: "Mac address book",
        displayName: "Nina Stone",
        name: { value: "Nina Stone", matched: false },
        emails: [],
        phones: [],
        company: null,
        transactions: [],
        recentCommunication: [],
        sourceRecordPresent: true,
      },
    ],
    ...overrides,
  };
}

describe("the way into the compare screen", () => {
  beforeEach(() => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [cluster()],
    });
    const api = window.api.contacts as unknown as Record<string, jest.Mock>;
    api.getCompareColumns = jest.fn().mockResolvedValue({ success: true, view: compareView() });
  });

  /**
   * COMPARE SITS ON THE WHITE CONTACT ROW, OUTSIDE THE AMBER AREA — the
   * founder's rule, so the contact-level action is not repeated per candidate.
   * It is keyed by CONTACT id now, not by proposal id.
   */
  it("opens the SHIPPED compare screen from the contact row", async () => {
    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);

    // CONTROL: put Compare back on the candidate row and this id does not exist.
    fireEvent.click(await screen.findByTestId("review-compare-c-daniel"));

    await waitFor(() => expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument());
    // The candidate travels as a PROPOSED SOURCE — it has no crosswalk row, so
    // the reader cannot find it any other way. Its `proposalId` rides with it
    // (R5) so the column it becomes can be answered by name.
    // CONTROL: drop the third argument and the candidate silently vanishes from
    // the comparison the user is being asked to make.
    expect(window.api.contacts.getCompareColumns).toHaveBeenCalledWith(USER, "c-daniel", [
      { sourceType: "macos", sourceRecordId: "mac-lilly", proposalId: "p-1" },
    ]);
  });

  /**
   * THE EYE OPENS THE SAME SCREEN, WITH ITS OWN RECORD ON IT.
   *
   * Founder: *"You cannot judge 'same person' from one email address — you need
   * to see the whole record, and the reject is permanent."*
   *
   * R5 CHANGED WHAT "for THAT candidate" MEANS, and this test says which. Before,
   * the eye was the only way to reach the second candidate's comparison because
   * the screen could hold one candidate at a time. Now EVERY open candidate is a
   * column whichever control opened the screen, so what the eye still decides is
   * narrower and worth keeping: which candidate's frozen evidence sits behind
   * "How we decided this".
   */
  it("opens it from a candidate's eye, with every candidate on screen", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [
        cluster({
          items: [
            item(),
            item({ proposalId: "p-2", sourceType: "outlook", sourceRecordId: "out-9" }),
          ],
        }),
      ],
    });

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByTestId("review-view-p-2"));

    await waitFor(() => expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument());
    // CONTROL: send `[openedItem]` instead of the group and the other three of
    // the founder's four candidates have no column, which is the R5 defect.
    expect(window.api.contacts.getCompareColumns).toHaveBeenCalledWith(USER, "c-daniel", [
      { sourceType: "macos", sourceRecordId: "mac-lilly", proposalId: "p-1" },
      { sourceType: "outlook", sourceRecordId: "out-9", proposalId: "p-2" },
    ]);
  });

  it("keeps `Different people` on the queue route, and routes Confirm to the PROPOSAL", async () => {
    jest.mocked(window.api.contacts.confirmLink).mockResolvedValue({ success: true, linked: true });
    const api = window.api.contacts as unknown as Record<string, jest.Mock>;
    api.confirmSources = jest.fn();

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByTestId("review-compare-c-daniel"));
    await waitFor(() => expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument());

    // The two surfaces are NOT harmonised: nothing is linked yet here, so the
    // footer carries a reject. CONTROL: drop the `proposalId` guard on that
    // button and it appears on the contact route too.
    expect(screen.getByTestId("compare-reject-proposal")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("compare-confirm"));

    // CONTROL: route on `proposedSource` instead of `proposalId`, or call PR D's
    // confirmSources here, and the user's answer writes nothing about the
    // candidate — while both paths still return ok: true.
    await waitFor(() => expect(window.api.contacts.confirmLink).toHaveBeenCalledWith(USER, "p-1"));
    expect(api.confirmSources).not.toHaveBeenCalled();
  });

  it("holds the moved prose behind `How we decided this`", async () => {
    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByTestId("review-compare-c-daniel"));
    await waitFor(() => expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument());

    // Absent until asked for — the founder's whole complaint.
    expect(screen.queryByTestId("compare-why-body")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("compare-why-toggle"));

    // …and it is the SAME frozen sentences, not a regenerated summary.
    // CONTROL: show it by default and the first assertion goes red.
    const body = screen.getByTestId("compare-why-body");
    expect(body.textContent).toContain("carries the phone number …0134");
    expect(body.textContent).toContain('The Mac address book entry is saved as "Nina Stone".');
  });
});

describe("a confirm that linked nothing", () => {
  it("does NOT read as success", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [cluster()],
    });
    // The merge guard: the record is already claimed by a different contact, so
    // `confirmProposal` records the verdict, creates NO link, and skips the
    // sibling rejection — while still returning ok.
    jest.mocked(window.api.contacts.confirmLink).mockResolvedValue({
      success: true,
      linked: false,
    });

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByTestId("review-confirm-p-1"));

    // CONTROL: read `success` alone and the row disappears with nothing said,
    // telling the user two records were joined when they were not.
    // A NOTICE, not an error: the answer succeeded and the proposal is resolved,
    // so the list reloads — and `load()` clears `error`. A message the reload
    // wipes is a message nobody reads.
    expect(await screen.findByTestId("review-duplicates-notice")).toHaveTextContent(
      "That record is already saved to a different contact, so it was not joined here.",
    );
  });
});

// ===========================================================================
// BACKLOG-2502 — ONE `×`, AND IT POPS ONE LAYER
// ===========================================================================

/**
 * FOUNDER MODEL, 2026-08-09: *"just like the texts preview on transaction
 * details"* — the duplicates surface is a LIFO stack, and the `×` on the TOP
 * layer takes that layer off.
 *
 *   list only         -> `×` closes the list
 *   compare, over it  -> `×` closes COMPARE, and the list is still there
 *
 * Two things are asserted together throughout, because either alone passes in a
 * broken state: the COUNT (exactly one `×` at any moment — a test that merely
 * found one would stay green with `Done` beside it) and WHICH LAYER IT POPS (a
 * count test alone would stay green with the one remaining `×` dismissing the
 * whole stack, which is the state at `5dc615b8` that this revision replaces).
 */
describe("one ×, popping one layer", () => {
  beforeEach(() => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [cluster()],
    });
    const api = window.api.contacts as unknown as Record<string, jest.Mock>;
    api.getCompareColumns = jest.fn().mockResolvedValue({ success: true, view: compareView() });
  });

  /**
   * Every control that dismisses SOMETHING, by accessible name — the three the
   * founder counted plus anything else that would read as an exit. Named rather
   * than fetched by test id so a future exit with a new id is still counted.
   */
  const exits = (): string[] =>
    screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "")
      .filter((name) => /close|done|back to the list|←/i.test(name));

  /** CONTROL 5, half one: the list alone. */
  it("shows exactly ONE × with only the list open, and it is the list's", async () => {
    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    await screen.findByTestId("review-contact-c-daniel");

    // CONTROL: put the `Done` footer back and this reads 2.
    expect(exits()).toEqual(["Close possible duplicates"]);
    expect(screen.getByTestId("review-duplicates-close")).toHaveTextContent("×");
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });

  /** CONTROL 5, half two: the stack of two. */
  it("shows exactly ONE × with compare open, and it is COMPARE's", async () => {
    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByTestId("review-compare-c-daniel"));
    await waitFor(() => expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument());

    // THE SCREEN THE FOUNDER WAS LOOKING AT. One `×`, and it belongs to the top
    // layer. CONTROL: drop the `!comparing` gate on the list's `×` and this
    // reads 2 — two dismissals meaning two different things.
    expect(exits()).toEqual(["Close compare"]);
    expect(screen.getByTestId("compare-close")).toBeInTheDocument();
    // The layer underneath does NOT keep its control while it is covered.
    expect(screen.queryByTestId("review-duplicates-close")).not.toBeInTheDocument();
    // CONTROL: restore `← Back to the list` and this id exists again — the
    // second control this rule exists to make unnecessary.
    expect(screen.queryByTestId("review-compare-back")).not.toBeInTheDocument();

    // AND THE DECISION BUTTONS SURVIVED IT. The footer that was deleted held
    // `Done` and nothing else; these live in the compare screen's own footer and
    // did not move. CONTROL: delete that footer instead of this modal's and all
    // three of these vanish — the screen would be dismissible and unanswerable.
    expect(screen.getByTestId("compare-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("compare-confirm-edit")).toBeInTheDocument();
    expect(screen.getByTestId("compare-reject-proposal")).toBeInTheDocument();
    expect(screen.queryByTestId("compare-already-confirmed")).not.toBeInTheDocument();
  });

  it("puts the list's × above the divider, opposite the heading", async () => {
    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    await screen.findByTestId("review-contact-c-daniel");

    const close = screen.getByTestId("review-duplicates-close");
    const header = close.parentElement!;

    // Same row as the heading and its subtext…
    expect(header).toContainElement(screen.getByText("Possible duplicates"));
    // …and that row is the one carrying the divider, so the × is ABOVE it.
    // CONTROL: move the × into the scrolling body and `border-b` is gone from
    // its parent.
    expect(header.className).toContain("border-b");
  });

  /**
   * CONTROL 1 — THE ONE THAT MATTERS, and the founder's correction to
   * `5dc615b8`, where this same press dismissed the whole modal.
   *
   * The list must be THERE afterwards, not merely re-fetched into existence:
   * nothing was answered, so the queue the user is part-way through is the same
   * queue. Asserted by candidate identity AND by the loader not having run a
   * second time.
   */
  it("× on compare pops ONE layer — the list is still there underneath", async () => {
    const onClose = jest.fn();
    render(<ReviewDuplicatesModal userId={USER} onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("review-compare-c-daniel"));
    await waitFor(() => expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("compare-close"));

    // Back on the list, BY IDENTITY — the same candidate, still unanswered.
    expect(await screen.findByTestId("review-item-p-1")).toBeInTheDocument();
    expect(screen.getByTestId("review-contact-c-daniel")).toBeInTheDocument();
    expect(screen.queryByTestId("contact-compare-screen")).not.toBeInTheDocument();
    // CONTROL: wire compare's `onClose` to the modal's `onClose` — the
    // `5dc615b8` behaviour — and this fires, taking the whole stack with it.
    expect(onClose).not.toHaveBeenCalled();
    // STILL THERE, not rebuilt: no reload was needed because nothing was
    // answered. CONTROL: add `void load()` to that handler and this reads 2.
    expect(window.api.contacts.getReviewQueue).toHaveBeenCalledTimes(1);
    // The way back in is unchanged — the popped layer can be pushed again.
    expect(screen.getByTestId("review-compare-c-daniel")).toBeInTheDocument();
  });

  /** CONTROL 2 — the regression guard for the rule above. */
  it("× on the list closes the list — the bottom layer is the last one out", async () => {
    const onClose = jest.fn();
    render(<ReviewDuplicatesModal userId={USER} onClose={onClose} />);
    await screen.findByTestId("review-contact-c-daniel");

    fireEvent.click(screen.getByTestId("review-duplicates-close"));

    // CONTROL: gate this `×` on `comparing` instead of `!comparing` and it is
    // not on screen to press — the queue would have no way out at all.
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// BACKLOG-2502 — WHERE EACH ANSWER LANDS, BY ENTRY PATH
// ===========================================================================

/**
 * FOUNDER RULING, 2026-08-09: the compare screen is reached two ways and must
 * return the user to where they came from. From the queue, `Confirm` keeps them
 * in the queue; `Confirm & edit` leaves for the contact card. (The main-list
 * path is unchanged, and `Contacts.compareWayIn-2471` walks both and compares
 * the destinations.)
 */
describe("where a decision lands, entering from the duplicates list", () => {
  beforeEach(() => {
    const api = window.api.contacts as unknown as Record<string, jest.Mock>;
    api.getCompareColumns = jest.fn().mockResolvedValue({ success: true, view: compareView() });
    jest.mocked(window.api.contacts.confirmLink).mockResolvedValue({ success: true, linked: true });
  });

  it("Confirm returns to the duplicates screen, with the answered row GONE", async () => {
    // The queue as it stands, then as it stands after the answer. The row leaves
    // because the LIST RELOADS — never because the renderer spliced it out, which
    // would leave an exclusive cluster's siblings on screen already settled.
    jest
      .mocked(window.api.contacts.getReviewQueue)
      .mockResolvedValueOnce({ success: true, clusters: [cluster()] })
      .mockResolvedValue({ success: true, clusters: [] });

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByTestId("review-compare-c-daniel"));
    await waitFor(() => expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("compare-confirm"));

    // BACK ON THE QUEUE — not on the compare screen, and not on a closed modal.
    // CONTROL: drop `setComparing(null)` from `onConfirmed` and the compare
    // screen is still up with the question already answered.
    await waitFor(() =>
      expect(screen.queryByTestId("contact-compare-screen")).not.toBeInTheDocument(),
    );
    expect(await screen.findByTestId("review-duplicates-empty")).toBeInTheDocument();
    // The ANSWERED ROW specifically, by id. CONTROL: drop `load()` and the row
    // is still sitting there, already decided.
    expect(screen.queryByTestId("review-item-p-1")).not.toBeInTheDocument();
    expect(window.api.contacts.confirmLink).toHaveBeenCalledWith(USER, "p-1");
  });

  it("Confirm & edit leaves the queue and names the contact to open", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [cluster()],
    });
    const onConfirmedAndEdit = jest.fn();

    render(
      <ReviewDuplicatesModal
        userId={USER}
        onClose={jest.fn()}
        onConfirmedAndEdit={onConfirmedAndEdit}
      />,
    );
    fireEvent.click(await screen.findByTestId("review-compare-c-daniel"));
    await waitFor(() => expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("compare-confirm-edit"));

    // The WRITE happens first and is the same one Confirm makes — this button is
    // not a second channel.
    await waitFor(() => expect(window.api.contacts.confirmLink).toHaveBeenCalledWith(USER, "p-1"));
    // CONTROL: leave `onConfirmedAndEdit` unpassed on the nested compare screen —
    // the state this shipped in — and this never fires: the button wrote the
    // answer and then sat there, going nowhere.
    expect(onConfirmedAndEdit).toHaveBeenCalledWith("c-daniel");
    // …and the queue is not what the user is left looking at.
    await waitFor(() =>
      expect(screen.queryByTestId("contact-compare-screen")).not.toBeInTheDocument(),
    );
  });
});

// ===========================================================================
// BACKLOG-2502 ROUND 4 — COMPARE IS ITS OWN POPUP, NOT A PANE IN THIS ONE
// ===========================================================================

/**
 * FOUNDER, 2026-08-09, testing `223be9fb`: *"I still see the compare screen
 * within the 'Possible duplicates / These were not linked automatically because
 * we could not tell. Nothing changes until you answer.' screen, rather than its
 * own popup."*
 *
 * Round 3's layer BEHAVIOUR was right and is untouched. What was wrong was the
 * RENDERING: compare sat in the list modal's body, beneath the list's heading,
 * so it read as one window whose contents had changed.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE CONTAINMENT ASSERTIONS AND NOT `queryByText(...)`
 * ---------------------------------------------------------------------------
 * The list stays MOUNTED underneath — that is the requirement, not an accident —
 * so its heading is legitimately in the document while compare is open. An
 * absence assertion would therefore be asserting the opposite of the spec, and
 * would have to be satisfied by unmounting the layer that is supposed to stay.
 * The real question is WHICH SUBTREE the heading is in, so that is what is
 * asked: not "is it on the page" but "is it above the compare content".
 */
describe("compare is its own popup", () => {
  beforeEach(() => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [cluster()],
    });
    const api = window.api.contacts as unknown as Record<string, jest.Mock>;
    api.getCompareColumns = jest.fn().mockResolvedValue({ success: true, view: compareView() });
  });

  const openCompare = async () => {
    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByTestId("review-compare-c-daniel"));
    await waitFor(() => expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument());
  };

  /**
   * CONTROL 1 — THE ONE THAT IS EASY TO FAKE.
   *
   * Both directions are asserted, because either alone passes in a broken state:
   * the heading must be OUT of compare's subtree (or nothing changed) and IN the
   * list's (or the list was unmounted to pass the first half).
   */
  it("does not render the list's heading above the compare content", async () => {
    await openCompare();

    const compareLayer = screen.getByTestId("review-compare-overlay");
    const listLayer = screen.getByTestId("review-duplicates-modal");
    const heading = screen.getByText("Possible duplicates");
    const subtext = screen.getByTestId("review-duplicates-subtext");

    // CONTROL: put the compare pane back inside the list modal's body — the
    // `223be9fb` structure — and all four of these go red at once.
    expect(compareLayer).not.toContainElement(heading);
    expect(compareLayer).not.toContainElement(subtext);
    // …and they are still on screen, in the layer they belong to. This half is
    // what stops the assertion above being satisfied by deleting the list.
    expect(listLayer).toContainElement(heading);
    expect(listLayer).toContainElement(subtext);
    expect(subtext).toHaveTextContent(
      "These were not linked automatically because we could not tell.",
    );
  });

  it("renders the compare layer OUTSIDE the list modal, not nested in it", async () => {
    await openCompare();

    const compareLayer = screen.getByTestId("review-compare-overlay");
    const listLayer = screen.getByTestId("review-duplicates-modal");

    // THE STRUCTURAL CLAIM, stated directly: two sibling overlays, not one
    // inside the other. CONTROL: nest compare back in the list modal's children
    // and this is the assertion that names the mistake.
    expect(listLayer).not.toContainElement(compareLayer);
    expect(compareLayer).not.toContainElement(listLayer);
    // Compare's frame is its own, and the compare screen lives in it.
    expect(compareLayer).toContainElement(screen.getByTestId("contact-compare-screen"));
    // Its × belongs to that frame too — the Round 3 rule, now at the right depth.
    expect(compareLayer).toContainElement(screen.getByTestId("compare-close"));
  });

  /**
   * CONTROL 4 — stacking order, by the app's own convention.
   *
   * Parsed as a NUMBER rather than matched as a string, so this fails if the
   * class is dropped, if a local value is used that happens not to win, or if
   * the list is ever raised above compare.
   */
  it("stacks the compare layer above the list layer", async () => {
    const zOf = (el: HTMLElement): number => {
      const m = el.className.match(/(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?:\s|$)/);
      if (!m) throw new Error(`no z-index class on ${el.dataset.testid}: ${el.className}`);
      return Number(m[1] ?? m[2]);
    };

    await openCompare();

    const compareZ = zOf(screen.getByTestId("review-compare-overlay"));
    const listZ = zOf(screen.getByTestId("review-duplicates-modal"));

    // CONTROL: drop `zIndex="z-[60]"` and compare falls back to ResponsiveModal's
    // default `z-50` — equal to the list's, so the DOM order decides and the
    // guarantee is gone. This reads 50 > 50 and goes red.
    expect(compareZ).toBeGreaterThan(listZ);
    // The value itself is the shared convention, not a local invention: above the
    // list, below ContactFormModal's `z-[70]`, which `Confirm & edit` opens once
    // both of these layers are down.
    expect(compareZ).toBe(60);
    expect(compareZ).toBeLessThan(70);
  });

  /** The list is not merely mounted — it is VISIBLE behind the overlay. */
  it("leaves the queue on screen underneath, not hidden", async () => {
    await openCompare();

    // CONTROL: restore the `{!comparing && …}` gate on the list body and the
    // rows vanish while compare is open — a stack of one, wearing two frames.
    expect(screen.getByTestId("review-contact-c-daniel")).toBeInTheDocument();
    expect(screen.getByTestId("review-item-p-1")).toBeInTheDocument();
    expect(screen.getByTestId("review-duplicates-modal")).toContainElement(
      screen.getByTestId("review-item-p-1"),
    );
  });
});

/**
 * ===========================================================================
 * BACKLOG-2502 R5 — THE FOUNDER'S CONTACT WITH FOUR CANDIDATES
 * ===========================================================================
 * *"One of the contacts has 4 duplicates and we don't have the unlink /
 * not-the-same button for each one of them."*
 *
 * The whole chain is exercised here rather than at either end of it: an answer
 * writes through the queue's own channel, the queue reloads, the group loses one
 * item, the compare screen is asked again with the SHORTER candidate list, and
 * the other three questions are still standing. Any link in that chain broken
 * leaves an answered candidate on screen or takes the unanswered ones off it.
 */
describe("four candidates, answered one at a time", () => {
  const FOUR = [
    { proposalId: "p-1", sourceType: "macos", sourceRecordId: "mac-11" },
    { proposalId: "p-2", sourceType: "outlook", sourceRecordId: "out-22" },
    { proposalId: "p-3", sourceType: "google", sourceRecordId: "goo-33" },
    { proposalId: "p-4", sourceType: "macos", sourceRecordId: "mac-44" },
  ];

  const queueWith = (candidates: typeof FOUR) => ({
    success: true as const,
    clusters: [
      cluster({
        items: candidates.map((c) =>
          item({
            proposalId: c.proposalId,
            sourceType: c.sourceType,
            sourceRecordId: c.sourceRecordId,
            matchedOn: "name",
          }),
        ),
      }),
    ],
  });

  /**
   * The producer's own projection, driven by what it is ASKED for — which is the
   * point: this stub cannot show a candidate the modal did not send, so a screen
   * that keeps an answered candidate cannot pass by fixture.
   *
   * The column shape is pinned against the real driver in
   * `electron/services/__tests__/contactCompare.test.ts` ("R5 — several
   * candidates"): one `kind: "proposed"` column per candidate, in the caller's
   * order, keyed `proposed:<type>:<record>`, carrying `proposalId`.
   */
  const compareViewFor = (
    sources: ReadonlyArray<{ sourceType: string; sourceRecordId: string; proposalId?: string }>,
  ) => ({
    contactId: "c-daniel",
    isConfirmed: false,
    title: "Is this the same Daniel Haim?",
    reason: "Four records share this name.",
    namesMatch: true,
    columns: [
      {
        linkId: "l-origin",
        kind: "contact" as const,
        columnLabel: "Mac address book",
        displayName: "Daniel Haim",
        name: { value: "Daniel Haim", matched: true },
        emails: [],
        phones: [],
        company: null,
        transactions: [],
        recentCommunication: [],
        sourceRecordPresent: true,
      },
      ...sources.map((s) => ({
        linkId: `proposed:${s.sourceType}:${s.sourceRecordId}`,
        kind: "proposed" as const,
        columnLabel: "Mac address book",
        displayName: "Daniel Haim",
        name: { value: "Daniel Haim", matched: true },
        emails: [{ value: `${s.sourceRecordId}@example.com`, matched: false }],
        phones: [],
        company: null,
        transactions: [],
        recentCommunication: [],
        sourceRecordPresent: true,
        proposalId: s.proposalId,
      })),
    ],
  });

  beforeEach(() => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue(queueWith(FOUR));
    const api = window.api.contacts as unknown as Record<string, jest.Mock>;
    api.getCompareColumns = jest.fn().mockImplementation(async (_u, _c, sources) => ({
      success: true,
      view: compareViewFor(sources ?? []),
    }));
  });

  const openCompare = async () => {
    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByTestId("review-compare-c-daniel"));
    await waitFor(() => expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument());
  };

  it("draws all four candidates, each with its own answer", async () => {
    await openCompare();

    // BY IDENTITY: the control for p-3 lives in the column for `goo-33`.
    // CONTROL: send only the opened candidate (`[openedItem]`) and three of
    // these four columns do not exist.
    for (const c of FOUR) {
      expect(
        screen.getByTestId(`compare-column-proposed:${c.sourceType}:${c.sourceRecordId}`),
      ).toBeTruthy();
      expect(screen.getByTestId(`compare-candidate-different-${c.proposalId}`)).toBeTruthy();
    }
  });

  it("answering candidate 2 writes about candidate 2, and leaves 1, 3 and 4 standing", async () => {
    await openCompare();

    // The second answer's queue: p-2 gone, the rest untouched.
    jest
      .mocked(window.api.contacts.getReviewQueue)
      .mockResolvedValue(queueWith(FOUR.filter((c) => c.proposalId !== "p-2")));
    jest.mocked(window.api.contacts.rejectLink).mockResolvedValue({ success: true });

    fireEvent.click(screen.getByTestId("compare-candidate-different-p-2"));

    // ONE record was written about, and it is the one whose control was pressed.
    // CONTROL: hand `answer` the opened item instead of the pressed one and this
    // reads p-1 — the founder's first candidate answered by his second click.
    await waitFor(() =>
      expect(jest.mocked(window.api.contacts.rejectLink).mock.calls).toEqual([[USER, "p-2"]]),
    );
    expect(window.api.contacts.confirmLink).not.toHaveBeenCalled();

    // The answered candidate leaves; the other three are still on screen and
    // still unanswered. CONTROL: freeze the candidate list in state (the shape
    // before R5) and p-2 stays on screen, answered, forever.
    await waitFor(() =>
      expect(screen.queryByTestId("compare-column-proposed:outlook:out-22")).toBeNull(),
    );
    for (const c of FOUR.filter((x) => x.proposalId !== "p-2")) {
      expect(
        screen.getByTestId(`compare-column-proposed:${c.sourceType}:${c.sourceRecordId}`),
      ).toBeTruthy();
      expect(screen.getByTestId(`compare-candidate-different-${c.proposalId}`)).toBeTruthy();
    }
    // ...and the user is still on the compare screen, not dropped back to the list.
    expect(screen.getByTestId("contact-compare-screen")).toBeTruthy();
  });

  it("says 'same person' through the queue's own confirm, for that candidate alone", async () => {
    await openCompare();
    jest.mocked(window.api.contacts.confirmLink).mockResolvedValue({ success: true, linked: true });
    jest
      .mocked(window.api.contacts.getReviewQueue)
      .mockResolvedValue(queueWith(FOUR.filter((c) => c.proposalId !== "p-3")));

    fireEvent.click(screen.getByTestId("compare-candidate-same-p-3"));

    // CONTROL: build a second confirm path for this screen and the merge guard,
    // the sibling rejection and the reload all have to be re-decided here.
    await waitFor(() =>
      expect(jest.mocked(window.api.contacts.confirmLink).mock.calls).toEqual([[USER, "p-3"]]),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("compare-column-proposed:google:goo-33")).toBeNull(),
    );
  });

  it("reports the merge guard ON TOP of the compare screen, where the press happened", async () => {
    await openCompare();
    // `ok: true, linked: false` — the record is already saved to someone else.
    jest.mocked(window.api.contacts.confirmLink).mockResolvedValue({
      success: true,
      linked: false,
    });

    fireEvent.click(screen.getByTestId("compare-candidate-same-p-4"));

    // CONTROL: leave the notice on the list layer only (where it was before R5)
    // and it renders UNDER this overlay — an outcome the user cannot see is one
    // they will act on twice.
    const notice = await screen.findByTestId("review-duplicates-notice");
    expect(notice.textContent).toContain("already saved to a different contact");
    expect(screen.getByTestId("review-compare-pane")).toContainElement(notice);
  });

  it("closes the compare screen when the last candidate is answered, and gives the list its × back", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue(queueWith([FOUR[0]]));
    await openCompare();
    // The list's × is the compare screen's while compare is open (R3).
    expect(screen.queryByTestId("review-duplicates-close")).toBeNull();

    jest.mocked(window.api.contacts.rejectLink).mockResolvedValue({ success: true });
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [],
    });
    fireEvent.click(screen.getByTestId("compare-reject-proposal"));

    // Nothing left to compare. CONTROL: leave `comparing` set when its group is
    // gone and the list is left with NO way out — its × is still suppressed by a
    // compare screen that renders nothing.
    await waitFor(() => expect(screen.queryByTestId("contact-compare-screen")).toBeNull());
    expect(screen.getByTestId("review-duplicates-close")).toBeTruthy();
  });
});
