/**
 * BACKLOG-2805 (support ticket 112) — the transaction-type badge on the
 * details header.
 *
 * Same ruling as the Step 1 toggle: "Purchase" -> "Listing/Purchase" (exact,
 * with the slash), "Sale" unchanged, enum values untouched.
 *
 * The badge carries a COLOUR as well as a label, keyed off the same field, so
 * the colour is asserted too — a refactor that routed the label through the
 * shared map but dropped the colour branch would otherwise pass silently.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionDetailsTab } from "../TransactionDetailsTab";
import type { Transaction } from "@/types";

jest.mock("../../../shared/ContactPreview", () => ({
  ContactPreview: () => null,
}));
jest.mock("../../../contact", () => ({
  ContactFormModal: () => null,
}));

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window as any).api = (window as any).api ?? {};
  (window as any).api.transactions = {
    ...((window as any).api.transactions ?? {}),
    getRemovedContacts: jest.fn().mockResolvedValue({
      success: true,
      removedContacts: [],
    }),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

function renderTab(transactionType: string) {
  const transaction = {
    id: "txn-2805",
    transaction_type: transactionType,
  } as unknown as Transaction;

  return render(
    <TransactionDetailsTab
      transaction={transaction}
      contactAssignments={[]}
      loading={false}
    />,
  );
}

describe("BACKLOG-2805: transaction type badge", () => {
  it('reads "Listing/Purchase" on a purchase', () => {
    renderTab("purchase");

    const badge = screen.getByText("Listing/Purchase");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("bg-blue-100");
  });

  it('still reads "Sale" on a sale', () => {
    renderTab("sale");

    const badge = screen.getByText("Sale");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("bg-green-100");
    expect(screen.queryByText("Listing/Purchase")).not.toBeInTheDocument();
  });

  it('still reads "Other" for an unmapped type', () => {
    // Pre-existing behaviour of this badge specifically — it is the ONE
    // surface that already named `other` correctly, and the refactor must
    // not regress it to "Sale" the way the cards do.
    renderTab("other");

    const badge = screen.getByText("Other");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("bg-gray-100");
  });

  it('no bare "Purchase" is left on the header', () => {
    renderTab("purchase");
    expect(screen.queryByText("Purchase")).not.toBeInTheDocument();
  });
});
