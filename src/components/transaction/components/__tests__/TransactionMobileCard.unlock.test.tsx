/**
 * Integration tests for TransactionMobileCard's BACKLOG-2090 / 2109 additions.
 *
 * TransactionMobileCard is the card the LIVE transaction list actually renders
 * for every row, so these prove:
 *   - the "Unlocked" badge appears iff isUnlocked is true (per exact tx);
 *   - the last-exported affordance appears iff the tx has an export timestamp.
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

describe("TransactionMobileCard — unlock badge (BACKLOG-2090)", () => {
  it("shows the 'Unlocked' badge when isUnlocked is true", () => {
    render(
      <TransactionMobileCard
        {...baseProps}
        transaction={makeTx({ id: "tx-unlocked" })}
        isUnlocked={true}
      />,
    );
    expect(screen.getByTestId("unlock-badge-unlocked")).toBeInTheDocument();
    expect(screen.queryByTestId("unlock-badge-locked")).not.toBeInTheDocument();
  });

  it("shows the subtle lock when isUnlocked is false", () => {
    render(
      <TransactionMobileCard
        {...baseProps}
        transaction={makeTx({ id: "tx-locked" })}
        isUnlocked={false}
      />,
    );
    expect(screen.getByTestId("unlock-badge-locked")).toBeInTheDocument();
    expect(screen.queryByTestId("unlock-badge-unlocked")).not.toBeInTheDocument();
  });

  it("defaults to locked when isUnlocked is omitted (fail-closed)", () => {
    render(
      <TransactionMobileCard {...baseProps} transaction={makeTx()} />,
    );
    expect(screen.getByTestId("unlock-badge-locked")).toBeInTheDocument();
  });
});

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
    render(
      <TransactionMobileCard {...baseProps} transaction={makeTx()} />,
    );
    expect(screen.queryByTestId("tx-last-exported")).not.toBeInTheDocument();
  });
});
