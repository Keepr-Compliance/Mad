/**
 * BACKLOG-3925 — Needs Review match-kind tabs, pills and (i) explainer (mock v3).
 *
 * Items are shaped exactly as getReviewState projects them (reviewStateService.ts):
 * `matchReason` "address" | "contact", `display.threadId` the grouping key. One card
 * per THREAD; a thread's reason is the strongest among its items.
 */
import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ReviewQueueSection } from "../ReviewQueueSection";
import type { ReviewItemDto } from "../../../../../electron/types/ipc/window-api-transactions";
import type { ReviewMatchReason } from "../../../../../electron/types/ipc/reviewMatchReason";
import { REVIEW_MATCH_REASON_PRECEDENCE } from "../../../../../electron/types/ipc/reviewMatchReason";
import { REVIEW_MATCH_KINDS } from "../../utils/reviewMatchReasons";

function item(id: string, threadId: string, title: string, matchReason: ReviewMatchReason, kind: "email" | "text" = "email"): ReviewItemDto {
  return {
    id: `pending:${id}`,
    rowId: id,
    origin: "pending",
    kind,
    transaction_id: "tx-1",
    email_id: kind === "email" ? `e-${id}` : null,
    thread_id: kind === "text" ? threadId : null,
    found_at: "2026-08-01T00:00:00.000Z",
    matchReason,
    display: {
      title,
      subtitle: "someone@example.test",
      snippet: "Body.",
      occurredAt: "2026-03-01T00:00:00.000Z",
      itemCount: 1,
      threadId,
      recipients: "me@example.test",
      cc: null,
      sender: "someone@example.test",
      body: null,
      bodyText: "Body.",
      hasAttachments: false,
      threadParticipants: kind === "text" ? ["+12065550100"] : [],
      threadMessages: [],
    },
  };
}

const ITEMS: ReviewItemDto[] = [
  item("1", "th-1", "Updated payoff statement", "contact"),
  item("2", "th-2", "Showing feedback for 1428 Maple Ave", "address"),
  // Two emails in one thread, mixed reasons: ONE card, shown as an address match.
  item("3a", "th-3", "Neighbor fence survey", "contact"),
  item("3b", "th-3", "Neighbor fence survey", "address"),
];

function renderSection(items = ITEMS, kind: "email" | "text" = "email") {
  return render(
    <ReviewQueueSection items={items} kind={kind} onApprove={jest.fn().mockResolvedValue(undefined)} onReject={jest.fn().mockResolvedValue(undefined)} />,
  );
}

const subjects = () => screen.getAllByTestId("thread-subject").map((el) => el.textContent ?? "");
const pills = () => screen.queryAllByTestId("match-pill").map((el) => `${el.getAttribute("data-reason")}:${el.textContent}`);

describe("BACKLOG-3925 Needs Review tabs", () => {
  it("renderer kind table is in the main-process precedence order (mirror parity)", () => {
    expect(REVIEW_MATCH_KINDS.map((k) => k.reason)).toEqual([...REVIEW_MATCH_REASON_PRECEDENCE]);
  });

  it("tabs show thread counts that add up to the header count", () => {
    renderSection();
    expect(screen.getByTestId("needs-review-count").textContent).toBe("(3)");
    expect(screen.getByTestId("needs-review-filter-all").textContent).toBe("All (3)");
    expect(screen.getByTestId("needs-review-filter-address").textContent).toBe("Address match (2)");
    expect(screen.getByTestId("needs-review-filter-contact").textContent).toBe("Contact match (1)");
    expect(screen.getByTestId("needs-review-filter-all").getAttribute("aria-pressed")).toBe("true");
  });

  it("All tab: a pill after every subject, with the thread's strongest reason", () => {
    renderSection();
    expect(pills()).toEqual([
      "contact:Contact match · no address",
      "address:Address matched",
      "address:Address matched",
    ]);
    const pill = screen.getAllByTestId("match-pill")[1];
    expect(pill.className).toContain("bg-blue-100");
    expect(pill.className).toContain("text-blue-700");
    expect(screen.getAllByTestId("match-pill")[0].className).toContain("bg-purple-100");
    // Pill sits inside the subject block, right after the title.
    expect(within(screen.getAllByTestId("thread-subject")[1]).getByTestId("match-pill")).toBeTruthy();
  });

  it("Address match tab: only address threads, and no pills", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("needs-review-filter-address"));
    expect(subjects().map((s) => s.split("Someone")[0])).toEqual([
      "Showing feedback for 1428 Maple Ave",
      "Neighbor fence survey",
    ]);
    expect(pills()).toEqual([]);
  });

  it("Contact match tab: only contact threads, and no pills", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("needs-review-filter-contact"));
    expect(subjects().map((s) => s.split("Someone")[0])).toEqual(["Updated payoff statement"]);
    expect(pills()).toEqual([]);
  });

  it("an empty tab shows the mock's empty state", () => {
    renderSection([item("1", "th-1", "Updated payoff statement", "contact")]);
    fireEvent.click(screen.getByTestId("needs-review-filter-address"));
    expect(screen.getByTestId("needs-review-filter-empty").textContent).toBe(
      "No address-match emails need reviewSwitch to another tab to review the rest.",
    );
    expect(screen.queryAllByTestId("thread-subject")).toEqual([]);
  });

  it("(i) explains each kind with the mock's text", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("needs-review-info-button"));
    expect(screen.getByTestId("needs-review-info-address").textContent).toBe(
      "Address match: the email mentions this property's street number and name but isn't from a contact on the deal.",
    );
    expect(screen.getByTestId("needs-review-info-contact").textContent).toBe(
      "Contact match: it's from a contact on the deal but doesn't mention the property address.",
    );
    expect(screen.getByTestId("needs-review-info-popover").textContent).toContain(
      "These are messages Keepr wasn't sure belong to this deal.",
    );
  });

  it("texts: no tabs, no pills, the original explainer", () => {
    renderSection([item("t1", "chat-1", "+12065550100", "contact", "text")], "text");
    expect(screen.queryByTestId("needs-review-filter")).toBeNull();
    expect(pills()).toEqual([]);
    fireEvent.click(screen.getByTestId("needs-review-info-button"));
    expect(screen.getByTestId("needs-review-info-popover").textContent).toBe(
      "Text conversations found for contacts on this deal, within the audit period, that aren't linked yet. Keep the ones that belong (✓), remove the ones that don't (🗑).",
    );
  });
});
