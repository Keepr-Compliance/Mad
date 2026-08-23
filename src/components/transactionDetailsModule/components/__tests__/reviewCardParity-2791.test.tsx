/**
 * BACKLOG-2791 points 10 & 11 — the review surfaces must render the app's OWN
 * cards, with the SAME props the tabs pass. Founder, 2026-08-22: "really keep
 * the same as it was" — the only intended difference is the View label and the
 * click handlers.
 *
 * The two defects these pin, both of which were MISSING PROPS rather than
 * redesigns:
 *   - the email card's third row (body preview) reads `body_text`; the
 *     projection supplied only `body_plain` (the name of the underlying `emails`
 *     COLUMN), so the row silently rendered as two rows instead of three;
 *   - the text card resolves a sender through `contactNames[raw] ||
 *     contactNames[normalized]`; the review path looked up the raw key only, so
 *     a handle stored in normalized form rendered as a bare number.
 *
 * THE UNIT CHANGED (2026-08-23, Communication Lifecycle Contract). "Parity with
 * the tabs' card" used to mean one review card per pending EMAIL. It now means
 * what it means on the tabs: one card per THREAD. The single-item cases below
 * are unaffected — a lone email is a thread of one, and every row, label and
 * affordance they pin is the same. What is new is the last block: a genuine
 * multi-email thread must render as ONE card carrying the tabs' own "(N emails)"
 * label, which is the parity claim that could not even be expressed while the
 * unit was the email.
 */
import React from "react";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { ReviewQueueSection } from "../ReviewQueueSection";
import type { ReviewItemDto } from "../../../../../electron/types/ipc/window-api-transactions";

jest.mock("../../../../contexts", () => ({
  useAuth: () => ({ currentUser: { id: "user-1", email: "me@example.com" } }),
}));

const noop = async () => undefined;

const PREVIEW =
  "Hi Daniel, attaching the signed addendum for the inspection contingency ahead of Friday.";

const emailItem: ReviewItemDto = {
  id: "pending:e1",
  rowId: "e1",
  origin: "pending",
  kind: "email",
  transaction_id: "tx-1",
  email_id: "e1",
  thread_id: null,
  found_at: "2026-08-01T00:00:00.000Z",
  display: {
    title: "Inspection addendum",
    subtitle: "paul@example.com",
    snippet: PREVIEW,
    occurredAt: "2026-06-01T00:00:00.000Z",
    itemCount: 1,
    threadId: "thr-addendum",
    recipients: "me@example.com",
    cc: null,
    sender: "paul@example.com",
    hasAttachments: false,
    threadParticipants: [],
    threadMessages: [],
  },
};

const textItem: ReviewItemDto = {
  id: "pending:t1",
  rowId: "t1",
  origin: "pending",
  kind: "text",
  transaction_id: "tx-1",
  email_id: null,
  thread_id: "th-1",
  found_at: "2026-08-01T00:00:00.000Z",
  display: {
    title: "+15555550142",
    subtitle: "+15555550142",
    snippet: "on my way",
    occurredAt: "2026-06-01T00:00:00.000Z",
    itemCount: 1,
    threadId: "th-1",
    recipients: null,
    cc: null,
    sender: "+15555550142",
    hasAttachments: false,
    threadParticipants: ["+15555550142"],
    threadMessages: [
      {
        id: "m-1",
        thread_id: "th-1",
        body_text: "on my way",
        sent_at: "2026-06-01T00:00:00.000Z",
        direction: "inbound",
        // BACKLOG-2814: the projection returns both; a fixture that omits them
        // describes a row shape threadDisplay cannot produce.
        participants: null,
        thread_display_name: null,
        participants_flat: "+15555550142",
        channel: "sms",
      },
    ],
  },
};

describe("point 10 — the email review card keeps its THIRD row", () => {
  it("renders the body-preview line, not just subject and participants", () => {
    render(
      <ReviewQueueSection items={[emailItem]} kind="email" onApprove={noop} onReject={noop} />,
    );
    // Row 3. It reads `body_text`; supplying only `body_plain` rendered nothing.
    expect(screen.getByText(PREVIEW)).toBeInTheDocument();
  });

  it("renders all three rows on the SAME card element", () => {
    render(
      <ReviewQueueSection items={[emailItem]} kind="email" onApprove={noop} onReject={noop} />,
    );
    const card = screen.getByTestId("email-thread-card");
    expect(within(card).getByText("Inspection addendum")).toBeInTheDocument(); // row 1
    expect(within(card).getByText(/paul@example\.com|Paul/)).toBeInTheDocument(); // row 2
    expect(within(card).getByText(PREVIEW)).toBeInTheDocument(); // row 3
  });

  it("truncates a long preview the way the card always has (120 chars + ellipsis)", () => {
    const long = "z".repeat(300);
    render(
      <ReviewQueueSection
        items={[{ ...emailItem, display: { ...emailItem.display, snippet: long } }]}
        kind="email"
        onApprove={noop}
        onReject={noop}
      />,
    );
    expect(screen.getByText(`${"z".repeat(120)}...`)).toBeInTheDocument();
  });
});

describe("point 11 — the review sections use the tabs' own cards", () => {
  it("emails: the shared EmailThreadCard, and the view button reads 'View'", () => {
    render(
      <ReviewQueueSection items={[emailItem]} kind="email" onApprove={noop} onReject={noop} />,
    );
    expect(screen.getByTestId("email-thread-card")).toBeInTheDocument();
    expect(screen.getByTestId("view-thread-button")).toHaveTextContent(/^View$/);
    // The card's own affordances, not a bespoke row.
    expect(screen.getByTestId("confirm-thread-button")).toBeInTheDocument();
    expect(screen.getByTestId("unlink-thread-button")).toBeInTheDocument();
  });

  it("texts: the shared MessageThreadCard, and the view button reads 'View'", () => {
    render(
      <ReviewQueueSection items={[textItem]} kind="text" onApprove={noop} onReject={noop} />,
    );
    expect(screen.getByTestId("toggle-thread-button")).toHaveTextContent(/^View$/);
    // Confirm lives INSIDE the card now, beside the card's own remove.
    expect(screen.getByTestId("confirm-thread-button")).toBeInTheDocument();
  });

  it("texts: a number in the book resolves to the NAME", () => {
    render(
      <ReviewQueueSection
        items={[textItem]}
        kind="text"
        onApprove={noop}
        onReject={noop}
        contactNames={{ "+15555550142": "Jane Seller" }}
      />,
    );
    expect(screen.getAllByText(/Jane Seller/).length).toBeGreaterThan(0);
  });

  it("texts: resolves via the NORMALIZED key too — the lookup the tab uses", () => {
    // The tab reads `contactNames[phoneNumber] || contactNames[normalized]`,
    // where normalized is the last 10 digits — for +1 555 555 0142 that is
    // "5555550142". Looking up the raw key alone is what left senders as bare
    // numbers whenever the book stored the normalized form.
    render(
      <ReviewQueueSection
        items={[textItem]}
        kind="text"
        onApprove={noop}
        onReject={noop}
        contactNames={{ "5555550142": "Jane Seller" }}
      />,
    );
    expect(screen.getAllByText(/Jane Seller/).length).toBeGreaterThan(0);
  });

  it("texts: a number NOT in the book falls back to the handle rather than blanking", () => {
    render(
      <ReviewQueueSection
        items={[textItem]}
        kind="text"
        onApprove={noop}
        onReject={noop}
        contactNames={{}}
      />,
    );
    expect(screen.getAllByText(/\+?15555550142/).length).toBeGreaterThan(0);
  });

  it("emails: names resolve through nameMap, as on the tab", () => {
    render(
      <ReviewQueueSection
        items={[emailItem]}
        kind="email"
        onApprove={noop}
        onReject={noop}
        nameMap={new Map([["paul@example.com", "Jane Seller"]])}
      />,
    );
    expect(screen.getAllByText(/Jane Seller/).length).toBeGreaterThan(0);
  });
});

describe("point 12 — S2 is two lists behind an Emails | Texts switcher", () => {
  const both = [emailItem, textItem];

  it("shows a switcher with a count per medium", async () => {
    const { NeedsReviewScreen } = await import("../NeedsReviewScreen");
    render(
      <NeedsReviewScreen
        items={both}
        isLoading={false}
        onApprove={noop}
        onReject={noop}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByTestId("needs-review-medium-tabs")).toBeInTheDocument();
    expect(screen.getByTestId("needs-review-tab-email")).toHaveTextContent("Emails");
    expect(screen.getByTestId("needs-review-tab-email")).toHaveTextContent("(1)");
    expect(screen.getByTestId("needs-review-tab-text")).toHaveTextContent("Texts");
  });

  it("shows ONE medium at a time — emails first, texts after switching", async () => {
    const { NeedsReviewScreen } = await import("../NeedsReviewScreen");
    render(
      <NeedsReviewScreen
        items={both}
        isLoading={false}
        onApprove={noop}
        onReject={noop}
        onClose={() => undefined}
      />,
    );

    // Emails list: the email card, and NOT the text card.
    expect(screen.getByTestId("email-thread-card")).toBeInTheDocument();
    expect(screen.queryByTestId("toggle-thread-button")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("needs-review-tab-text"));

    // Texts list: the text card, and NOT the email card.
    expect(screen.getByTestId("toggle-thread-button")).toBeInTheDocument();
    expect(screen.queryByTestId("email-thread-card")).not.toBeInTheDocument();
  });

  it("carries NO per-card type label — the switcher supplies the medium", async () => {
    const { NeedsReviewScreen } = await import("../NeedsReviewScreen");
    render(
      <NeedsReviewScreen
        items={[emailItem]}
        isLoading={false}
        onApprove={noop}
        onReject={noop}
        onClose={() => undefined}
      />,
    );
    const card = screen.getByTestId("email-thread-card");
    // The bespoke card stamped "Email"/"Text" on every row. The switcher label
    // is a tab, not part of the card.
    expect(within(card).queryByText(/^Email$/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/^Text$/)).not.toBeInTheDocument();
  });

  it("opens on the medium that actually has items", async () => {
    const { NeedsReviewScreen } = await import("../NeedsReviewScreen");
    render(
      <NeedsReviewScreen
        items={[textItem]}
        isLoading={false}
        onApprove={noop}
        onReject={noop}
        onClose={() => undefined}
      />,
    );
    // Emails is empty, so the screen must not land on an empty list.
    expect(screen.getByTestId("toggle-thread-button")).toBeInTheDocument();
  });

  it("uses the SAME card component as the tab sections — email preview row included", async () => {
    const { NeedsReviewScreen } = await import("../NeedsReviewScreen");
    render(
      <NeedsReviewScreen
        items={[emailItem]}
        isLoading={false}
        onApprove={noop}
        onReject={noop}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(PREVIEW)).toBeInTheDocument();
    expect(screen.getByTestId("view-thread-button")).toHaveTextContent(/^View$/);
  });
});

/**
 * THE UNIT, AT THE CARD LEVEL.
 *
 * Parity with the tabs' card now includes the tabs' own grouping: a provider
 * thread is one card that says how many emails it holds. Before the unit
 * changed, two emails of one conversation rendered as two identical-looking
 * cards with two Confirms — the shape the founder hit from the other direction
 * on Show removed, where one card hid a second email behind a single Restore.
 */
describe("the unit — one provider thread, one card", () => {
  const inThread = (id: string, threadId: string, title: string): ReviewItemDto => ({
    ...emailItem,
    id,
    rowId: id.split(":")[1] ?? id,
    email_id: id.split(":")[1] ?? id,
    display: { ...emailItem.display, threadId, title },
  });

  it("two emails sharing a thread_id render ONE card with the tabs' '(2 emails)' label", () => {
    render(
      <ReviewQueueSection
        items={[inThread("pending:a", "thr-x", "Re: Offer"), inThread("pending:b", "thr-x", "Re: Offer")]}
        kind="email"
        onApprove={noop}
        onReject={noop}
      />,
    );
    const cards = screen.queryAllByTestId("email-thread-card");
    expect(cards).toHaveLength(1);
    // The count label is the tabs' own, driven by EmailThread.emailCount.
    expect(within(cards[0]).getByText("(2 emails)")).toBeInTheDocument();
  });

  it("two emails in DIFFERENT threads stay two cards — grouping never merges on subject", () => {
    // Same subject, different conversations. The tabs' getEmailThreadKey would
    // fall back to the subject and merge these; the review surfaces must not,
    // because a merge here puts one Confirm in charge of two unrelated emails.
    render(
      <ReviewQueueSection
        items={[inThread("pending:a", "thr-x", "Offer"), inThread("pending:b", "thr-y", "Offer")]}
        kind="email"
        onApprove={noop}
        onReject={noop}
      />,
    );
    expect(screen.queryAllByTestId("email-thread-card")).toHaveLength(2);
    expect(screen.getByTestId("needs-review-count")).toHaveTextContent("(2)");
  });

  it("an unthreaded email is a thread of one — keyed by its item id", () => {
    render(
      <ReviewQueueSection
        items={[{ ...emailItem, display: { ...emailItem.display, threadId: null } }]}
        kind="email"
        onApprove={noop}
        onReject={noop}
      />,
    );
    const card = screen.getByTestId("email-thread-card");
    expect(card.getAttribute("data-thread-id")).toBe(emailItem.id);
    expect(screen.queryByText(/emails\)/)).not.toBeInTheDocument();
  });
});
