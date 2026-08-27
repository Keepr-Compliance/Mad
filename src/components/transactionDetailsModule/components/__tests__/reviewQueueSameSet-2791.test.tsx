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
 *
 * THE UNIT CHANGED (2026-08-23, founder ruling + Communication Lifecycle
 * Contract). This suite previously asserted identity per EMAIL: one review card
 * per pending item, keyed by item id. The contract makes the THREAD the unit of
 * display and decision, so the same invariant is now asserted one level up —
 * the union of what the two sections render, by THREAD KEY, equals what the
 * combined screen renders, equals the thread keys of the source set.
 *
 * That is a genuine change of meaning, not a fixture refresh: the fixture now
 * contains a same-thread PAIR (p1 + p2, the founder's recurring-invite shape),
 * three email ITEMS render as TWO cards, and a suite that still counted items
 * would call that a bug. The per-item guarantee has not been dropped, it has
 * moved: "grouping loses nothing" is asserted directly, so no item can vanish
 * between the set and the cards.
 */
import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ReviewQueueSection, groupReviewItemsByThread } from "../ReviewQueueSection";
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
      // Overridden per item below. Every real record carries the provider's
      // conversation id; an item with none is the exception, not the default.
      threadId: null,
      recipients: "me@example.com",
      cc: null,
      sender: "paul@example.com",
      body: null,
      bodyText: null,
      hasAttachments: false,
      threadParticipants: ["+15550142"],
      threadMessages: [
        {
          id: "m-1",
          thread_id: "th-1",
          body_text: "hello",
          sent_at: "2026-06-01T00:00:00.000Z",
          direction: "inbound",
          // BACKLOG-2814: both are part of the projection now.
          participants: null,
          thread_display_name: null,
          participants_flat: "+15550142",
          channel: "sms",
        },
      ],
    },
    ...over,
  };
}

/** Give an item a provider conversation id — the grouping key. */
function inThread(base: ReviewItemDto, threadId: string): ReviewItemDto {
  return { ...base, display: { ...base.display, threadId } };
}

/**
 * A deliberately mixed set: both kinds, both origins, and a SAME-THREAD PAIR.
 *
 * p1 and p2 share `thr-offer` — the founder's real case, two calendar invites
 * for a recurring meeting that the mail provider threads together. Five items,
 * FOUR threads. Any surface that still counts items reads this fixture as five.
 */
const SET: ReviewItemDto[] = [
  inThread(item({ id: "pending:p1", kind: "email", email_id: "e1" }), "thr-offer"),
  inThread(item({ id: "pending:p2", kind: "email", email_id: "e2" }), "thr-offer"),
  inThread(item({ id: "legacy:l1", kind: "email", email_id: "e3", origin: "legacy" }), "thr-legacy"),
  inThread(item({ id: "pending:t1", kind: "text", email_id: null, thread_id: "th-1" }), "th-1"),
  inThread(item({ id: "pending:t2", kind: "text", email_id: null, thread_id: "th-2" }), "th-2"),
];

/** The four thread keys the five items collapse to. */
const THREAD_KEYS = ["th-1", "th-2", "thr-legacy", "thr-offer"];

const noop = async () => undefined;

/**
 * The identity of a rendered review card is its THREAD KEY.
 *
 * BACKLOG-2791 (founder revert, 2026-08-22): the review surfaces render the
 * app's OWN cards — EmailThreadCard for emails, MessageThreadCard for texts —
 * so identity is read from each card's own testid. `data-thread-id` on the email
 * card and `data-thread-key` on the text wrapper both carry the group key, which
 * is the provider conversation id (or the item id for an unthreaded record).
 */
function renderedKeys(): string[] {
  const emailKeys = screen
    .queryAllByTestId("email-thread-card")
    .map((el) => el.getAttribute("data-thread-id") as string);
  const textKeys = screen
    .queryAllByTestId("review-item")
    .map((el) => el.getAttribute("data-thread-key") as string);
  return [...emailKeys, ...textKeys].sort();
}

describe("BACKLOG-2791 — the three renderings show the same set", () => {
  it("grouping loses nothing — every item in the set belongs to exactly one thread", () => {
    // The per-ITEM guarantee, kept explicit now that the cards are per-THREAD.
    // Without this, a grouping bug that silently dropped an item would leave
    // every other assertion in this file green.
    const groups = groupReviewItemsByThread(SET);
    const covered = groups.flatMap((g) => g.items.map((i) => i.id)).sort();
    expect(covered).toEqual(SET.map((i) => i.id).sort());
    expect(groups.map((g) => g.key).sort()).toEqual(THREAD_KEYS);
  });

  it("the same-thread pair renders as ONE card that acts on BOTH items", () => {
    const onApprove = jest.fn(async (_ids: string[]) => undefined);
    render(
      <ReviewQueueSection items={SET} kind="email" onApprove={onApprove} onReject={noop} />,
    );

    // Three email ITEMS, two email CARDS.
    expect(screen.queryAllByTestId("email-thread-card")).toHaveLength(2);

    const pair = screen
      .queryAllByTestId("email-thread-card")
      .find((el) => el.getAttribute("data-thread-id") === "thr-offer");
    expect(pair).toBeTruthy();

    // Confirm on that ONE card approves BOTH emails — asserted as an ID SET,
    // which is what makes this a test of the acts-on unit rather than of a count.
    fireEvent.click(within(pair as HTMLElement).getByTestId("confirm-thread-button"));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect([...onApprove.mock.calls[0][0]].sort()).toEqual(["pending:p1", "pending:p2"]);
  });

  it("emails-section ∪ texts-section === the combined screen === getReviewState", () => {
    const { unmount: unmountEmails } = render(
      <ReviewQueueSection items={SET} kind="email" onApprove={noop} onReject={noop} />,
    );
    const emailIds = renderedKeys();
    unmountEmails();

    const { unmount: unmountTexts } = render(
      <ReviewQueueSection items={SET} kind="text" onApprove={noop} onReject={noop} />,
    );
    const textIds = renderedKeys();
    unmountTexts();

    // BACKLOG-2791 point 12: the screen now shows TWO lists behind an
    // Emails | Texts switcher, so its full set is collected by visiting both
    // rather than read off one combined list.
    render(
      <NeedsReviewScreen
        items={SET}
        isLoading={false}
        onApprove={noop}
        onReject={noop}
        onClose={noop}
      />,
    );
    const screenEmailIds = renderedKeys();
    fireEvent.click(screen.getByTestId("needs-review-tab-text"));
    const screenTextIds = renderedKeys();
    const combinedIds = [...screenEmailIds, ...screenTextIds].sort();

    const unionIds = [...emailIds, ...textIds].sort();

    // The union of the two tabs is exactly the source set's threads...
    expect(unionIds).toEqual(THREAD_KEYS);
    // ...and so is the combined screen.
    expect(combinedIds).toEqual(THREAD_KEYS);
    // Stated directly, so a failure names the disagreement.
    expect(unionIds).toEqual(combinedIds);
  });

  it("the two sections PARTITION the set — no item appears on both tabs", () => {
    const { unmount } = render(
      <ReviewQueueSection items={SET} kind="email" onApprove={noop} onReject={noop} />,
    );
    const emailIds = renderedKeys();
    unmount();

    render(<ReviewQueueSection items={SET} kind="text" onApprove={noop} onReject={noop} />);
    const textIds = renderedKeys();

    expect(emailIds.filter((id) => textIds.includes(id))).toEqual([]);
    expect(emailIds).toEqual(["thr-legacy", "thr-offer"]);
    expect(textIds).toEqual(["th-1", "th-2"]);
  });

  it("a legacy item is rendered by the tab section, not silently dropped", () => {
    // The legacy population is the half that already existed. If a section
    // filtered it out, the badge would over-count relative to what the user can
    // actually act on — the disagreement the ruling forbids.
    render(<ReviewQueueSection items={SET} kind="email" onApprove={noop} onReject={noop} />);
    expect(renderedKeys()).toContain("thr-legacy");
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
        <TransactionEmailsTab
          reviewSection={
            <ReviewQueueSection items={SET} kind="email" onApprove={noop} onReject={noop} />
          }
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
    expect(renderedKeys()).toEqual(["thr-legacy", "thr-offer"]);

    // Exactly ONE needs-review surface exists in the tree — the shared one that
    // was passed in. The tab contributes none of its own, which is what stops
    // legacy items rendering twice at two granularities.
    expect(screen.getAllByTestId("needs-review-section")).toHaveLength(1);
    expect(screen.getAllByTestId("needs-review-list")).toHaveLength(1);

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
