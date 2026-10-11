/**
 * BACKLOG-3764 — the submit pre-flight lists checklist evidence that would not
 * be sent. Gap shapes transcribed from the real harness
 * (`submissionChecklistSnapshot-3477.test.ts`, BACKLOG-3764 C2: the link on
 * "Inspection scheduled" after the date step moved the closing date, and the
 * never-downloaded `disclosure.pdf` on "Lead paint disclosure").
 */
import React from "react";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  CHECKLIST_LINKS_NOT_ATTACHED_COPY,
  SubmitForReviewModal,
  checklistLinkGapLine,
  type ChecklistLinkGapItem,
} from "../SubmitForReviewModal";
import { useSubmitForReview } from "../../../hooks/useSubmitForReview";
import type { Transaction } from "@/types";

const transaction = {
  id: "txn-3764",
  user_id: "user-3764",
  property_address: "14 Harbor View Rd",
  transaction_type: "purchase",
  status: "active",
  started_at: "2026-03-01",
  closed_at: "2026-03-01",
} as unknown as Transaction;

const OUTSIDE: ChecklistLinkGapItem = {
  key: "link:link-outside-1:outside_audit_dates:0123456789abcdef",
  linkId: "link-outside-1",
  itemTitle: "Inspection scheduled",
  label: "Inspection booked",
  kind: "email",
  reason: "outside_audit_dates",
  detail: null,
  missingIds: ["e-inspection"],
  sentAt: "2026-03-03T10:00:00Z",
  auditStart: "2026-03-01",
  auditEnd: "2026-03-01",
};
const NOT_INCLUDED: ChecklistLinkGapItem = {
  key: "link:link-nobytes-2:not_included:fedcba9876543210",
  linkId: "link-nobytes-2",
  itemTitle: "Lead paint disclosure",
  label: "disclosure.pdf",
  kind: "attachment",
  reason: "not_included",
  detail: "cannot_be_sent",
  missingIds: ["att-nobytes"],
  sentAt: null,
  auditStart: "2026-03-01",
  auditEnd: "2026-03-01",
};

function renderModal(overrides: Partial<React.ComponentProps<typeof SubmitForReviewModal>> = {}) {
  const props = {
    onCancel: jest.fn(),
    onSubmit: jest.fn(),
    onPreflightBack: jest.fn(),
    onPreflightContinue: jest.fn(),
    onCancelSubmit: jest.fn(),
    onIncludeLinkGap: jest.fn(),
    ...overrides,
  };
  render(
    <SubmitForReviewModal
      transaction={transaction}
      emailCount={1}
      textThreadCount={0}
      attachmentCount={0}
      emailAttachmentCount={0}
      totalSizeBytes={0}
      isSubmitting={false}
      progress={null}
      error={null}
      {...props}
    />,
  );
  return props;
}

describe("BACKLOG-3764 — checklist evidence in the submit pre-flight", () => {
  it("an out-of-dates link is asked about with Include it; the other is listed as not included", () => {
    const props = renderModal({ preflightItems: [], preflightLinkGaps: [OUTSIDE, NOT_INCLUDED] });
    const outside = screen.getByTestId("submit-review-link-gap-outside");
    expect(outside).toHaveTextContent("Inspection scheduled: Inspection booked");
    expect(outside).toHaveTextContent(
      "This email is from Mar 3, outside this deal's audit dates (Mar 1 – Mar 1). Include it in the submission anyway?",
    );
    expect(screen.getByTestId("submit-review-link-gap-not-included")).toHaveTextContent(
      "Not included on this checklist item (Lead paint disclosure): disclosure.pdf — it can't be sent (listed above).",
    );
    fireEvent.click(screen.getByTestId("submit-review-link-gap-include"));
    expect(props.onIncludeLinkGap).toHaveBeenCalledWith(OUTSIDE);
    // Leaving it out is Continue anyway — the agent was told, so it is not silent.
    fireEvent.click(screen.getByTestId("submit-review-preflight-continue"));
    expect(props.onPreflightContinue).toHaveBeenCalledTimes(1);
  });

  it("the not-included wording never says 'will not be sent' (a duplicate's file may still go up)", () => {
    for (const detail of ["not_on_transaction", "cannot_be_sent", "message_not_sent", "not_sent"] as const) {
      const line = checklistLinkGapLine({ ...NOT_INCLUDED, detail });
      expect(line.startsWith("Not included on this checklist item")).toBe(true);
      expect(line).not.toMatch(/will not be sent/);
    }
  });

  it("on success, evidence dropped that was never listed is said plainly", () => {
    renderModal({ progress: { stage: "complete", stageProgress: 100, overallProgress: 100 }, checklistLinksNotAttached: true });
    expect(screen.getByTestId("submit-review-checklist-links-not-attached")).toHaveTextContent(CHECKLIST_LINKS_NOT_ATTACHED_COPY);
  });
});

describe("BACKLOG-3764 — useSubmitForReview with checklist link gaps", () => {
  const submit = jest.fn();
  const submitPreflight = jest.fn();
  const includeLinkOutsideDates = jest.fn();
  beforeEach(() => {
    [submit, submitPreflight, includeLinkOutsideDates].forEach((f) => f.mockReset());
    (window as unknown as { api: unknown }).api = {
      transactions: { submit, resubmit: jest.fn(), submitPreflight, cancelSubmit: jest.fn(), onSubmitProgress: () => () => undefined },
      checklists: { includeLinkOutsideDates },
    };
  });

  /** MUTATION: send when only link gaps are listed -> submit called before Continue -> red. */
  it("link gaps alone stop the submit; Continue sends their keys", async () => {
    submitPreflight.mockResolvedValue({ success: true, notIncluded: [], checklistLinkGaps: [OUTSIDE, NOT_INCLUDED] });
    submit.mockResolvedValue({ success: true, submissionId: "s-1", notIncluded: [] });
    const { result } = renderHook(() => useSubmitForReview({ transactionId: "txn-3764" }));
    await act(async () => {
      await result.current.submit();
    });
    expect(submit).not.toHaveBeenCalled();
    expect(result.current.preflightItems).toEqual([]);
    expect(result.current.preflightLinkGaps).toEqual([OUTSIDE, NOT_INCLUDED]);
    await act(async () => {
      await result.current.confirmPreflight();
    });
    expect(submit).toHaveBeenCalledWith("txn-3764", { acceptedExclusionKeys: [OUTSIDE.key, NOT_INCLUDED.key] });
  });

  it("Include it stores the answer for that link, then checks again", async () => {
    submitPreflight
      .mockResolvedValueOnce({ success: true, notIncluded: [], checklistLinkGaps: [OUTSIDE] })
      .mockResolvedValueOnce({ success: true, notIncluded: [], checklistLinkGaps: [NOT_INCLUDED] });
    includeLinkOutsideDates.mockResolvedValue({ success: true, changed: true });
    const { result } = renderHook(() => useSubmitForReview({ transactionId: "txn-3764" }));
    await act(async () => {
      await result.current.submit();
    });
    await act(async () => {
      await result.current.includeLinkGap(OUTSIDE);
    });
    expect(includeLinkOutsideDates).toHaveBeenCalledWith({ transactionId: "txn-3764", linkId: OUTSIDE.linkId });
    expect(submitPreflight).toHaveBeenCalledTimes(2);
    expect(result.current.preflightLinkGaps).toEqual([NOT_INCLUDED]);
    expect(submit).not.toHaveBeenCalled();
  });
});
