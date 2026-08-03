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
    sourceName: "Lilly Haim",
    reason: "identifier_reassigned",
    identity: "possibly_same_person",
    identityPhrase: "possibly the same person",
    relationship: "possibly_connected",
    relationshipPhrase: "possibly connected",
    evidence: {
      summary:
        "A record in your Mac address book carries the phone number …0134, which you also have saved against Daniel Haim.",
      details: ['The Mac address book entry is saved as "Lilly Haim".'],
      contactLabel: "Daniel Haim",
      sourceLabel: "Mac address book",
      sourceName: "Lilly Haim",
    },
    ...overrides,
  };
}

function cluster(overrides: Record<string, unknown> = {}): ContactReviewCluster {
  return {
    clusterKey: "contact:c-daniel",
    question: 'Is "Lilly Haim" the same person as Daniel Haim?',
    exclusive: false,
    items: [item()],
    ...overrides,
  } as unknown as ContactReviewCluster;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ReviewDuplicatesModal", () => {
  it("shows the evidence in words, with no score", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [cluster()],
    });

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);

    const evidence = await screen.findByTestId("review-evidence-p-1");
    expect(evidence.textContent).toContain("…0134");
    expect(evidence.textContent).toContain("Mac address book");
    const modal = screen.getByTestId("review-duplicates-modal");
    expect(modal.textContent).not.toMatch(/\d+%|0\.\d+|confidence/i);
  });

  /**
   * THE TWO AXES. This is the test that goes red if someone collapses identity
   * and relationship into a single "match confidence".
   */
  it("reports identity and relationship as separate, differing phrases", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [
        cluster({
          items: [
            item({
              relationship: "connected",
              relationshipPhrase: "connected",
            }),
          ],
        }),
      ],
    });

    render(<ReviewDuplicatesModal userId={USER} onClose={jest.fn()} />);

    expect((await screen.findByTestId("review-identity-p-1")).textContent).toBe(
      "possibly the same person",
    );
    expect(screen.getByTestId("review-relationship-p-1").textContent).toBe("connected");
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

    expect(await screen.findByText('Which of these is "A. Stone"?')).toBeInTheDocument();
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
