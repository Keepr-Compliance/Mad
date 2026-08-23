/**
 * BACKLOG-2791 — the founder's dictated copy, labels and empty-state rule.
 *
 * Every string here is TRANSCRIBED from the founder's 2026-08-22 dictation, not
 * paraphrased. If a test here fails on wording, the wording is the thing that
 * moved.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { ReviewPromptDialog } from "../ReviewPromptDialog";
import { TransactionEmailsTab } from "../TransactionEmailsTab";
import { TransactionMessagesTab } from "../TransactionMessagesTab";

jest.mock("../../../../contexts", () => ({
  useAuth: () => ({ currentUser: { id: "user-1", email: "me@example.com" } }),
}));

const noop = () => undefined;

describe("the discovery popup copy (founder-dictated)", () => {
  it("renders the four dictated lines, with N computed as L + R", () => {
    render(
      <ReviewPromptDialog variant="found" count={3} linkedCount={5} onReview={noop} onDismiss={noop} />,
    );

    // "N total communications found" — N is L + R (5 + 3), never a separate number.
    expect(screen.getByText("8 total communications found")).toBeInTheDocument();
    expect(screen.getByText("5 linked successfully")).toBeInTheDocument();
    expect(screen.getByText("3 require review")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Communications that require review will only be linked after you approve them.",
      ),
    ).toBeInTheDocument();
  });

  it("labels the affirmative action 'Review now' and leaves 'Later' alone", () => {
    render(
      <ReviewPromptDialog variant="found" count={1} linkedCount={0} onReview={noop} onDismiss={noop} />,
    );
    expect(screen.getByRole("button", { name: "Review now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Later" })).toBeInTheDocument();
  });

  it("L=0: drops the linked line, keeps the total and the review line", () => {
    // Founder ruling 2026-08-22: a zero line is noise. The total always shows.
    render(
      <ReviewPromptDialog variant="found" count={4} linkedCount={0} onReview={noop} onDismiss={noop} />,
    );
    expect(screen.getByText("4 total communications found")).toBeInTheDocument();
    expect(screen.queryByText("0 linked successfully")).not.toBeInTheDocument();
    expect(screen.getByText("4 require review")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Communications that require review will only be linked after you approve them.",
      ),
    ).toBeInTheDocument();
  });

  it("R=0: drops the review line AND the approval sentence with it", () => {
    // Symmetric with L=0 — and the approval sentence is meaningless when
    // nothing is waiting for approval.
    render(
      <ReviewPromptDialog variant="found" count={0} linkedCount={6} onReview={noop} onDismiss={noop} />,
    );
    expect(screen.getByText("6 total communications found")).toBeInTheDocument();
    expect(screen.getByText("6 linked successfully")).toBeInTheDocument();
    expect(screen.queryByText("0 require review")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Communications that require review will only be linked after you approve them.",
      ),
    ).not.toBeInTheDocument();
  });
});

describe("the empty-state placeholder respects pending review items", () => {
  const emailProps = {
    communications: [],
    loading: false,
    unlinkingCommId: null,
    onViewEmail: jest.fn(),
    onShowUnlinkConfirm: jest.fn(),
    userId: "user-1",
    transactionId: "tx-1",
    hasContacts: true,
  };

  it("emails: linked=0 + pending>0 → NO placeholder", () => {
    render(<TransactionEmailsTab {...emailProps} hasReviewItems />);
    expect(screen.queryByText("No emails linked")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Sync emails from assigned contacts or attach manually"),
    ).not.toBeInTheDocument();
  });

  it("emails: linked=0 + pending=0 → placeholder present", () => {
    render(<TransactionEmailsTab {...emailProps} hasReviewItems={false} />);
    expect(screen.getByText("No emails linked")).toBeInTheDocument();
    expect(
      screen.getByText("Sync emails from assigned contacts or attach manually"),
    ).toBeInTheDocument();
  });

  const textProps = {
    messages: [],
    loading: false,
    error: null,
    userId: "user-1",
    transactionId: "tx-1",
    hasContacts: true,
  };

  it("texts: linked=0 + pending>0 → NO placeholder", () => {
    render(<TransactionMessagesTab {...textProps} hasReviewItems />);
    expect(screen.queryByText("No text messages linked")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Sync messages from assigned contacts or attach manually"),
    ).not.toBeInTheDocument();
  });

  it("texts: linked=0 + pending=0 → placeholder present", () => {
    render(<TransactionMessagesTab {...textProps} hasReviewItems={false} />);
    expect(screen.getByText("No text messages linked")).toBeInTheDocument();
    expect(
      screen.getByText("Sync messages from assigned contacts or attach manually"),
    ).toBeInTheDocument();
  });
});

describe("names resolve on review cards (the regression the founder reported)", () => {
  const textItem = {
    id: "pending:t1",
    rowId: "t1",
    origin: "pending" as const,
    kind: "text" as const,
    transaction_id: "tx-1",
    email_id: null,
    thread_id: "th-1",
    found_at: "2026-08-01T00:00:00.000Z",
    display: {
      title: "+15550142",
      subtitle: "+15550142",
      snippet: "hi",
      occurredAt: "2026-06-01T00:00:00.000Z",
      itemCount: 1,
      // A TEXT item is one row per thread; its grouping key IS its thread.
      threadId: "th-1",
      recipients: null,
      cc: null,
      sender: "+15550142",
      hasAttachments: false,
      threadParticipants: ["+15550142"],
      threadMessages: [
        {
          id: "m-1",
          thread_id: "th-1",
          body_text: "hi",
          sent_at: "2026-06-01T00:00:00.000Z",
          direction: "inbound",
          participants_flat: "+15550142",
          channel: "sms",
        },
      ],
    },
  };

  it("a TEXT sender whose number is in the contact book shows the NAME, not the number", async () => {
    // The exact failure mode reported: raw handles instead of contacts. The
    // card resolves through `contactNames`, which the Texts tab injects.
    const { ReviewQueueSection } = await import("../ReviewQueueSection");
    render(
      <ReviewQueueSection
        items={[textItem]}
        kind="text"
        onApprove={async () => undefined}
        onReject={async () => undefined}
        contactNames={{ "+15550142": "Paul Buyer", "5550142": "Paul Buyer" }}
      />,
    );

    expect(screen.getAllByText("Paul Buyer").length).toBeGreaterThan(0);
  });

  it("without a contact match it falls back to the raw handle rather than blanking", async () => {
    const { ReviewQueueSection } = await import("../ReviewQueueSection");
    render(
      <ReviewQueueSection
        items={[textItem]}
        kind="text"
        onApprove={async () => undefined}
        onReject={async () => undefined}
        contactNames={{}}
      />,
    );
    expect(screen.getAllByText("+15550142").length).toBeGreaterThan(0);
  });
});
