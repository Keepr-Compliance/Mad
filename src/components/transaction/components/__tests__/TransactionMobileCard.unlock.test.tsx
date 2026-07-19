/**
 * Tests for TransactionMobileCard's export indicator (BACKLOG-2109) after the
 * founder-QA redesign (BACKLOG-2090).
 *
 * TransactionMobileCard is the card the LIVE transaction list actually renders
 * for every row, so these prove:
 *   - the last-exported affordance ("Exported <date>") appears iff the tx has an
 *     export timestamp;
 *   - it sits to the RIGHT of the address, on the same row (the founder-approved
 *     layout — the date replaces the removed unlock/lock badge);
 *   - the removed unlock/lock badges are GONE (negative assertion).
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import type { Transaction } from "@/types";
import { TransactionMobileCard } from "../TransactionMobileCard";
import { formatDate } from "@/utils/formatUtils";

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "tx-1",
    property_address: "123 Main St",
    status: "active",
    detection_status: "confirmed",
    detection_source: "manual",
    text_thread_count: 0,
    email_count: 0,
    export_status: "not_exported",
    export_count: 0,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  } as unknown as Transaction;
}

const baseProps = {
  selectionMode: false,
  isSelected: false,
  onTransactionClick: () => {},
  onCheckboxClick: () => {},
  formatDate,
};

describe("TransactionMobileCard — last exported (BACKLOG-2109)", () => {
  it("shows 'Exported <date>' when the tx has been exported", () => {
    render(
      <TransactionMobileCard
        {...baseProps}
        transaction={makeTx({ last_exported_on: "2026-07-12T10:00:00Z" })}
      />,
    );
    const el = screen.getByTestId("tx-last-exported");
    expect(el).toHaveTextContent("Exported Jul 12");
  });

  it("renders no last-exported affordance when never exported", () => {
    render(<TransactionMobileCard {...baseProps} transaction={makeTx()} />);
    expect(screen.queryByTestId("tx-last-exported")).not.toBeInTheDocument();
  });

  it("renders the last-exported date to the RIGHT of the address (same row)", () => {
    render(
      <TransactionMobileCard
        {...baseProps}
        transaction={makeTx({
          property_address: "789 Pine Rd",
          last_exported_on: "2026-07-12T10:00:00Z",
        })}
      />,
    );
    const address = screen.getByText("789 Pine Rd");
    const exported = screen.getByTestId("tx-last-exported");

    // Same layout row: the address heading and the exported date share the
    // nearest flex-row ancestor (address left, date right) — NOT stacked in
    // separate rows as before.
    const row = address.parentElement;
    expect(row).not.toBeNull();
    expect(row).toContainElement(exported);

    // The date follows the address in document order (address left, date right).
    const position = address.compareDocumentPosition(exported);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("TransactionMobileCard — unlock/lock badges removed (BACKLOG-2090 founder QA)", () => {
  it("renders NO unlock/lock badge (the exported date is the only export cue)", () => {
    render(
      <TransactionMobileCard
        {...baseProps}
        transaction={makeTx({ last_exported_on: "2026-07-12T10:00:00Z" })}
      />,
    );
    expect(screen.queryByTestId("unlock-badge-unlocked")).not.toBeInTheDocument();
    expect(screen.queryByTestId("unlock-badge-locked")).not.toBeInTheDocument();
  });
});
