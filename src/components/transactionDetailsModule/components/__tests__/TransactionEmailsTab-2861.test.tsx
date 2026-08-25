/**
 * BACKLOG-2861 — the Emails tab header counts ONLY what the list beneath it renders.
 *
 * THE DEFECT. `totalEmailCount` reduced over `emailThreads` (every attached
 * conversation) and the `<h3>` conversation count read `emailThreads.length`,
 * while the list below maps `linkedThreads`, which excludes every needs-review
 * thread. The founder's transaction had all six conversations in review, so the
 * header read "6 conversations (9 emails)" directly above a verifiably empty
 * container and he read the app as broken.
 *
 * FOUNDER DECISION 2026-08-25 (Option A): both numbers describe the LINKED set
 * only. He was shown and accepted the consequence — on his transaction the
 * header now reads "0 conversations (0 emails)" over an empty list. Option B
 * (labelling both sets, e.g. "0 linked · 6 in review") was rejected, so a review
 * count in this header would be a regression, not an improvement.
 *
 * WHAT THIS FILE PINS, and the mutation run to prove each can fail:
 *
 *  C1 — the header agrees with the list, across THREE fixtures (all linked,
 *    mixed, all needs-review). Both numbers are read out of the rendered DOM,
 *    never recomputed from the fixture by the same rule the component uses.
 *    MUTATION: restore `emailThreads` in either expression → red.
 *
 *  C2 — the all-needs-review case asserts THREE things TOGETHER: header 0/0,
 *    empty list, AND the Needs Review button visible. The third is what stops
 *    Option A becoming a silent drop; the first two alone would pass on a build
 *    where nine emails are attached, counted by nothing, listed by nothing and
 *    openable by nothing.
 *    MUTATION: hide the button at reviewCount > 0 → red (measured below).
 *
 *  C3 — reachability by ID SET, never by count. A count assertion is precisely
 *    what failed to catch the original defect: 6 and 9 were both *correct*
 *    numbers for the attached set, and the list was still empty.
 *
 * COVERAGE (UNION), NOT PARTITION — deliberate. An `address_missing` email
 * inside a MIXED thread renders in the linked card AND appears as a review item:
 * `threadMatchReason` is per-THREAD ("every email address_missing") while
 * `getReviewState`'s legacy population is per-EMAIL. That double-surface is
 * existing documented behaviour (BACKLOG-2831 dedups the two review STORES, not
 * this), so asserting the two sets are disjoint would go red on correct code.
 * What must hold is that nothing falls out of the union.
 *
 * THE REAL HEADER IS MOUNTED, not a stand-in, and `reviewCount` is derived
 * through the REAL `groupReviewItemsByThread` — the same function
 * `useReviewQueue` uses. An inline `items.length` here would have let a grouping
 * regression through.
 *
 * SCOPE NOTE. `deriveReviewItems` below mirrors the SQL predicate of
 * `getReviewState`'s legacy population so the header can be fed a realistic
 * count. It is a fixture, and it proves nothing about the service. The claim
 * that the service genuinely cannot disagree with this tab is carried by
 * `electron/services/__tests__/reviewStateService.tabReachability-2861.test.ts`,
 * which runs the REAL `getReviewState` against the REAL schema on real SQLite
 * and puts BOTH definitions on ONE set of rows.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionEmailsTab } from "../TransactionEmailsTab";
import { TransactionHeader } from "../TransactionHeader";
import { processEmailThreads, threadMatchReason } from "../EmailThreadCard";
import { groupReviewItemsByThread } from "../../utils/reviewThreads";
import type { Communication } from "../../types";
import type { Transaction } from "@/types";
import type { ReviewItemDto } from "../../../../../electron/types/ipc/window-api-transactions";

jest.mock("../../../../contexts", () => ({
  useAuth: () => ({ currentUser: { id: "user-1", email: "me@example.com" } }),
}));

jest.mock("@/contexts/NetworkContext", () => ({
  useNetwork: () => ({ isOnline: true }),
}));

const base = {
  user_id: "user-1",
  created_at: "2024-01-01T00:00:00Z",
  has_attachments: false,
  is_false_positive: false,
};

/**
 * One attached email, shaped the way `getCommunicationsWithMessages` projects it.
 *
 * `id` and `email_id` are BOTH set, to the SAME value, and that is transcribed
 * rather than convenient: the loader selects `COALESCE(m.id, e.id, c.id) as id`,
 * so for an email-linked row `id` IS `emails.id`. Every cross-layer assertion
 * below still keys on `email_id`, because that is the column `getReviewState`
 * returns and `ReviewItemDto.email_id` carries. Comparing `Communication.id`
 * across that boundary is the id-swap this repo has been bitten by repeatedly
 * (see the BACKLOG-2390 undo comment in TransactionEmailsTab.tsx, where the
 * caller passed communications ids into a column holding emails ids and the
 * restore silently matched nothing).
 */
function email(
  id: string,
  threadId: string,
  subject: string,
  matchReason: string | null,
  sentAt: string,
): Communication {
  return {
    ...base,
    id,
    email_id: id,
    subject,
    sender: `sender-${id}@example.com`,
    recipients: "me@example.com",
    thread_id: threadId,
    sent_at: sentAt,
    channel: "email",
    match_reason: matchReason as Communication["match_reason"],
  } as Communication;
}

// F1 — every conversation confidently linked. 2 threads, 3 emails.
const ALL_LINKED: Communication[] = [
  email("e-l1a", "t-l1", "Inspection scheduled", "address_found", "2024-01-10T10:00:00Z"),
  email("e-l1b", "t-l1", "Re: Inspection scheduled", "user_confirmed", "2024-01-11T10:00:00Z"),
  email("e-l2", "t-l2", "Signed disclosures", "manual", "2024-01-12T10:00:00Z"),
];

// F2 — mixed. 3 threads, 6 emails.
//  t-m1: BOTH emails address_missing        → needs-review (excluded from Linked)
//  t-m2: one address_missing, one found     → LINKED as a whole thread, and its
//                                             address_missing email is ALSO a
//                                             review item (the documented
//                                             double-surface the union allows)
//  t-m3: legacy NULL match_reason           → LINKED (NULL defaults address_found)
const MIXED: Communication[] = [
  email("e-m1a", "t-m1", "Quick question", "address_missing", "2024-01-10T10:00:00Z"),
  email("e-m1b", "t-m1", "Re: Quick question", "address_missing", "2024-01-10T12:00:00Z"),
  email("e-m2a", "t-m2", "Closing timeline", "address_missing", "2024-01-11T10:00:00Z"),
  email("e-m2b", "t-m2", "Re: Closing timeline", "address_found", "2024-01-11T12:00:00Z"),
  email("e-m3a", "t-m3", "Old legacy link", null, "2024-01-12T10:00:00Z"),
  email("e-m3b", "t-m3", "Re: Old legacy link", null, "2024-01-12T12:00:00Z"),
];

// F3 — the founder's transaction: 6 conversations, 9 emails, ALL address_missing.
// The exact counts from the report, so the numbers in the assertions below are
// the numbers he saw.
const ALL_NEEDS_REVIEW: Communication[] = [
  email("e-r1a", "t-r1", "Buyer intro", "address_missing", "2024-01-10T10:00:00Z"),
  email("e-r1b", "t-r1", "Re: Buyer intro", "address_missing", "2024-01-10T11:00:00Z"),
  email("e-r2a", "t-r2", "Lender question", "address_missing", "2024-01-11T10:00:00Z"),
  email("e-r2b", "t-r2", "Re: Lender question", "address_missing", "2024-01-11T11:00:00Z"),
  email("e-r3a", "t-r3", "Title update", "address_missing", "2024-01-12T10:00:00Z"),
  email("e-r3b", "t-r3", "Re: Title update", "address_missing", "2024-01-12T11:00:00Z"),
  email("e-r4", "t-r4", "Appraisal", "address_missing", "2024-01-13T10:00:00Z"),
  email("e-r5", "t-r5", "HOA docs", "address_missing", "2024-01-14T10:00:00Z"),
  email("e-r6", "t-r6", "Walkthrough", "address_missing", "2024-01-15T10:00:00Z"),
];

/**
 * Mirror of the SQL predicate in `getReviewState`'s legacy population:
 *   communications WHERE transaction_id = ? AND email_id IS NOT NULL
 *                    AND match_reason = 'address_missing'
 * PER-EMAIL, matching the service — NOT per-thread like `threadMatchReason`.
 */
function deriveReviewItems(comms: Communication[]): ReviewItemDto[] {
  return comms
    .filter((c) => c.email_id != null && c.match_reason === "address_missing")
    .map(
      (c) =>
        ({
          id: `legacy:${c.id}`,
          rowId: c.id,
          origin: "legacy",
          kind: "email",
          transaction_id: "txn-1",
          email_id: c.email_id ?? null,
          thread_id: c.thread_id ?? null,
          found_at: c.sent_at ?? "2024-01-01T00:00:00Z",
          display: {
            title: c.subject ?? "",
            subtitle: "",
            snippet: "",
            occurredAt: c.sent_at ?? null,
            itemCount: 1,
            threadId: c.thread_id ?? null,
            recipients: null,
            cc: null,
            sender: null,
            body: null,
            bodyText: null,
            hasAttachments: false,
            threadParticipants: [],
            threadMessages: [],
          },
        }) as unknown as ReviewItemDto,
    );
}

const TRANSACTION = {
  id: "txn-1",
  property_address: "123 Main St",
  submission_status: "draft",
  status: "active",
} as unknown as Transaction;

/**
 * Mounts the header and the tab from ONE fixture, wiring `reviewCount` and
 * `hasReviewItems` through the SAME derivations TransactionDetails uses
 * (`groupReviewItemsByThread(...).length` and `items.some(i => i.kind === "email")`).
 * Hand-setting those props would have made C2's button assertion vacuous.
 */
function renderTabWithHeader(comms: Communication[]) {
  const reviewItems = deriveReviewItems(comms);
  const reviewCount = groupReviewItemsByThread(reviewItems).length;
  const hasReviewItems = reviewItems.some((i) => i.kind === "email");

  const result = render(
    <>
      <TransactionHeader
        transaction={TRANSACTION}
        isPendingReview={false}
        isRejected={false}
        isApproving={false}
        isRejecting={false}
        isRestoring={false}
        onClose={jest.fn()}
        onShowRejectReasonModal={jest.fn()}
        onShowEditModal={jest.fn()}
        onApprove={jest.fn()}
        onRestore={jest.fn()}
        onShowExportModal={jest.fn()}
        onShowDeleteConfirm={jest.fn()}
        reviewCount={reviewCount}
        onShowNeedsReview={jest.fn()}
      />
      <TransactionEmailsTab
        communications={comms}
        loading={false}
        unlinkingCommId={null}
        onViewEmail={jest.fn()}
        onShowUnlinkConfirm={jest.fn()}
        userId="user-1"
        transactionId="txn-1"
        hasReviewItems={hasReviewItems}
        reviewSection={hasReviewItems ? <div data-testid="review-section" /> : null}
      />
    </>,
  );
  return { ...result, reviewItems, reviewCount };
}

/**
 * The tab's summary heading.
 *
 * Selected out of ALL level-3 headings rather than with `getByRole` alone: the
 * real TransactionHeader mounted above renders its own h3 (the property
 * address), so a bare query matches two nodes and throws.
 */
function emailsHeading(): HTMLElement {
  const headings = screen.getAllByRole("heading", { level: 3 });
  const match = headings.filter((h) => /conversation/.test(h.textContent ?? ""));
  if (match.length !== 1) {
    throw new Error(
      `Expected exactly one "conversations" heading, found ${match.length}: ` +
        headings.map((h) => JSON.stringify(h.textContent)).join(", "),
    );
  }
  return match[0];
}

/** Read the two numbers OUT OF THE RENDERED HEADING. */
function readHeaderNumbers(): { conversations: number; emails: number } {
  const text = emailsHeading().textContent ?? "";
  const conversations = /(\d+)\s+conversation/.exec(text);
  const emails = /\((\d+)\s+email/.exec(text);
  if (!conversations || !emails) {
    throw new Error(`Heading did not match "N conversations (M emails)": ${text}`);
  }
  return { conversations: Number(conversations[1]), emails: Number(emails[1]) };
}

/**
 * The emails ACTUALLY rendered by the list, derived from the DOM.
 *
 * Each card carries `data-thread-id`; the thread's membership comes from the
 * REAL `processEmailThreads`, i.e. the same grouping the component ran. Nothing
 * here re-applies `threadMatchReason`, so a broken filter cannot hide inside
 * the expectation.
 */
function renderedLinkedEmailIds(comms: Communication[]): Set<string> {
  const threads = processEmailThreads(comms);
  const rendered = screen.queryAllByTestId("email-thread-card");
  const ids = new Set<string>();
  for (const card of rendered) {
    const threadId = card.getAttribute("data-thread-id");
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) throw new Error(`Rendered card ${threadId} matches no processed thread`);
    for (const e of thread.emails) ids.add((e as Communication).email_id as string);
  }
  return ids;
}

describe("BACKLOG-2861 C1 — the header counts only what the list renders", () => {
  it.each([
    ["all linked", ALL_LINKED],
    ["mixed", MIXED],
    ["all needs-review (the founder's transaction)", ALL_NEEDS_REVIEW],
  ])("agrees with the rendered list: %s", (_label, comms) => {
    renderTabWithHeader(comms);

    const header = readHeaderNumbers();
    const cards = screen.queryAllByTestId("email-thread-card");

    // Conversations: the heading number IS the number of cards drawn.
    expect(header.conversations).toBe(cards.length);

    // Emails: the heading number IS the number of emails inside those cards.
    expect(header.emails).toBe(renderedLinkedEmailIds(comms as Communication[]).size);
  });

  it("reports the exact linked numbers for the mixed fixture, by identity", () => {
    // Pinned as literals so a change of rule shows up as a number change, not as
    // two derived sides moving together. t-m2 is LINKED despite holding one
    // address_missing email — the thread rule is "EVERY email missing".
    renderTabWithHeader(MIXED);
    expect(readHeaderNumbers()).toEqual({ conversations: 2, emails: 4 });

    const rendered = screen
      .queryAllByTestId("email-thread-card")
      .map((c) => c.getAttribute("data-thread-id"));
    // `thread-` prefix is the real key `getEmailThreadKey` builds from thread_id.
    expect(new Set(rendered)).toEqual(new Set(["thread-t-m2", "thread-t-m3"]));
  });
});

describe("BACKLOG-2861 C2 — all-needs-review: 0/0 over an empty list, WITH the button", () => {
  it("reads 0 conversations (0 emails), renders no cards, and keeps Needs Review reachable", () => {
    const { reviewCount } = renderTabWithHeader(ALL_NEEDS_REVIEW);

    // 1. The header the founder accepted.
    expect(readHeaderNumbers()).toEqual({ conversations: 0, emails: 0 });

    // 2. The list is empty — which is CORRECT here: nothing is confidently linked.
    expect(screen.queryAllByTestId("email-thread-card")).toHaveLength(0);

    // 3. ...and this is the assertion that makes 1 and 2 acceptable rather than a
    // silent drop. Nine emails are attached; the control that opens them exists.
    //
    // getAllBy, not getBy: TransactionHeader draws the action row twice — once
    // for the mobile breakpoint and once for the desktop one — so exactly one
    // match would be the wrong expectation, and asserting it would have failed
    // on correct markup.
    const buttons = screen.getAllByTestId("needs-review-button");
    expect(buttons.length).toBeGreaterThan(0);
    expect(reviewCount).toBeGreaterThan(0);

    // The badge shows the THREAD count, so it agrees with the six conversations
    // the tab is holding back rather than with the nine emails.
    for (const badge of screen.getAllByTestId("needs-review-badge")) {
      expect(badge).toHaveTextContent("6");
    }
  });

  it("does not smuggle a review count into the header (Option B was rejected)", () => {
    renderTabWithHeader(ALL_NEEDS_REVIEW);
    const heading = emailsHeading().textContent ?? "";
    expect(heading).not.toMatch(/review/i);
    expect(heading).not.toMatch(/\b6\b|\b9\b/);
  });
});

describe("BACKLOG-2861 C3 — every attached email is reachable, asserted by ID SET", () => {
  it.each([
    ["all linked", ALL_LINKED],
    ["mixed", MIXED],
    ["all needs-review (the founder's transaction)", ALL_NEEDS_REVIEW],
  ])("no email falls out of (rendered ∪ in-review): %s", (_label, comms) => {
    const { reviewItems } = renderTabWithHeader(comms as Communication[]);

    const attached = new Set(
      (comms as Communication[]).map((c) => c.email_id as string),
    );
    const linked = renderedLinkedEmailIds(comms as Communication[]);
    const inReview = new Set(
      reviewItems.map((i) => i.email_id).filter((id): id is string => id != null),
    );

    const reachable = new Set([...linked, ...inReview]);
    const dropped = [...attached].filter((id) => !reachable.has(id));

    // Named individually, so a failure says WHICH email vanished rather than
    // that two numbers differ.
    expect(dropped).toEqual([]);
    expect(attached.size).toBe((comms as Communication[]).length);
  });

  it("the tab's own partition loses nothing: rendered ∪ tab-classified-needs-review === attached", () => {
    // This half is about the TAB, independent of any review-queue state: the
    // component either draws a thread or hands it to the review surface, and
    // there is no third outcome. Uses the REAL threadMatchReason.
    renderTabWithHeader(ALL_NEEDS_REVIEW);

    const threads = processEmailThreads(ALL_NEEDS_REVIEW);
    const heldBack = new Set(
      threads
        .filter((t) => threadMatchReason(t) === "needs_review")
        .flatMap((t) => t.emails.map((e) => (e as Communication).email_id as string)),
    );
    const linked = renderedLinkedEmailIds(ALL_NEEDS_REVIEW);
    const attached = new Set(ALL_NEEDS_REVIEW.map((c) => c.email_id as string));

    expect(new Set([...linked, ...heldBack])).toEqual(attached);
    expect(heldBack.size).toBe(9);
    expect(linked.size).toBe(0);
  });
});
