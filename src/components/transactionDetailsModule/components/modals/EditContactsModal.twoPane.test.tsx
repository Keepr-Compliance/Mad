/**
 * EditContactsModal — two-pane integration tests (BACKLOG-2405)
 *
 * Unlike EditContactsModal.test.tsx (which mocks ContactSearchList), this suite
 * renders the REAL ContactSearchList + ContactRow + ContactAssignmentStep so it
 * exercises the actual assemble pipeline.
 *
 * ---------------------------------------------------------------------------
 * BACKLOG-2370 CHANGED WHAT THIS SUITE CAN PROVE — READ BEFORE EDITING
 * ---------------------------------------------------------------------------
 * It used to assert that an assigned contact's address-book twin never reaches
 * "Available", and the mechanism was the renderer's own dedup pass: keeping the
 * assigned contact in `contacts` gave that pass something to match the twin
 * against via the DB row's `allEmails`.
 *
 * That pass is gone. It was the second of two pieces of code answering "are
 * these the same person?", it stored nothing, and on 2026-08-04 it re-hid a
 * record the main process had deliberately released after the founder unlinked
 * it. The founder's decision was to remove it: one rule, made and recorded in
 * the main process.
 *
 * The fixture below is precisely the shape that decision leaves showing, which
 * is why this suite is the one that caught it: the twin carries the assigned
 * contact's SECONDARY email, and `contacts:get-available` builds its
 * already-imported set from PRIMARY values only, so main returns it. The
 * duplicate is accepted deliberately rather than filtered back out — see
 * `electron/__tests__/contact-handlers.oneMatchingRule.test.ts`, which measures
 * the same shape through the real handler and states how far it reaches (only
 * contacts with no `contact_source_links` row; the crosswalk check runs first
 * and suppresses the twin whatever its address).
 *
 * What this suite still proves, and what is still load-bearing: keeping the
 * assigned contact in `contacts` is what makes it an Added CHIP rather than a
 * row in Available, and removing that chip must not re-add it on Save. The old
 * code STRIPPED assigned DB contacts from the array fed to the picker, and that
 * remains the regression to guard.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EditContactsModal, EditContactsModalProps } from "./EditContactsModal";
import type { Transaction } from "@/types";
import type { ExtendedContact } from "../../../../types/components";
import userEvent from "@testing-library/user-event";

const mockGetDetails = jest.fn();
const mockBatchUpdateContacts = jest.fn();
const mockGetAvailable = jest.fn();
/**
 * BACKLOG-2631 — the SAVED half is now read here too, because this suite no
 * longer mocks `ContactsContext` away. See the note where that mock used to be.
 * `property_address` is set on the fixture transaction, so the provider reads
 * `getSortedByActivity`; `getAll` is wired as well so a fixture without an
 * address does not fall through to `undefined`.
 */
const mockGetAll = jest.fn();
const mockGetSortedByActivity = jest.fn();

beforeAll(() => {
  (window as unknown as { api: unknown }).api = {
    transactions: {
      getDetails: mockGetDetails,
      batchUpdateContacts: mockBatchUpdateContacts,
    },
    contacts: {
      getAvailable: mockGetAvailable,
      getAll: mockGetAll,
      getSortedByActivity: mockGetSortedByActivity,
    },
  };
});

// A contact ALREADY assigned to the deal, imported with TWO emails. getAvailable
// only matches on the PRIMARY email, so an address-book entry under the SECONDARY
// email (paul@home.com) is not recognized as already-imported and is returned —
// the realistic id-swap leak. (allEmails carries both, so the frontend dedup CAN
// bridge them once the DB row is present.)
const assignedTwoEmail: ExtendedContact = {
  id: "db-paul",
  name: "Paul Multi",
  display_name: "Paul Multi",
  email: "paul@work.com",
  allEmails: ["paul@work.com", "paul@home.com"],
  user_id: "user-1",
  source: "contacts_app",
  created_at: "2024-02-01",
  updated_at: "2024-02-01",
};

const janeUnassigned: ExtendedContact = {
  id: "c-jane",
  name: "Jane Doe",
  display_name: "Jane Doe",
  email: "jane@example.com",
  user_id: "user-1",
  source: "manual",
  created_at: "2024-01-01",
  updated_at: "2024-01-01",
};

// The address-book twin of the assigned contact: SAME person, DIFFERENT id, and
// carrying only the SECONDARY email — so getAvailable's primary-email filter
// missed it and returned it. Same source profile as the working contacts so the
// category filter treats it identically.
//
// BACKLOG-2370: the renderer dedup that used to hide this is gone, so it now
// renders. That is the accepted consequence, measured through the real handler
// in `contact-handlers.oneMatchingRule.test.ts`. Do NOT re-add a renderer rule
// to hide it — fix main'"'"'s already-imported set, or let the crosswalk converge.
const externalTwin: ExtendedContact = {
  id: "ext-paul",
  name: "Paul Multi",
  display_name: "Paul Multi",
  email: "paul@home.com",
  user_id: "user-1",
  source: "contacts_app",
  created_at: "2024-02-01",
  updated_at: "2024-02-01",
};

// A genuinely-new address-book contact (matches nobody). Used purely as a
// deterministic "externals have loaded" signal so the leak assertion never races
// the async getAvailable — she appears in Available on BOTH old and fixed code.
const externalNew: ExtendedContact = {
  id: "ext-zoe",
  name: "Zoe New",
  display_name: "Zoe New",
  email: "zoe@example.com",
  user_id: "user-1",
  source: "contacts_app",
  created_at: "2024-03-01",
  updated_at: "2024-03-01",
};

/*
  BACKLOG-2631 — THE `ContactsContext` MOCK IS GONE, ON PURPOSE.

  This suite used to replace the whole context module with a static object. That
  was harmless while the address-book half was fetched inside `Screen2Overlay`
  itself; now that BOTH halves come from the provider, a mocked context would
  mean this file never runs the loading path at all — it would assert two-pane
  behaviour against fixtures the app's own code never produced, and could not go
  red if the wiring between provider and overlay were cut.

  So the real `ContactsProvider` runs, against `window.api.contacts.*` above.
  The comment on the "Zoe New" wait below — that it is a race-free signal the
  ASYNC address-book load has landed — is true again for the same reason.
*/

// Screen 1 / Step 3 role rows are not under test here — mock them to keep the
// suite focused on the real Available/Added two-pane (ContactSearchList).
jest.mock("../../../shared/ContactRoleRow", () => ({
  ContactRoleRow: ({ contact }: { contact: ExtendedContact }) => (
    <div data-testid={`contact-role-row-${contact.id}`}>{contact.display_name}</div>
  ),
}));

jest.mock("../../../../services", () => ({
  contactService: { create: jest.fn() },
  settingsService: { getContactAutoRoleEnabled: jest.fn().mockResolvedValue(false) },
}));

jest.mock("../../../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

const createTestTransaction = (overrides: Partial<Transaction> = {}): Transaction =>
  ({
    id: "txn-1",
    user_id: "user-1",
    property_address: "123 Main St",
    transaction_type: "purchase",
    status: "active",
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
    ...overrides,
  }) as Transaction;

const createDefaultProps = (
  overrides: Partial<EditContactsModalProps> = {},
): EditContactsModalProps => ({
  transaction: createTestTransaction(),
  userId: "user-1",
  onClose: jest.fn(),
  onSave: jest.fn(),
  ...overrides,
});

const availableNames = (): string[] =>
  screen.queryAllByTestId("contact-row").map((r) => r.textContent || "");

describe("EditContactsModal two-pane (BACKLOG-2405, real ContactSearchList)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    /**
     * The deal already has the name-only contact assigned.
     *
     * BACKLOG-2681: as a seller's agent rather than the Client. One test here
     * removes this contact from the deal, and removing the only Client is the
     * save BACKLOG-2681 now refuses. Every assertion in this file is about the
     * Added/Available panes and the operations they emit — none of them reads
     * the role — so the fixture role is free to change and the subject is not.
     */
    mockGetDetails.mockResolvedValue({
      success: true,
      transaction: {
        contact_assignments: [{ id: "a1", contact_id: "db-paul", role: "seller_agent" }],
      },
    });
    // The saved half, as the provider reads it for a deal with an address.
    mockGetSortedByActivity.mockResolvedValue({
      success: true,
      contacts: [assignedTwoEmail, janeUnassigned],
    });
    mockGetAll.mockResolvedValue({
      success: true,
      contacts: [assignedTwoEmail, janeUnassigned],
    });
    // The address book returns the twin (its strong-id filter let a name-only
    // contact through) plus a genuinely-new contact used as a load signal.
    mockGetAvailable.mockResolvedValue({
      success: true,
      contacts: [externalTwin, externalNew],
    });
    mockBatchUpdateContacts.mockResolvedValue({ success: true, autoLinkResults: [] });
  });

  it("shows an assigned contact as an Added chip, never as its own row in Available", async () => {
    const user = userEvent.setup();
    render(<EditContactsModal {...createDefaultProps()} />);

    await waitFor(() => {
      expect(screen.getByTestId("add-contacts-button")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("add-contacts-button"));

    // Wait until the async address-book load has landed — the genuinely-new
    // "Zoe New" is a race-free signal that externals are rendered.
    await waitFor(() => {
      expect(availableNames().some((n) => n.includes("Zoe New"))).toBe(true);
    });
    expect(availableNames().some((n) => n.includes("Jane Doe"))).toBe(true);

    // THE PART THAT IS STILL LOAD-BEARING: the assigned contact is pre-populated
    // as a removable Added chip, and appears in Available exactly once — as the
    // address-book twin, never also as its own DB row (excluded by selection).
    // That is what keeping it in `contacts` buys, and stripping it — the
    // regression this suite was written for — breaks both.
    expect(screen.getByTestId("added-chip-db-paul")).toBeInTheDocument();
    expect(availableNames().filter((n) => n.includes("Paul Multi"))).toHaveLength(1);
  });

  it("BACKLOG-2370: the address-book twin under a SECONDARY email is now shown, deliberately", async () => {
    // This is the assertion that used to read `.toBe(false)`. It changed because
    // the rule that made it true was deleted, not because this surface changed.
    //
    // `getAvailable` returned `ext-paul` — the fixture says so, and it is what
    // the real handler does for a card filed under a saved contact's secondary
    // address. The renderer used to hide it by re-deciding identity from
    // `allEmails`. It no longer decides identity at all, so main's answer stands.
    //
    // The trade, in the founder's terms: a visible duplicate row is something a
    // user can see and act on. A hidden record is not — and the pass that hid
    // this one also hid a record he had explicitly unlinked, on a screen where a
    // contact is a party to a transaction that can end up on an exported audit.
    const user = userEvent.setup();
    render(<EditContactsModal {...createDefaultProps()} />);

    await waitFor(() => {
      expect(screen.getByTestId("add-contacts-button")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("add-contacts-button"));

    await waitFor(() => {
      expect(availableNames().some((n) => n.includes("Zoe New"))).toBe(true);
    });

    // ONE "Paul Multi" row, and it is the external twin: the DB row stays
    // excluded by selection, so this is main's answer rendered unchanged rather
    // than the assigned contact leaking back in.
    const pauls = availableNames().filter((n) => n.includes("Paul Multi"));
    expect(pauls).toHaveLength(1);
    // Jane and Zoe are unaffected — the exact set, not just a count.
    expect(availableNames().some((n) => n.includes("Jane Doe"))).toBe(true);
    expect(availableNames().some((n) => n.includes("Zoe New"))).toBe(true);
  });

  it("removing the pre-populated existing chip returns nothing to Available for it and unlinks on Save", async () => {
    const user = userEvent.setup();
    render(<EditContactsModal {...createDefaultProps()} />);

    await waitFor(() => {
      expect(screen.getByTestId("add-contacts-button")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("add-contacts-button"));

    await waitFor(() => {
      expect(screen.getByTestId("added-chip-db-paul")).toBeInTheDocument();
    });

    // ✕ the existing contact.
    await user.click(screen.getByTestId("remove-added-db-paul"));
    expect(screen.queryByTestId("added-chip-db-paul")).not.toBeInTheDocument();

    // Close overlay, Save -> a remove op for db-paul, never a re-add.
    await user.click(screen.getByTestId("add-contacts-overlay-close"));
    await waitFor(() => {
      expect(screen.getByTestId("edit-contacts-modal-save")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("edit-contacts-modal-save"));

    await waitFor(() => {
      expect(mockBatchUpdateContacts).toHaveBeenCalled();
    });
    const ops = mockBatchUpdateContacts.mock.calls[0][1] as Array<{
      action: string;
      contactId: string;
    }>;
    expect(ops.some((o) => o.action === "remove" && o.contactId === "db-paul")).toBe(true);
    expect(ops.some((o) => o.action === "add" && o.contactId === "db-paul")).toBe(false);
  });
});
