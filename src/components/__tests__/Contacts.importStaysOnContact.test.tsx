/**
 * Contacts — importing a contact does not navigate away from it (BACKLOG-2459).
 *
 * Founder: *"i clicked import and the screen re-rendered to the list of
 * contacts, it exited the contact detail screen showing [the contact]"*.
 *
 * The user is looking at a person, acts on them, and is thrown back to the list —
 * so the thing they just created is exactly what they cannot see. It is also why
 * the founder could not tell whether the import had linked both sources: the
 * screen that would have shown it was the screen that closed.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Contacts from "../Contacts";
import type { Contact } from "../../../electron/types/models";

jest.mock("../../appCore", () => ({
  ...jest.requireActual("../../appCore"),
  useAppStateMachine: () => ({ isDatabaseInitialized: true }),
}));

jest.mock("../../contexts/NetworkContext", () => ({
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

function installMatchMedia(narrow: boolean) {
  (window as unknown as { matchMedia: unknown }).matchMedia = jest.fn().mockReturnValue({
    matches: narrow,
    media: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => true,
  });
}

const USER_ID = "user-123";

/** An address-book record: not in the database, so the card offers Import. */
const externalAlice = {
  id: "ext-alice",
  user_id: USER_ID,
  name: "Alice Example",
  display_name: "Alice Example",
  email: "alice@example.test",
  phone: "555-0142",
  source: "contacts_app",
  is_message_derived: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as unknown as Contact;

/** What `contacts.create` returns: the same person, now with a database id. */
const savedAlice = {
  ...externalAlice,
  id: "db-alice",
  is_message_derived: 0,
} as unknown as Contact;

describe("Contacts — import keeps the user on the contact (BACKLOG-2459)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installMatchMedia(false);
    jest.mocked(window.api.contacts.getAll).mockResolvedValue({ success: true, contacts: [] });
    jest
      .mocked(window.api.contacts.getAvailable)
      .mockResolvedValue({ success: true, contacts: [externalAlice] });
    jest.mocked(window.api.contacts.create).mockResolvedValue({
      success: true,
      contact: savedAlice,
    });
    jest
      .mocked(window.api.contacts.checkCanDelete)
      .mockResolvedValue({ success: true, transactions: [] });
  });

  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it("stays on the detail card, now showing the imported contact", async () => {
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Alice Example")).toBeInTheDocument());

    // Open the address-book record.
    await userEvent.click(screen.getByText("Alice Example"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /import/i })).toBeInTheDocument(),
    );

    // Once the imported contact is in the database, the list reload must return
    // it — otherwise the assertions below would be testing a stale list.
    jest
      .mocked(window.api.contacts.getAll)
      .mockResolvedValue({ success: true, contacts: [savedAlice] });

    await userEvent.click(screen.getByRole("button", { name: /import/i }));

    // The detail pane is STILL open — the empty "Select a contact" state is the
    // failure this test exists to catch.
    await waitFor(() => {
      expect(screen.queryByTestId("contacts-detail-empty")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("contacts-detail-pane")).toBeInTheDocument();

    // And it is showing the person who was just imported.
    const pane = screen.getByTestId("contacts-detail-pane");
    expect(pane).toHaveTextContent("Alice Example");

    // The card now shows the IMPORTED contact, not the address-book record: the
    // Import button is gone, because there is nothing left to import.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^import$/i })).not.toBeInTheDocument();
    });

    // The transactions the newly-saved contact is on are loaded under its DB id
    // — the card is bound to the created contact, not the address-book record.
    await waitFor(() => {
      expect(window.api.contacts.checkCanDelete).toHaveBeenCalledWith("db-alice");
    });
  });

  it("still opens the edit form when the record is missing an email and a phone", async () => {
    // The one deliberate navigation: an incomplete record cannot be imported, so
    // the form opens to complete it. Unchanged by BACKLOG-2459 and pinned so the
    // "stay put" fix cannot quietly swallow it.
    const incomplete = {
      ...externalAlice,
      id: "ext-incomplete",
      name: "Gus Example",
      display_name: "Gus Example",
      email: "",
      phone: "",
    } as unknown as Contact;

    jest
      .mocked(window.api.contacts.getAvailable)
      .mockResolvedValue({ success: true, contacts: [incomplete] });

    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Gus Example")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Gus Example"));
    await userEvent.click(await screen.findByRole("button", { name: /import/i }));

    // The add/edit form took over, and nothing was created.
    await waitFor(() => {
      expect(screen.getByTestId("contacts-detail-empty")).toBeInTheDocument();
    });
    expect(window.api.contacts.create).not.toHaveBeenCalled();
  });
});
