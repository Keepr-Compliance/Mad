/**
 * BACKLOG-2850 — the client pill on Key Contacts must agree with the Type chip.
 *
 * ===========================================================================
 * THE DEFECT THE FOUNDER REPORTED, ON SCREEN
 * ===========================================================================
 * He opened a transaction and read, on one screen:
 *
 *     Type: Listing
 *     Buyer (Client)
 *
 * On a Listing the user is the listing agent, so the user's client is the
 * SELLER. The pill must read "Seller (Client)".
 *
 * ===========================================================================
 * WHY THE UNIT TEST DID NOT CATCH THIS, AND WHY THIS FILE EXISTS
 * ===========================================================================
 * `getRoleDisplayName` was SELF-CONSISTENT: it mapped `purchase` to
 * "Buyer (Client)" and its own unit test asserted exactly that, so both were
 * green while the screen was wrong. The premise was wrong, not the code's
 * agreement with itself.
 *
 * The two facts were never checked AGAINST EACH OTHER. BACKLOG-2850 relabelled
 * the enum `purchase` to display as "Listing", and the test that accompanied it
 * asserted the Type chip alone. Nothing rendered the chip and the client pill
 * in one tree and asserted they described the same side of the deal. That is
 * the assertion this file adds, and it is the reason it lives at the component
 * surface rather than beside the util.
 *
 * Every case therefore asserts the OPPOSITE label is ABSENT from the document.
 * A presence-only check passes under either premise.
 *
 * Fixture shape follows `getTransactionContactsWithRoles` — flattened
 * `contact_*` aliases, numeric `is_primary`/counts — copied from the sibling
 * suite TransactionDetailsTab.tombstonePills-2568.test.tsx. Contacts use RFC
 * 2606 domains.
 */

import React from "react";
import { render, screen, within } from "@testing-library/react";
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

const CLIENT_CARD = "contact-summary-card-contact-casey";

/** The client on the deal — the party whose pill the founder read. */
function clientAssignment(): ContactAssignment {
  return {
    id: "tc-contact-casey",
    contact_id: "contact-casey",
    contact_name: "Casey Example",
    contact_email: "casey@example.com",
    contact_phone: "+15550100",
    contact_company: "Example Realty",
    contact_source: "manual",
    role: "client",
    specific_role: "client",
    is_primary: 1,
    contact_email_count: 1,
    contact_phone_count: 1,
    contact_removed_at: null,
  };
}

function renderTabWithType(transaction_type: string) {
  return render(
    <TransactionDetailsTab
      transaction={{ id: "txn-1", transaction_type } as unknown as Transaction}
      contactAssignments={[clientAssignment()]}
      loading={false}
    />,
  );
}

describe("BACKLOG-2850: the client pill agrees with the transaction Type chip", () => {
  it('on a Listing (enum `purchase`) the client pill reads "Seller (Client)"', () => {
    // The founder's exact case, and the whole point of the file: BOTH facts are
    // asserted in ONE render. Either alone was green while the screen was wrong.
    renderTabWithType("purchase");

    // The chip he read.
    expect(screen.getByText("Listing")).toBeInTheDocument();

    // The pill he read, on the client's own card, matched EXACTLY.
    const card = screen.getByTestId(CLIENT_CARD);
    expect(within(card).getByText("Seller (Client)")).toBeInTheDocument();

    // The reported defect, asserted absent from the whole tree. Without this
    // the test passes under the old premise too.
    expect(screen.queryByText("Buyer (Client)")).not.toBeInTheDocument();
  });

  it('on a Sale the client pill reads "Buyer (Client)"', () => {
    // The mirror direction. On a sale the user is the buyer's agent, so the
    // client is the buyer. Asserted so the fix cannot be a blanket relabel.
    renderTabWithType("sale");

    expect(screen.getByText("Sale")).toBeInTheDocument();

    const card = screen.getByTestId(CLIENT_CARD);
    expect(within(card).getByText("Buyer (Client)")).toBeInTheDocument();

    expect(screen.queryByText("Seller (Client)")).not.toBeInTheDocument();
  });

  it('on `other` the client pill keeps its sideless "Client (Buyer/Seller)" label', () => {
    // `other` has no side, so it must take NEITHER side label. Pinned here so
    // the inversion fix cannot silently move a third case nobody looked at.
    // This is a collateral guard, not a discriminator: it stays GREEN when the
    // fix is reverted.
    renderTabWithType("other");

    const card = screen.getByTestId(CLIENT_CARD);
    expect(within(card).getByText("Client (Buyer/Seller)")).toBeInTheDocument();

    expect(screen.queryByText("Seller (Client)")).not.toBeInTheDocument();
    expect(screen.queryByText("Buyer (Client)")).not.toBeInTheDocument();
  });
});
