/**
 * BACKLOG-2805 (support ticket 112) — what the Transaction Type toggle is called.
 *
 * Founder ruling: the seller-side option keeps the word the user already knows
 * and gains the one they asked for — "Purchase" becomes **"Listing/Purchase"**,
 * exact string, with the slash. **"Sale" is unchanged.**
 *
 * DISPLAY ONLY. The values written to `transaction_type` stay `purchase` and
 * `sale` — they are a DB column, a Zod enum (electron/schemas/transaction.ts),
 * an LLM tool type and an e2e selector. So this suite asserts BOTH halves:
 * the words on the buttons, AND the enum each click emits. A change that
 * renamed the label by renaming the value would pass a label-only assertion
 * and break the database.
 *
 * This is Step 1 of Audit New Transaction, and — per the trace on BACKLOG-2805
 * — it is also the EDIT surface: there is no EditTransactionModal, editing
 * re-enters this same component via useAuditAddressForm.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import AddressVerificationStep from "../AddressVerificationStep";
import type { AddressData } from "../../../hooks/useAuditTransaction";

function renderStep(
  transactionType: string,
  onTransactionTypeChange = jest.fn(),
) {
  const addressData = {
    property_address: "1 Example Way",
    transaction_type: transactionType,
  } as unknown as AddressData;

  render(
    <AddressVerificationStep
      addressData={addressData}
      onAddressChange={jest.fn()}
      onTransactionTypeChange={onTransactionTypeChange}
      onStartDateChange={jest.fn()}
      onClosingDateChange={jest.fn()}
      onEndDateChange={jest.fn()}
      showAutocomplete={false}
      suggestions={[]}
      onSelectSuggestion={jest.fn()}
    />,
  );
  return { onTransactionTypeChange };
}

describe("BACKLOG-2805: Transaction Type toggle labels", () => {
  it('the buy-side button reads exactly "Listing/Purchase"', () => {
    renderStep("purchase");

    // Read off the testid, not the text: the testid is the stable handle (it
    // is also the e2e selector) and reading the label from it is what proves
    // the RIGHT button was renamed.
    expect(screen.getByTestId("create-audit-type-purchase")).toHaveTextContent(
      "Listing/Purchase",
    );
  });

  it('the sell-side button still reads exactly "Sale"', () => {
    renderStep("purchase");

    const saleButton = screen.getByTestId("create-audit-type-sale");
    expect(saleButton.textContent).toBe("Sale");
  });

  it('no button reads a bare "Purchase" any more', () => {
    renderStep("purchase");

    // Exact-text query: "Listing/Purchase" does not satisfy it, so this goes
    // red if either button is left on the old string.
    expect(screen.queryByText("Purchase")).not.toBeInTheDocument();
  });

  it("still emits the enum value `purchase`, not the label", () => {
    const { onTransactionTypeChange } = renderStep("sale");

    fireEvent.click(screen.getByTestId("create-audit-type-purchase"));

    expect(onTransactionTypeChange).toHaveBeenCalledWith("purchase");
    expect(onTransactionTypeChange).not.toHaveBeenCalledWith("Listing/Purchase");
  });

  it("still emits the enum value `sale`", () => {
    const { onTransactionTypeChange } = renderStep("purchase");

    fireEvent.click(screen.getByTestId("create-audit-type-sale"));

    expect(onTransactionTypeChange).toHaveBeenCalledWith("sale");
  });

  it("still highlights whichever side is selected", () => {
    // The selected-state styling keys off the ENUM. Renaming the label must
    // not disturb it — without this, a rename that also touched the comparison
    // would leave both buttons looking unselected and nothing would say so.
    renderStep("purchase");

    expect(screen.getByTestId("create-audit-type-purchase")).toHaveClass(
      "bg-indigo-500",
    );
    expect(screen.getByTestId("create-audit-type-sale")).not.toHaveClass(
      "bg-indigo-500",
    );
  });
});
