/**
 * BACKLOG-2493 — the transaction "Key Contacts" pane hands the card the contact's
 * LIVE sources, not the stale scalar.
 *
 * WHY THIS SURFACE NEEDS ITS OWN FIX AT ALL
 *
 * This pane mounts the SAME `ContactPreview` as Clients & Contacts, but it does
 * not get its contact from the contacts list. `handleContactCardClick` builds an
 * ephemeral object by hand out of the transaction assignment, so it carries
 * `assignment.contact_source` — the INSERT-time scalar — and nothing else. The
 * contacts list, by contrast, is stamped with `source_types` by
 * `attachLiveSources` before it ever reaches the renderer.
 *
 * So fixing only the Clients & Contacts card would have produced a WORSE state
 * than the bug: the card would say "Contacts App" for Casey while this pane still
 * said "Outlook" — the same component, the same person, two answers on screen at
 * once. Today both are wrong, which at least is consistent.
 *
 * WHAT IS ASSERTED HERE, AND WHAT IS ASSERTED ELSEWHERE
 *
 * This file pins the SEAM: that the live set fetched over IPC actually lands on
 * the contact object handed to `ContactPreview`, and that an absent set stays
 * absent rather than becoming `[]`. That `ContactPreview` then renders one pill
 * per live source is pinned by ContactPreview.sourcePills-2493.test.tsx, and
 * that the handler omits the field is pinned by
 * electron/handlers/__tests__/contactHandlers.getEditDataSourceTypes-2493.test.ts.
 *
 * `ContactPreview` is therefore replaced with a prop recorder: rendering the real
 * card here would test the pill logic a second time and would go green off the
 * fallback, which is exactly the absorption that hides this class of bug.
 *
 * Fixture shape follows `getTransactionContactsWithRoles` (flattened `contact_*`
 * aliases, `is_primary` as a NUMBER). RFC 2606 domains, NANP numbers.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionDetailsTab } from "../TransactionDetailsTab";
import type { Transaction } from "@/types";
import type { ContactAssignment } from "../../types";
import type { ExtendedContact } from "../../../../types/components";

/** Every contact object handed to ContactPreview, in order. */
const previewContacts: ExtendedContact[] = [];

jest.mock("../../../shared/ContactPreview", () => ({
  ContactPreview: (props: { contact: ExtendedContact }) => {
    previewContacts.push(props.contact);
    return <div data-testid="contact-preview-stub" />;
  },
}));
jest.mock("../../../contact", () => ({ ContactFormModal: () => null }));

const CONTACT_ID = "contact-casey";

const mockGetEditData = jest.fn();
const mockCheckCanDelete = jest.fn();

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window as any).api = (window as any).api ?? {};
  (window as any).api.contacts = {
    ...((window as any).api.contacts ?? {}),
    getEditData: (...a: unknown[]) => mockGetEditData(...a),
    checkCanDelete: (...a: unknown[]) => mockCheckCanDelete(...a),
  };
  (window as any).api.transactions = {
    ...((window as any).api.transactions ?? {}),
    getRemovedContacts: jest.fn().mockResolvedValue({ success: true, removedContacts: [] }),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

beforeEach(() => {
  previewContacts.length = 0;
  jest.clearAllMocks();
  mockCheckCanDelete.mockResolvedValue({ success: true, transactions: [] });
});

/**
 * Casey as the transaction knows him: `contact_source` is "outlook", the stale
 * scalar left behind after his Outlook link was unlinked.
 */
function caseyAssignment(): ContactAssignment {
  return {
    id: "tc-casey",
    contact_id: CONTACT_ID,
    contact_name: "Casey Lane",
    contact_email: "p.lane@example.com",
    contact_phone: "+12065550142",
    contact_company: "Example Realty",
    contact_source: "outlook",
    role: "buyer",
    specific_role: "buyer",
    is_primary: 0,
    contact_email_count: 1,
    contact_phone_count: 1,
    contact_removed_at: null,
  } as ContactAssignment;
}

const mockTransaction = {
  id: "txn-1",
  user_id: "u1",
  transaction_type: "purchase",
} as unknown as Transaction;

function openCaseysCard() {
  render(
    <TransactionDetailsTab
      transaction={mockTransaction}
      contactAssignments={[caseyAssignment()]}
      loading={false}
    />,
  );
  fireEvent.click(screen.getByTestId(`contact-summary-card-${CONTACT_ID}`));
}

/** The latest contact object ContactPreview was rendered with. */
function latestPreviewContact(): ExtendedContact {
  return previewContacts[previewContacts.length - 1];
}

describe("Key Contacts pane hands ContactPreview the live source set (BACKLOG-2493)", () => {
  it("merges source_types from getEditData, overriding the stale scalar", () => {
    mockGetEditData.mockResolvedValue({
      success: true,
      emails: [{ id: "e1", email: "p.lane@example.com", is_primary: true }],
      phones: [{ id: "p1", phone: "+12065550142", is_primary: true }],
      // Casey's only surviving link is the Mac address book.
      source_types: ["contacts_app"],
    });

    openCaseysCard();

    return waitFor(() => {
      expect(latestPreviewContact().source_types).toEqual(["contacts_app"]);
    }).then(() => {
      // The scalar is still what the assignment carried — the fix does not
      // rewrite it, it stops the card depending on it.
      expect(latestPreviewContact().source).toBe("outlook");
    });
  });

  it("leaves source_types ABSENT when the contact has no links — never []", async () => {
    // The handler omits the field entirely for a contact with no crosswalk rows.
    mockGetEditData.mockResolvedValue({
      success: true,
      emails: [{ id: "e1", email: "p.lane@example.com", is_primary: true }],
      phones: [],
    });

    openCaseysCard();

    await waitFor(() => {
      expect(latestPreviewContact().allEmails).toEqual(["p.lane@example.com"]);
    });

    const contact = latestPreviewContact();
    // `in` distinguishes absent from present-and-undefined; the array check
    // pins the value this field must never hold. An unconditional spread would
    // pass the first assertion's intent but fail this one.
    expect("source_types" in contact).toBe(false);
    expect(contact.source_types).not.toEqual([]);
  });

  it("still shows the card when the edit-data fetch fails", async () => {
    mockGetEditData.mockRejectedValue(new Error("IPC unavailable"));

    openCaseysCard();

    await waitFor(() => {
      expect(screen.getByTestId("contact-preview-stub")).toBeInTheDocument();
    });
    // Falls back to the assignment's own scalar rather than rendering nothing.
    expect(latestPreviewContact().source).toBe("outlook");
    expect(latestPreviewContact().source_types).toBeUndefined();
  });
});
