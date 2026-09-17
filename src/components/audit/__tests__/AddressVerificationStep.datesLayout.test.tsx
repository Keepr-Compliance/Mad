/**
 * AddressVerificationStep — step 1 dates section layout.
 *
 * Pins the pre-release polish pass, which had no permanent assertions: a revert
 * of any of these went green.
 *
 *   - Closing Date is not asked for here (optional in the data model; set from
 *     the Export modal instead)
 *   - Representation Start Date and End Date share ONE responsive grid row
 *   - the "(?)" span with a native `title` tooltip is gone, replaced by the
 *     shared InfoTooltip (an <svg>, no `title` attribute)
 *   - that one InfoTooltip sits on the "Transaction Dates" heading and explains
 *     BOTH dates; the start-date label has no icon, and the two helper lines
 *     that used to sit under the inputs are gone (founder, 2026-09-17,
 *     BACKLOG-3415)
 *   - End Date is deliberately optional — no asterisk, no `required`, no
 *     red-when-empty border. An empty end date is how an ongoing deal is
 *     represented (founder, 2026-09-16). Representation Start Date keeps all
 *     three, and that asymmetry is the point.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import AddressVerificationStep from "../AddressVerificationStep";
import type { AddressData } from "../../../hooks/useAuditTransaction";

const addressData: AddressData = {
  property_address: "123 Main St",
  property_street: "123 Main St",
  property_city: "Anytown",
  property_state: "CA",
  property_zip: "90210",
  property_coordinates: null,
  transaction_type: "purchase",
  started_at: "2025-01-15",
  closing_deadline: undefined,
  closed_at: undefined,
};

const baseProps = {
  addressData,
  onAddressChange: jest.fn(),
  onTransactionTypeChange: jest.fn(),
  onStartDateChange: jest.fn(),
  onClosingDateChange: jest.fn(),
  onEndDateChange: jest.fn(),
  onSelectSuggestion: jest.fn(),
  showAutocomplete: false,
  suggestions: [],
};

const renderStep = (overrides: Partial<AddressData> = {}) =>
  render(
    <AddressVerificationStep
      {...baseProps}
      addressData={{ ...addressData, ...overrides }}
    />,
  );

describe("AddressVerificationStep — dates section", () => {
  it("does not render a Closing Date field", () => {
    renderStep();
    expect(screen.queryByTestId("create-audit-closing-date-input")).toBeNull();
    expect(screen.queryByText(/Closing Date/i)).toBeNull();
    expect(screen.queryByText(/Scheduled closing date/i)).toBeNull();
  });

  it("puts Representation Start Date and End Date in one responsive grid row", () => {
    renderStep();
    const start = screen.getByTestId("create-audit-start-date-input");
    const end = screen.getByTestId("create-audit-end-date-input");

    // Each input sits in its own cell <div>; both cells must share one parent,
    // and that parent is the grid. A revert to a full-width Start Date block
    // above the row gives them different parents.
    const startCell = start.closest("div")!.parentElement!;
    const endCell = end.closest("div")!.parentElement!;
    expect(startCell).toBe(endCell);
    expect(startCell.className).toContain("grid");
    expect(startCell.className).toContain("grid-cols-1");
    expect(startCell.className).toContain("sm:grid-cols-2");
  });

  it("puts the one InfoTooltip on the Transaction Dates heading, not on the start-date label", () => {
    const { container } = renderStep();
    const heading = screen.getByText("Transaction Dates");
    const startLabel = screen
      .getByTestId("create-audit-start-date-input")
      .parentElement!.querySelector("label")!;
    const endLabel = screen
      .getByTestId("create-audit-end-date-input")
      .parentElement!.querySelector("label")!;

    // Exactly one info icon in the dates section, and it is the heading's.
    const icons = container.querySelectorAll('[data-testid="info-tooltip-trigger"]');
    expect(icons).toHaveLength(1);
    expect(heading.contains(icons[0])).toBe(true);
    expect(heading.querySelector("svg")).not.toBeNull();

    expect(startLabel.querySelector("svg")).toBeNull();
    expect(endLabel.querySelector("svg")).toBeNull();

    expect(container.querySelector("[title]")).toBeNull();
    expect(screen.queryByText("(?)")).toBeNull();
  });

  it("explains both dates in that one tooltip", async () => {
    const user = userEvent.setup();
    renderStep();
    const heading = screen.getByText("Transaction Dates");
    await user.hover(heading.querySelector('[data-testid="info-tooltip-trigger"]')!);

    const bubble = screen.getByRole("tooltip");
    expect(bubble).toHaveTextContent(
      "Representation Start Date: when you started representing this client on this deal.",
    );
    expect(bubble).toHaveTextContent(
      "End Date: the last date you communicated with the client about this transaction, by text or email.",
    );
  });

  it("no longer renders the helper lines under the date inputs", () => {
    const { container } = renderStep();
    expect(screen.queryByText(/The date you began representing this client/i)).toBeNull();
    expect(screen.queryByText(/When transaction ended/i)).toBeNull();
    expect(container.textContent).not.toMatch(/began representing this client/i);
    expect(container.textContent).not.toMatch(/When transaction ended/i);

    // Each date cell is now exactly its label and its input.
    for (const testId of ["create-audit-start-date-input", "create-audit-end-date-input"]) {
      const cell = screen.getByTestId(testId).parentElement!;
      expect(Array.from(cell.children).map((el) => el.tagName)).toEqual(["LABEL", "INPUT"]);
    }
  });

  it("marks Representation Start Date required, and End Date not", () => {
    renderStep();
    const start = screen.getByTestId("create-audit-start-date-input");
    const end = screen.getByTestId("create-audit-end-date-input");
    const startLabel = start.parentElement!.querySelector("label")!;
    const endLabel = end.parentElement!.querySelector("label")!;

    expect(startLabel.textContent).toContain("Representation Start Date *");
    expect(start).toBeRequired();

    expect(endLabel.textContent!.trim()).toBe("End Date");
    expect(endLabel.textContent).not.toContain("*");
    expect(end).not.toBeRequired();
  });

  it("flags an empty Representation Start Date in red, but never an empty End Date", () => {
    const { unmount } = renderStep({ started_at: "" });
    expect(
      screen.getByTestId("create-audit-start-date-input").className,
    ).toContain("border-red-300");
    // closed_at is undefined here too — an ongoing deal, which is not an error.
    expect(
      screen.getByTestId("create-audit-end-date-input").className,
    ).not.toContain("border-red-300");
    unmount();

    renderStep({ started_at: "2025-01-15" });
    expect(
      screen.getByTestId("create-audit-start-date-input").className,
    ).toContain("border-gray-300");
  });
});
