/**
 * BACKLOG-2568 — "Deleted contact" on the LIVE Key Contacts list.
 *
 * ===========================================================================
 * THE BUG THE FOUNDER REPORTED
 * ===========================================================================
 * He removed Pete from Clients & Contacts. Pete was correctly ABSENT from the
 * Edit Contacts picker, and correctly still PRESENT under the transaction's Key
 * Contacts — a party to a deal must not vanish from an audit record, because a
 * PDF already exported names him. Both halves are right. Nothing on screen said
 * so, so the two surfaces read as contradicting each other and the only way to
 * know they did not was to have designed it.
 *
 * ===========================================================================
 * WHY THIS COULD NOT BE FIXED IN THE RENDERER ALONE
 * ===========================================================================
 * `getTransactionContactsWithRoles` aliased seven `c.` columns and
 * `c.removed_at` was not one of them, so the renderer had no way to tell a
 * deleted contact from a live one. This task adds the alias; the SQL half is
 * pinned in electron/services/db/__tests__/transactionContactDbService.tombstone.test.ts
 * against the REAL driver, including the fixture format used below.
 *
 * ===========================================================================
 * WHY ONLY ONE OF THE TWO LABELS APPEARS HERE
 * ===========================================================================
 * Every assignment on this list is LIVE on the deal — the query filters
 * `tc.removed_at IS NULL` — so the junction tombstone is unreachable here and
 * the deal-removal label belongs to RemovedTransactionContactsSection, which
 * has its own suite (including the co-occurrence and precedence cases).
 *
 * Fixture timestamps are the real SQLite `datetime('now')` shape,
 * "YYYY-MM-DD HH:MM:SS" — NOT ISO-8601. Contacts use RFC 2606 domains.
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

const CONTACT_PILL = "contact-tombstone-pill-contact-removed";
const DEAL_PILL = "contact-tombstone-pill-deal-removed";

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

/**
 * A live Key Contacts row. Field shape follows
 * `getTransactionContactsWithRoles`: flattened `contact_*` aliases, `is_primary`
 * as the NUMBER 1, counts as numbers.
 */
function makeAssignment(o: {
  contact_id: string;
  contact_name: string;
  contact_removed_at?: string | null;
}): ContactAssignment {
  return {
    id: `tc-${o.contact_id}`,
    contact_id: o.contact_id,
    contact_name: o.contact_name,
    contact_email: `${o.contact_id}@example.com`,
    contact_phone: "+15550100",
    contact_company: "Example Realty",
    contact_source: "manual",
    role: "lender",
    specific_role: "lender",
    is_primary: 0,
    contact_email_count: 1,
    contact_phone_count: 1,
    contact_removed_at: o.contact_removed_at ?? null,
  };
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
    />,
  );
}

describe("BACKLOG-2568: deleted-contact label on Key Contacts", () => {
  it("labels a key contact whose address-book record was deleted", () => {
    // C3 — the founder's exact case. Pete is still party to the deal (this list
    // only contains live assignments) but is gone from Clients & Contacts.
    renderTab([
      makeAssignment({
        contact_id: "contact-pete",
        contact_name: "Pete Example",
        contact_removed_at: "2026-08-06 14:22:41",
      }),
    ]);

    expect(screen.getByText("Pete Example")).toBeInTheDocument();

    const pill = screen.getByTestId(CONTACT_PILL);
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent("Deleted contact");

    // The deal-removal label must NOT appear here: Pete is on this deal. Using
    // one pill for both states was explicitly rejected by the founder.
    expect(screen.queryByTestId(DEAL_PILL)).not.toBeInTheDocument();
  });

  it("shows NO pill on an ordinary key contact", () => {
    // C5 — the negative case. Without it a pill rendered unconditionally would
    // pass C3: presence alone cannot separate "correct" from "always on".
    renderTab([
      makeAssignment({
        contact_id: "contact-dana",
        contact_name: "Dana Example",
      }),
    ]);

    expect(screen.getByText("Dana Example")).toBeInTheDocument();
    expect(screen.queryByTestId(CONTACT_PILL)).not.toBeInTheDocument();
  });

  it("labels only the deleted contacts in a mixed list", () => {
    // Identity, not count: which ROW carries the pill is the thing that matters.
    // A pill attached to the wrong card would pass a bare count assertion.
    renderTab([
      makeAssignment({ contact_id: "contact-dana", contact_name: "Dana Example" }),
      makeAssignment({
        contact_id: "contact-pete",
        contact_name: "Pete Example",
        contact_removed_at: "2026-08-06 14:22:41",
      }),
      makeAssignment({ contact_id: "contact-omar", contact_name: "Omar Example" }),
    ]);

    expect(screen.getAllByTestId(CONTACT_PILL)).toHaveLength(1);

    const peteCard = screen.getByTestId("contact-summary-card-contact-pete");
    expect(peteCard.querySelector(`[data-testid="${CONTACT_PILL}"]`)).not.toBeNull();

    for (const id of ["contact-dana", "contact-omar"]) {
      const card = screen.getByTestId(`contact-summary-card-${id}`);
      expect(card.querySelector(`[data-testid="${CONTACT_PILL}"]`)).toBeNull();
    }
  });

  it("treats an empty-string tombstone as no tombstone", () => {
    // Boundary: the guard is `!= null`, so a NULL from SQLite and an absent
    // field both mean "live". An empty string is not a timestamp and must not
    // light the pill — a truthiness check and a null check agree here, but a
    // later switch to `!== undefined` would not, and this says which is meant.
    renderTab([
      makeAssignment({
        contact_id: "contact-dana",
        contact_name: "Dana Example",
        contact_removed_at: "",
      }),
    ]);

    expect(screen.queryByTestId(CONTACT_PILL)).not.toBeInTheDocument();
  });
});
