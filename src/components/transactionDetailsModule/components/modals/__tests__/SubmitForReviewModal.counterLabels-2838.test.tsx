/**
 * BACKLOG-2838 — the Submit-for-review summary said "Email threads" over a
 * count of EMAILS.
 *
 * `transaction.email_count` is COUNT(DISTINCT c.email_id) — emails. It was
 * passed to a prop named `emailThreadCount` and rendered under the label
 * "Email threads:", so a deal with 99 emails across 40 conversations read
 * "Email threads: 99". The number was never wrong; the word around it was.
 *
 * This is the only LIVE surface that rendered that label against that value.
 * The filed instance (TransactionCard.tsx / TransactionListCard.tsx) is dead
 * code — nothing imports either component from a screen — and the card that IS
 * on screen, TransactionMobileCard, renders bare numbers beside an envelope and
 * a chat icon with no unit word at all.
 *
 * The counts stay as they are. Re-unitting `email_count` to threads would have
 * changed the number on the card the founder had just confirmed correct after a
 * restart, which is the "differently-wrong number" he ruled out. The word moves
 * to fit the value instead.
 *
 * `textThreadCount` genuinely IS threads (a stored column counting grouped
 * conversations), so the two labels are asymmetric ON PURPOSE — asserted below,
 * because an assertion that both say the same thing would be asserting the bug.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SubmitForReviewModal } from "../SubmitForReviewModal";
import type { Transaction } from "@/types";

/**
 * Partial fixture: this suite reads the summary block only.
 *
 * BACKLOG-3498: dated, so the date step's Next is enabled. A deal that can
 * still be submitted opens on the date step and the summary is on the next
 * screen. Date-only start (wizard, useAuditSubmission.ts:140-142) and
 * ISO-timestamp end (detection path,
 * electron/services/transactionService/transactionService.ts:958).
 */
const transaction = {
  id: "txn-2838",
  user_id: "user-2838",
  property_address: "18 Bellweather Lane",
  transaction_type: "purchase",
  status: "active",
  started_at: "2026-01-05",
  closed_at: "2026-03-14T18:22:05.000Z",
} as unknown as Transaction;

describe("BACKLOG-2838: the submit summary names what it counts", () => {
  /** Renders, then Next from the date step to the Submission Summary (BACKLOG-3498). */
  const renderModal = () => {
    const utils = renderUnadvanced();
    fireEvent.click(screen.getByTestId("submit-review-next"));
    expect(screen.getByText("Submission Summary")).toBeInTheDocument();
    return utils;
  };
  const renderUnadvanced = () =>
    render(
      <SubmitForReviewModal
        transaction={transaction}
        // The realistic shape from the founder's report: many more emails than
        // conversations. Under the old label this read "Email threads: 99".
        emailCount={99}
        textThreadCount={4}
        attachmentCount={12}
        emailAttachmentCount={9}
        totalSizeBytes={1024}
        isSubmitting={false}
        progress={null}
        error={null}
        onCancel={jest.fn()}
        onSubmit={jest.fn()}
      />,
    );

  it('labels the email figure "Emails", never "Email threads"', () => {
    renderModal();

    expect(screen.getByText("Emails:")).toBeInTheDocument();
    // The specific wrong word, named. A generic /email/i query would pass on
    // either label and prove nothing.
    expect(screen.queryByText("Email threads:")).not.toBeInTheDocument();
    expect(screen.getByText("99")).toBeInTheDocument();
  });

  it('still labels the text figure "Text threads", because that one IS threads', () => {
    renderModal();

    expect(screen.getByText("Text threads:")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });
});
