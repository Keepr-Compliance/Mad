/**
 * BACKLOG-3968 U2 — the submit pre-flight says why a text linked to a
 * checklist item is not sent.
 *
 * Gap shape: what `findChecklistLinkGaps` (electron/services/
 * submissionChecklistLinkGaps.ts:111-160) returns for a text group while text
 * links are held — kind "text", reason "not_included", detail "not_sent", the
 * writer's label "Text · <Month D, YYYY>" — as asserted on the real path by
 * electron/services/__tests__/submissionChecklistTextLinks-3968.test.ts.
 *
 * The renderer reads the gap, never the hold constant (it has exactly two
 * readers, both in electron/; checklistTextLinkHold-3968.test.ts pins that).
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  SubmitForReviewModal,
  TEXT_LINK_NOT_SENT_REASON,
  checklistLinkGapLine,
  type ChecklistLinkGapItem,
} from "../SubmitForReviewModal";
import type { Transaction } from "@/types";

const transaction = {
  id: "txn-3968",
  user_id: "user-3968",
  property_address: "14 Harbor View Rd",
  transaction_type: "purchase",
  status: "active",
  started_at: "2026-03-01",
  closed_at: "2026-03-31",
} as unknown as Transaction;

const TEXT_GAP: ChecklistLinkGapItem = {
  key: "link:L-texts:not_included:0123456789abcdef",
  linkId: "L-texts",
  itemTitle: "Inspection response",
  label: "Text · March 12, 2026",
  kind: "text",
  reason: "not_included",
  detail: "not_sent",
  missingIds: ["m-1", "m-2"],
  sentAt: null,
  auditStart: "2026-03-01",
  auditEnd: "2026-03-31",
};

describe("BACKLOG-3968 U2 — a text link in the pre-flight", () => {
  it("a held text link says, in one short sentence, why it is not sent", () => {
    render(
      <SubmitForReviewModal
        transaction={transaction}
        emailCount={1}
        textThreadCount={1}
        attachmentCount={0}
        emailAttachmentCount={0}
        totalSizeBytes={0}
        isSubmitting={false}
        progress={null}
        error={null}
        onCancel={jest.fn()}
        onSubmit={jest.fn()}
        onPreflightBack={jest.fn()}
        onPreflightContinue={jest.fn()}
        onCancelSubmit={jest.fn()}
        onIncludeLinkGap={jest.fn()}
        preflightItems={[]}
        preflightLinkGaps={[TEXT_GAP]}
      />,
    );
    const line = screen.getByTestId("submit-review-link-gap-not-included");
    expect(line).toHaveTextContent(
      "Not included on this checklist item (Inspection response): Text · March 12, 2026 — texts will be included after the next update.",
    );
    // Never the outside-the-dates question: there is no "Include it" for a text.
    expect(screen.queryByTestId("submit-review-link-gap-include")).not.toBeInTheDocument();
  });

  it("the sentence is short and plain (no jargon)", () => {
    expect(TEXT_LINK_NOT_SENT_REASON.split(" ").length).toBeLessThanOrEqual(10);
    expect(TEXT_LINK_NOT_SENT_REASON).not.toMatch(/migrat|cloud|hold|server|sync/i);
  });

  it("only a text's not_sent gets it; an email's not_sent keeps its own wording", () => {
    expect(checklistLinkGapLine({ ...TEXT_GAP, kind: "email" })).not.toContain(TEXT_LINK_NOT_SENT_REASON);
    expect(checklistLinkGapLine({ ...TEXT_GAP, detail: "not_on_transaction" })).toContain(
      "it is no longer on this transaction.",
    );
  });
});
