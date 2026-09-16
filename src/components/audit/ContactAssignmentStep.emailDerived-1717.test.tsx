/**
 * BACKLOG-1717 — picking a person found in email must SAVE them.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION THIS PINS
 * ---------------------------------------------------------------------------
 * The picker has two halves, and which half a record arrives in decides what
 * happens when the user clicks it:
 *
 *   ADDRESS-BOOK half  ->  `contacts:import` runs, and the deal is given the
 *                          SAVED contact's id.
 *   SAVED half         ->  the row is treated as already in the database. No
 *                          contact is created, and the deal is given the
 *                          synthetic `email_…` id — a person who does not
 *                          exist.
 *
 * The second is not hypothetical: it is the shape BACKLOG-3194 records for
 * people found in texts, where the audit wizard can attach a pseudo-contact
 * with no row behind it. This item puts email people in the first half so that
 * cannot happen to them, and P2 below is the control that proves the two are
 * actually distinguishable rather than the test asserting its own arrangement.
 *
 * Mutation that reds P1: hand the record to the `contacts` prop instead of
 * `externalContacts` — i.e. append it to the saved half in the handler.
 */

import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import ContactAssignmentStep from "./ContactAssignmentStep";
import type { Contact } from "../../../electron/types/models";

jest.mock("../../services", () => ({
  contactService: { create: jest.fn() },
  settingsService: { getContactAutoRoleEnabled: jest.fn().mockResolvedValue(false) },
}));

const ADDRESS = "avery@example.com";
const SAVED_ID = "550e8400-e29b-41d4-a716-446655440222"; // pii-allow-uuid: invented, not from any live row

/**
 * The record the producer emits, carried through the handler unchanged.
 * `source` is the synthetic value the vocabulary now holds — NOT `email`,
 * which the import door refuses outright, so a fixture using it would red for
 * an unrelated reason.
 */
const EMAIL_PERSON = {
  id: `email_${ADDRESS}`,
  user_id: "user-1717",
  display_name: "Avery Example",
  name: "Avery Example",
  email: ADDRESS,
  allEmails: [ADDRESS],
  phone: null,
  company: null,
  source: "email_derived",
  is_imported: 0,
  is_message_derived: 1,
  last_communication_at: "2026-09-02T10:00:00.000Z",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as unknown as Contact;

function props(over: Record<string, unknown>) {
  return {
    step: 2,
    contactAssignments: {},
    selectedContactIds: [] as string[],
    onSelectedContactIdsChange: jest.fn(),
    onAssignContact: jest.fn(),
    onRemoveContact: jest.fn(),
    userId: "user-1717",
    transactionType: "purchase",
    propertyAddress: "1 Example Way",
    contacts: [] as Contact[],
    contactsLoading: false,
    contactsError: null,
    onRefreshContacts: jest.fn(),
    onRefreshBothLists: jest.fn().mockResolvedValue(undefined),
    externalContacts: [] as Contact[],
    externalContactsLoading: false,
    showCategoryFilter: true,
    ...over,
  };
}

const row = (id: string) => document.querySelector(`[data-contact-id="${id}"]`) as HTMLElement;
const importMock = () => jest.mocked(window.api.contacts.import);

beforeEach(() => {
  jest.clearAllMocks();
  importMock().mockResolvedValue({
    success: true,
    contacts: [
      { ...EMAIL_PERSON, id: SAVED_ID, is_message_derived: 0, source: "manual" },
    ],
  } as never);
});

describe("BACKLOG-1717 — picking a person found in email", () => {
  /**
   * P1 — the shipped placement. Clicking the row saves the person and the deal
   * receives the id of the contact that now exists.
   */
  it("P1: saves the person and selects the saved contact, not the record", async () => {
    const p = props({ externalContacts: [EMAIL_PERSON] });
    render(<ContactAssignmentStep {...p} />);

    expect(row(`email_${ADDRESS}`)).not.toBeNull(); // the row is on the page at all
    fireEvent.click(row(`email_${ADDRESS}`));

    await waitFor(() => expect(window.api.contacts.import).toHaveBeenCalledTimes(1));

    // The whole record is handed over, so the address reaches the saved contact.
    const [, records] = importMock().mock.calls[0] as unknown as [string, Contact[]];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ email: ADDRESS, source: "email_derived" });

    await waitFor(() => {
      const selections = (p.onSelectedContactIdsChange as jest.Mock).mock.calls.flat(2);
      expect(selections).toContain(SAVED_ID);
      expect(selections).not.toContain(`email_${ADDRESS}`);
    });
  });

  /**
   * P2 — THE CONTROL THAT MAKES P1 MEAN SOMETHING.
   *
   * The same record in the SAVED half. Nothing is imported and the synthetic
   * id is selected — a deal pointing at a contact that was never created.
   *
   * This documents the wrong placement AND proves the harness can tell the two
   * apart: without it, P1 would pass for a component that called `import` on
   * every click regardless of which half a row came from.
   */
  it("P2: the same record in the saved half creates nothing — the wrong placement", async () => {
    const p = props({ contacts: [EMAIL_PERSON] });
    render(<ContactAssignmentStep {...p} />);

    expect(row(`email_${ADDRESS}`)).not.toBeNull();
    fireEvent.click(row(`email_${ADDRESS}`));

    await waitFor(() => {
      const selections = (p.onSelectedContactIdsChange as jest.Mock).mock.calls.flat(2);
      expect(selections).toContain(`email_${ADDRESS}`);
    });
    expect(window.api.contacts.import).not.toHaveBeenCalled();
  });
});
