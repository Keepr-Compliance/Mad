/**
 * BACKLOG-2791 — the three renderings are ONE set, asserted by ID.
 *
 * Founder ruling, 2026-08-22: review data "can be displayed combined
 * (email+text) in Needs Review or separately in the needs-review sections of the
 * emails/texts tabs, but the data and state should be the same in the backend,
 * and it all counts toward the needs-review required for completing the
 * transaction."
 *
 * A count-based test would pass while showing the WRONG items, so every
 * assertion here is on the ID SET. The union of what the two tab sections render
 * must equal exactly what the combined screen renders, which must equal exactly
 * what getReviewState returned.
 *
 * The concrete failure this prevents: the badge says 5 while the Emails tab's
 * own needs-review section says 0, because pending items are deliberately not in
 * `communications` and a render-time classification over `match_reason` cannot
 * see them. That was the state of this branch until the sections were switched
 * onto the shared set.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { ReviewQueueSection } from "../ReviewQueueSection";
import { NeedsReviewScreen } from "../NeedsReviewScreen";
import { TransactionEmailsTab } from "../TransactionEmailsTab";
import type { Communication } from "../../types";
import type { ReviewItemDto } from "../../../../../electron/types/ipc/window-api-transactions";

// TransactionEmailsTab reads the signed-in user to filter it out of participant
// display. Mocked at the same seam TransactionEmailsTab-2319 uses.
jest.mock("../../../../contexts", () => ({
  useAuth: () => ({ currentUser: { id: "user-1", email: "me@example.com" } }),
}));

function item(over: Partial<ReviewItemDto> & { id: string }): ReviewItemDto {
  return {
    origin: "pending",
    kind: "email",
    rowId: over.id.split(":")[1] ?? over.id,
    transaction_id: "tx-1",
    email_id: "e-1",
    thread_id: null,
    found_at: "2026-08-01T00:00:00.000Z",
    display: {
      title: "Subject",
      subtitle: "paul@example.com",
      snippet: "hello",
      occurredAt: "2026-06-01T00:00:00.000Z",
      itemCount: 1,
    },
    ...over,
  };
}

/** A deliberately mixed set: both kinds, both origins. */
const SET: ReviewItemDto[] = [
  item({ id: "pending:p1", kind: "email", email_id: "e1" }),
  item({ id: "pending:p2", kind: "email", email_id: "e2" }),
  item({ id: "legacy:l1", kind: "email", email_id: "e3", origin: "legacy" }),
  item({ id: "pending:t1", kind: "text", email_id: null, thread_id: "th-1" }),
  item({ id: "pending:t2", kind: "text", email_id: null, thread_id: "th-2" }),
];

const noop = async () => undefined;

function renderedIds(): string[] {
  return screen
    .getAllByTestId("review-item")
    .map((el) => el.getAttribute("data-item-id") as string)
    .sort();
}

describe("BACKLOG-2791 — the three renderings show the same set", () => {
  it("emails-section ∪ texts-section === the combined screen === getReviewState", () => {
    const { unmount: unmountEmails } = render(
      <ReviewQueueSection items={SET} kind="email" onApprove={noop} onReject={noop} />,
    );
    const emailIds = renderedIds();
    unmountEmails();

    const { unmount: unmountTexts } = render(
      <ReviewQueueSection items={SET} kind="text" onApprove={noop} onReject={noop} />,
    );
    const textIds = renderedIds();
    unmountTexts();

    render(
      <NeedsReviewScreen
        items={SET}
        isLoading={false}
        onApprove={noop}
        onReject={noop}
        onClose={noop}
      />,
    );
    const combinedIds = renderedIds();

    const sourceIds = SET.map((i) => i.id).sort();
    const unionIds = [...emailIds, ...textIds].sort();

    // The union of the two tabs is exactly the source set...
    expect(unionIds).toEqual(sourceIds);
    // ...and so is the combined screen.
    expect(combinedIds).toEqual(sourceIds);
    // Stated directly, so a failure names the disagreement.
    expect(unionIds).toEqual(combinedIds);
  });

  it("the two sections PARTITION the set — no item appears on both tabs", () => {
    const { unmount } = render(
      <ReviewQueueSection items={SET} kind="email" onApprove={noop} onReject={noop} />,
    );
    const emailIds = renderedIds();
    unmount();

    render(<ReviewQueueSection items={SET} kind="text" onApprove={noop} onReject={noop} />);
    const textIds = renderedIds();

    expect(emailIds.filter((id) => textIds.includes(id))).toEqual([]);
    expect(emailIds).toEqual(["legacy:l1", "pending:p1", "pending:p2"]);
    expect(textIds).toEqual(["pending:t1", "pending:t2"]);
  });

  it("a legacy item is rendered by the tab section, not silently dropped", () => {
    // The legacy population is the half that already existed. If a section
    // filtered it out, the badge would over-count relative to what the user can
    // actually act on — the disagreement the ruling forbids.
    render(<ReviewQueueSection items={SET} kind="email" onApprove={noop} onReject={noop} />);
    expect(renderedIds()).toContain("legacy:l1");
  });

  /**
   * THE REGRESSION THIS FILE MISSED THE FIRST TIME.
   *
   * The original version of this suite rendered ReviewQueueSection and
   * NeedsReviewScreen in ISOLATION from hand-made props. It therefore could not
   * observe that TransactionEmailsTab was STILL mounting its own
   * self-classifying BACKLOG-2319 section underneath — so every legacy
   * address_missing email rendered twice, at two different granularities, and
   * this suite stayed green through all of it.
   *
   * Mounting the REAL tab alongside the real shared section is the only shape
   * that can see it.
   */
  it("the REAL Emails tab renders no review item of its own — one item, one rendering", () => {
    const legacyEmail: Communication = {
      id: "c-legacy",
      user_id: "user-1",
      transaction_id: "tx-1",
      email_id: "e3",
      communication_type: "email",
      subject: "Ambiguous",
      sender: "paul@example.com",
      recipients: "me@example.com",
      sent_at: "2026-06-01T00:00:00.000Z",
      created_at: "2026-06-01T00:00:00.000Z",
      has_attachments: false,
      match_reason: "address_missing",
    } as unknown as Communication;

    render(
      <>
        <ReviewQueueSection items={SET} kind="email" onApprove={noop} onReject={noop} />
        <TransactionEmailsTab
          communications={[legacyEmail]}
          loading={false}
          unlinkingCommId={null}
          onViewEmail={jest.fn()}
          onShowUnlinkConfirm={jest.fn()}
          userId="user-1"
          transactionId="tx-1"
          hasReviewItems
        />
      </>,
    );

    // Exactly the shared section's items are rendered as review items — the tab
    // contributes none.
    expect(renderedIds()).toEqual(["legacy:l1", "pending:p1", "pending:p2"]);

    // And the tab mounts no needs-review surface of its own.
    expect(screen.queryByTestId("needs-review-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("needs-review-list")).not.toBeInTheDocument();

    // The ambiguous subject appears ONCE in the whole tree, not twice.
    expect(screen.queryAllByText("Ambiguous")).toHaveLength(0);
  });

  it("a section with nothing of its kind renders nothing at all", () => {
    const emailsOnly = SET.filter((i) => i.kind === "email");
    const { container } = render(
      <ReviewQueueSection items={emailsOnly} kind="text" onApprove={noop} onReject={noop} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
