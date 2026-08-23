/**
 * BACKLOG-2804 (support ticket 111) — the seller's agent is a "Listing Agent".
 *
 * ===========================================================================
 * WHAT THE USER SAW
 * ===========================================================================
 * Transaction Details -> Key Contacts. The contact's own subtitle already
 * described them as a listing agent, and the role chip beside it read
 * "Seller Agent". One row, two names for one job. "Listing Agent" is the
 * industry term for the agent representing the seller, and it is the term the
 * founder approved.
 *
 * ===========================================================================
 * WHY THIS IS A DISPLAY FIX AND NOT A DATA FIX
 * ===========================================================================
 * `seller_agent` is the STORED enum value and it does not change here. It is
 * the only seller-side agent role the audit wizard offers
 * (AUDIT_WORKFLOW_STEPS "Client & Agents"), so it is what every real
 * assignment carries. `listing_agent` also exists in SPECIFIC_ROLES but is
 * vestigial — never offered by the wizard, reachable only through a contact's
 * saved `default_role`. Both must therefore render the SAME founder-facing
 * label, and neither may render "Seller Agent".
 *
 * Fixture shape follows `getTransactionContactsWithRoles`: flattened
 * `contact_*` aliases, `is_primary` as the NUMBER, counts as numbers, and
 * `specific_role` carrying the snake_case enum (transactionContactDbService
 * normalizes `role` from `specific_role` on write). Contacts use RFC 2606
 * domains.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionDetailsTab } from "../TransactionDetailsTab";
import type { Transaction } from "@/types";
import type { ContactAssignment } from "../../types";

// The preview/edit modals mount on card interaction and drag in heavy
// dependencies; these tests only read the card face.
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
    // The removed-contacts section mounts inside this tab and fetches on open.
    getRemovedContacts: jest.fn().mockResolvedValue({
      success: true,
      removedContacts: [],
    }),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

function makeAssignment(o: {
  contact_id: string;
  contact_name: string;
  specific_role: string;
}): ContactAssignment {
  return {
    id: `tc-${o.contact_id}`,
    contact_id: o.contact_id,
    contact_name: o.contact_name,
    contact_email: `${o.contact_id}@example.com`,
    contact_phone: "+15550100",
    contact_company: "Example Realty",
    contact_source: "manual",
    role: o.specific_role,
    specific_role: o.specific_role,
    is_primary: 0,
    contact_email_count: 1,
    contact_phone_count: 1,
    contact_removed_at: null,
  };
}

/**
 * A PURCHASE is the founder's reported case: he represents the buyer, so the
 * counterparty's agent — the one this chip names — is the listing agent.
 */
function renderTab(
  contactAssignments: ContactAssignment[],
  transactionType: string = "purchase",
) {
  const transaction = {
    id: "txn-2804",
    transaction_type: transactionType,
  } as unknown as Transaction;

  return render(
    <TransactionDetailsTab
      transaction={transaction}
      contactAssignments={contactAssignments}
      loading={false}
    />,
  );
}

describe("BACKLOG-2804: seller-side agent chip reads 'Listing Agent'", () => {
  it("renders 'Listing Agent' for a seller_agent assignment on a purchase", () => {
    // The founder's exact case, from the ticket-111 screenshot.
    renderTab([
      makeAssignment({
        contact_id: "contact-robin",
        contact_name: "Robin Example",
        specific_role: "seller_agent",
      }),
    ]);

    const card = screen.getByTestId("contact-summary-card-contact-robin");
    expect(card).toHaveTextContent("Listing Agent");
    expect(card).not.toHaveTextContent("Seller Agent");
  });

  it("renders 'Listing Agent' for a seller_agent assignment on a sale too", () => {
    // The label is the name of the job, not a function of which side the user
    // is on. A fix keyed off transaction_type would pass the purchase case and
    // fail here — that is exactly what this separates.
    renderTab(
      [
        makeAssignment({
          contact_id: "contact-robin",
          contact_name: "Robin Example",
          specific_role: "seller_agent",
        }),
      ],
      "sale",
    );

    const card = screen.getByTestId("contact-summary-card-contact-robin");
    expect(card).toHaveTextContent("Listing Agent");
    expect(card).not.toHaveTextContent("Seller Agent");
  });

  it("renders 'Listing Agent' for a stored listing_agent assignment", () => {
    // The vestigial enum value. Contacts carrying it predate this change and
    // must land on the same label, not a second one.
    renderTab([
      makeAssignment({
        contact_id: "contact-omar",
        contact_name: "Omar Example",
        specific_role: "listing_agent",
      }),
    ]);

    const card = screen.getByTestId("contact-summary-card-contact-omar");
    expect(card).toHaveTextContent("Listing Agent");
  });

  it("leaves the buyer-side agent label untouched", () => {
    // The negative control. Rewriting every agent label, or humanizing the
    // whole map to one string, would pass the cases above; this is the input
    // that separates "renamed the seller side" from "renamed everything".
    renderTab([
      makeAssignment({
        contact_id: "contact-dana",
        contact_name: "Dana Example",
        specific_role: "buyer_agent",
      }),
    ]);

    const card = screen.getByTestId("contact-summary-card-contact-dana");
    expect(card).toHaveTextContent("Buyer Agent");
    expect(card).not.toHaveTextContent("Listing Agent");
  });

  it("names each side correctly in a mixed list — identity, not count", () => {
    // Which ROW carries which label is the thing that matters. A chip attached
    // to the wrong card would pass a bare "the text appears somewhere" check.
    renderTab([
      makeAssignment({
        contact_id: "contact-robin",
        contact_name: "Robin Example",
        specific_role: "seller_agent",
      }),
      makeAssignment({
        contact_id: "contact-dana",
        contact_name: "Dana Example",
        specific_role: "buyer_agent",
      }),
    ]);

    expect(
      screen.getByTestId("contact-summary-card-contact-robin"),
    ).toHaveTextContent("Listing Agent");
    expect(
      screen.getByTestId("contact-summary-card-contact-dana"),
    ).toHaveTextContent("Buyer Agent");

    // And the retired term is nowhere on the tab.
    expect(screen.queryByText("Seller Agent")).not.toBeInTheDocument();
  });
});
