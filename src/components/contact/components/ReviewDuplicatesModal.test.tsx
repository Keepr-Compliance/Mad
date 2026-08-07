/**
 * BACKLOG-2410 — the review surface.
 *
 * Pins the two things the founder was specific about: the evidence is shown in
 * WORDS and never as a score, and the two axes are reported SEPARATELY so a
 * pair can read "connected" and "possibly the same person" at once.
 *
 * Assertions name exact proposal ids. A count assertion would pass while
 * rendering the wrong question.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReviewDuplicatesModal } from "./ReviewDuplicatesModal";
import type { ContactReviewCluster } from "@/types/contactProvenance";

const USER = "u1";

function item(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: "p-1",
    contactId: "c-daniel",
    contactName: "Daniel Haim",
    sourceType: "macos",
    sourceRecordId: "mac-lilly",
    sourceLabel: "Mac address book",
    sourceName: "Nina Stone",
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
   * BACKLOG-2502 — THE ROW NO LONGER PRINTS THE EVIDENCE, AND THAT IS THE POINT.
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
   * the row DOES show, because a screen that reintroduced a percentage would do
   * it in the summary line rather than in a panel nobody opened.
   */
  it("summarises in words, with no score and no paragraph", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [cluster()],
    });

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);

    const summary = await screen.findByTestId("review-summary-p-1");
    expect(summary.textContent).toBe("possibly the same person — matched on the same phone number");

    // CONTROL: restore the evidence block and this goes red.
    expect(screen.queryByTestId("review-evidence-p-1")).not.toBeInTheDocument();
    const modal = screen.getByTestId("review-duplicates-modal");
    expect(modal.textContent).not.toMatch(/\d+%|0\.\d+|confidence/i);
    // The frozen-audit sentence is made ONCE, by the header — not per candidate.
    expect(modal.textContent).not.toContain("Nothing has been linked.");
  });

  /**
   * THE TWO AXES WERE COLLAPSED ON PURPOSE — this test is the inversion of the
   * one it replaces, and it is not an eroded guarantee.
   *
   * The old rule was "identity and relationship are reported separately", and it
   * existed to stop them becoming a single confidence score. That concern is
   * still live and is still pinned — by the `no score` assertion above, and by
   * the fact both values remain distinct COLUMNS with distinct vocabularies in
   * `contact_link_verdicts` (`databaseService.ts:3140-3148`).
   *
   * What the founder rejected was printing both as labels, side by side, on
   * every row: *"Identity: possibly the same person"* beside *"Relationship:
   * possibly connected"* reads as two findings when there is one decision to
   * make. The row now leads with identity — the axis the buttons answer — and
   * relationship stays on the record, reachable through the compare screen.
   */
  it("leads with the identity phrase and does not label two axes", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [
        cluster({
          items: [item({ relationship: "connected", relationshipPhrase: "connected" })],
        }),
      ],
    });

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);

    expect((await screen.findByTestId("review-summary-p-1")).textContent).toContain(
      "possibly the same person",
    );
    // CONTROL: restore either label and this goes red.
    expect(screen.queryByTestId("review-identity-p-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("review-relationship-p-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("review-duplicates-modal").textContent).not.toContain("Identity:");
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

  it("marks a one-record cluster as a multiple choice", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [
        cluster({
          clusterKey: "record:macos:mac-x",
          question: 'Which of these is "A. Stone"?',
          exclusive: true,
          items: [item({ proposalId: "p-a" }), item({ proposalId: "p-b" })],
        }),
      ],
    });

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);

    // BACKLOG-2502 — the heading is GONE. Founder: *"espically this seems
    // redundant 'Is \"Romina\" the same person as Romina?'"*. `cluster.question`
    // is still produced for any other caller; this screen no longer leads with
    // it, because the rows below already show both names.
    // CONTROL: render `cluster.question` again and this goes red.
    expect(await screen.findByTestId("review-item-p-a")).toBeInTheDocument();
    expect(screen.queryByText('Which of these is "A. Stone"?')).not.toBeInTheDocument();
    // The exclusivity warning stays — it is the one thing the cluster header
    // says that the rows cannot.
    expect(screen.getByText("Only one of these can be right")).toBeInTheDocument();
    expect(screen.getByTestId("review-item-p-a")).toBeInTheDocument();
    expect(screen.getByTestId("review-item-p-b")).toBeInTheDocument();
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
// BACKLOG-2502 — THE ROW SETTLES WHAT IT CAN; THE COMPARE SCREEN TAKES THE REST
// ===========================================================================

describe("the way into the compare screen", () => {
  beforeEach(() => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [cluster()],
    });
    const api = window.api.contacts as unknown as Record<string, jest.Mock>;
    api.getCompareColumns = jest.fn().mockResolvedValue({
      success: true,
      view: {
        contactId: "c-daniel",
        isConfirmed: false,
        title: "Is this the same Daniel Haim?",
        reason: "Both records list the phone number +1 (206) 555-0134.",
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
      },
    });
  });

  it("opens the SHIPPED compare screen for the row's candidate", async () => {
    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);

    fireEvent.click(await screen.findByTestId("review-compare-p-1"));

    await waitFor(() => expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument());
    // The candidate travels as the PROPOSED SOURCE — it has no crosswalk row, so
    // the reader cannot find it any other way.
    // CONTROL: drop the third argument and the candidate silently vanishes from
    // the comparison the user is being asked to make.
    expect(window.api.contacts.getCompareColumns).toHaveBeenCalledWith(USER, "c-daniel", {
      sourceType: "macos",
      sourceRecordId: "mac-lilly",
    });
  });

  it("keeps `Different people` on the queue route, and routes Confirm to the PROPOSAL", async () => {
    jest.mocked(window.api.contacts.confirmLink).mockResolvedValue({ success: true, linked: true });
    const api = window.api.contacts as unknown as Record<string, jest.Mock>;
    api.confirmSources = jest.fn();

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);
    fireEvent.click(await screen.findByTestId("review-compare-p-1"));
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
    fireEvent.click(await screen.findByTestId("review-compare-p-1"));
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
