/**
 * Tests for the Key Contacts "See all" expander (BACKLOG-1865)
 *
 * The Overview tab renders assigned contacts in the Key Contacts section. When a
 * transaction has more than KEY_CONTACTS_PREVIEW_COUNT (4) contacts, only the
 * first few are shown with a "See all (N)" expander; expanding reveals the full
 * list with a "Show less" affordance. Expansion is local UI state only.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionDetailsTab } from "../TransactionDetailsTab";
import type { Transaction } from "@/types";
import type { ContactAssignment } from "../../types";

// The preview/edit modals are only rendered on card interaction and pull in
// heavier dependencies — stub them so these tests stay focused on the expander.
jest.mock("../../../shared/ContactPreview", () => ({
  ContactPreview: () => null,
}));
jest.mock("../../../contact", () => ({
  ContactFormModal: () => null,
}));

const TOGGLE_TESTID = "key-contacts-see-all-toggle";

function makeAssignment(n: number): ContactAssignment {
  const id = String(n).padStart(2, "0");
  return {
    id: `assign-${id}`,
    contact_id: `c${id}`,
    contact_name: `Contact ${id}`,
    contact_email: `contact${id}@example.com`,
    role: "buyer",
  };
}

function makeAssignments(count: number): ContactAssignment[] {
  return Array.from({ length: count }, (_, i) => makeAssignment(i + 1));
}

const mockTransaction = {
  id: "txn-1",
  transaction_type: "purchase",
} as unknown as Transaction;

function renderTab(contactAssignments: ContactAssignment[]) {
  return render(
    <TransactionDetailsTab
      transaction={mockTransaction}
      contactAssignments={contactAssignments}
      loading={false}
    />
  );
}

function visibleContactCount(): number {
  return screen.queryAllByTestId(/^contact-summary-card-/).length;
}

describe("TransactionDetailsTab — Key Contacts See-all expander (BACKLOG-1865)", () => {
  it("renders all contacts and no expander when count is at or below the preview limit", () => {
    renderTab(makeAssignments(4));

    expect(visibleContactCount()).toBe(4);
    expect(screen.queryByTestId(TOGGLE_TESTID)).not.toBeInTheDocument();
  });

  it("renders all contacts and no expander when count is below the preview limit", () => {
    renderTab(makeAssignments(2));

    expect(visibleContactCount()).toBe(2);
    expect(screen.queryByTestId(TOGGLE_TESTID)).not.toBeInTheDocument();
  });

  it("shows only the first 4 contacts plus a 'See all (N)' toggle when there are more", () => {
    renderTab(makeAssignments(9));

    expect(visibleContactCount()).toBe(4);

    const toggle = screen.getByTestId(TOGGLE_TESTID);
    expect(toggle).toHaveTextContent("See all (9)");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // The 5th+ contacts are collapsed until expanded.
    expect(screen.queryByText("Contact 05")).not.toBeInTheDocument();
    expect(screen.queryByText("Contact 09")).not.toBeInTheDocument();
  });

  it("reveals all contacts and switches to 'Show less' when the toggle is clicked", () => {
    renderTab(makeAssignments(9));

    fireEvent.click(screen.getByTestId(TOGGLE_TESTID));

    expect(visibleContactCount()).toBe(9);
    expect(screen.getByText("Contact 09")).toBeInTheDocument();

    const toggle = screen.getByTestId(TOGGLE_TESTID);
    expect(toggle).toHaveTextContent("Show less");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("collapses back to the preview list when the toggle is clicked again", () => {
    renderTab(makeAssignments(9));

    const toggle = screen.getByTestId(TOGGLE_TESTID);
    fireEvent.click(toggle); // expand
    fireEvent.click(toggle); // collapse

    expect(visibleContactCount()).toBe(4);
    expect(screen.getByTestId(TOGGLE_TESTID)).toHaveTextContent("See all (9)");
    expect(screen.getByTestId(TOGGLE_TESTID)).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });
});
