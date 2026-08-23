/**
 * BACKLOG-2791 — the founder's dictated copy, labels and empty-state rule.
 *
 * Every string here is TRANSCRIBED from the founder's 2026-08-22 dictation, not
 * paraphrased. If a test here fails on wording, the wording is the thing that
 * moved.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
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

/**
 * THE BUTTONS ARE PART OF THE SHAPE (founder walk, 2026-08-23).
 *
 * He hit the R=0 popup for real — "18 total communications found / 18 linked
 * successfully" — and it offered [Later] [Review now]. Both are nonsense there:
 * there is nothing to review now, and nothing to do later. That shape gets ONE
 * button, "Confirm", which just closes.
 *
 * So the three "found" shapes differ in their BUTTON SET, not only in their
 * lines, and each set is pinned here. Asserting the affirmative label alone
 * cannot see a stray dismiss button, which is exactly what he was shown.
 *
 * CONTROLS RUN (MEASURED):
 *  1. Always render both buttons (revert the R=0 branch) -> RED, 2 of 4 tests.
 *  2. Render only "Confirm" for every "found" shape      -> RED, 2 of 4 tests
 *     (the two R>0 shapes; the R=0 pair still passes, which is why control 1 is
 *     needed as well — neither mutation alone can fail all four).
 *  3. Wire Confirm to onReview instead of onDismiss      -> RED, 1 of 4 tests.
 */
describe("the popup's BUTTON SET is part of each shape", () => {
  /** Every button the dialog is currently offering, in DOM order. */
  const buttonNames = () =>
    screen.getAllByRole("button").map((b) => b.textContent?.trim());

  it("L>0 and R>0 — both buttons, unchanged", () => {
    render(
      <ReviewPromptDialog variant="found" count={3} linkedCount={5} onReview={noop} onDismiss={noop} />,
    );
    expect(buttonNames()).toEqual(["Later", "Review now"]);
  });

  it("L=0 and R>0 — both buttons, unchanged", () => {
    render(
      <ReviewPromptDialog variant="found" count={4} linkedCount={0} onReview={noop} onDismiss={noop} />,
    );
    expect(buttonNames()).toEqual(["Later", "Review now"]);
  });

  it("R=0 — ONE button, 'Confirm', and no 'Later' beside it", () => {
    // The founder's exact shape: 18 found, 18 linked, nothing to review.
    render(
      <ReviewPromptDialog variant="found" count={0} linkedCount={18} onReview={noop} onDismiss={noop} />,
    );
    expect(screen.getByText("18 total communications found")).toBeInTheDocument();
    // The whole set, not just the presence of Confirm — a leftover "Later"
    // is the defect, and `getByRole("button", { name: "Confirm" })` cannot see it.
    expect(buttonNames()).toEqual(["Confirm"]);
  });

  it("Confirm CLOSES — it must not open the review screen there is nothing to review in", () => {
    const onReview = jest.fn();
    const onDismiss = jest.fn();
    render(
      <ReviewPromptDialog variant="found" count={0} linkedCount={18} onReview={onReview} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onReview).not.toHaveBeenCalled();
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
      body: null,
      bodyText: null,
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
