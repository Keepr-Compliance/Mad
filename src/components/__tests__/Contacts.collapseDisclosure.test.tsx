/**
 * Clients & Contacts — the founder's suppressed records reach the screen
 * (BACKLOG-2459).
 *
 * ## Why this test exists
 *
 * The first attempt at this feature instrumented the RENDERER's dedup pass and
 * unit-tested it by feeding raw duplicates straight into the pure function. That
 * test passed and proved nothing: on the real data path the duplicates have
 * already been removed by the time the renderer sees anything.
 *
 * `picker: 1126 in -> dup-suppressed 21 -> shown 1105` is decided in
 * `contacts:getAvailable`. The losing record hits a `continue` and never enters
 * `availableContacts`, so it is absent from the array `window.api.contacts.
 * getAvailable` resolves with. A renderer-side pass cannot name what it never
 * received.
 *
 * So this test feeds the component data shaped the way the HANDLER actually
 * returns it — survivors only, each carrying `absorbedRecords` describing what
 * was folded into it — and asserts the badge appears and names the right
 * records. It is the integration assertion whose absence let the shortfall read
 * as fine.
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

/**
 * A survivor row exactly as `contacts:getAvailable` builds it: the two records
 * that lost are NOT in this array — they were `continue`d away — and all that
 * remains of them is `absorbedRecords`.
 */
const survivorWithAbsorbed = {
  id: "ext-alice",
  user_id: USER_ID,
  name: "Alice Example",
  display_name: "Alice Example",
  email: "alice@example.test",
  phone: "+1 (415) 555-0177",
  source: "contacts_app",
  isFromDatabase: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  absorbedRecords: [
    {
      label: "Alice E",
      sourceLabel: "Outlook contacts",
      matchedOn: "email",
      matchedValue: "alice@example.test",
    },
    {
      label: "A. Example",
      sourceLabel: "iPhone",
      matchedOn: "phone",
      matchedValue: "+1 (415) 555-0177",
    },
  ],
} as unknown as Contact;

/** A row nothing was folded into — the overwhelming majority. */
const untouched = {
  id: "ext-fenn",
  user_id: USER_ID,
  name: "Fenn Example",
  display_name: "Fenn Example",
  email: "fenn@example.test",
  source: "contacts_app",
  isFromDatabase: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as unknown as Contact;

describe("Clients & Contacts — main-process suppressions are disclosed (BACKLOG-2459)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installMatchMedia(false);
    jest.mocked(window.api.contacts.getAll).mockResolvedValue({ success: true, contacts: [] });
    jest.mocked(window.api.contacts.getAvailable).mockResolvedValue({
      success: true,
      contacts: [survivorWithAbsorbed, untouched],
    });
    jest
      .mocked(window.api.contacts.checkCanDelete)
      .mockResolvedValue({ success: true, transactions: [] });
  });

  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it("shows the count on the surviving row, and only on that row", async () => {
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Alice Example")).toBeInTheDocument());
    expect(screen.getByText("Fenn Example")).toBeInTheDocument();

    // Exactly one row discloses a collapse — the one the handler folded into.
    const toggles = await screen.findAllByTestId("contact-row-collapsed-toggle");
    expect(toggles).toHaveLength(1);
    expect(toggles[0]).toHaveTextContent("2 records combined");

    // And it is on Alice's row, not Fenn's.
    const rows = screen.getAllByTestId("contact-row");
    const alice = rows.find((r) => r.getAttribute("data-contact-id") === "ext-alice");
    const fenn = rows.find((r) => r.getAttribute("data-contact-id") === "ext-fenn");
    expect(alice).toContainElement(toggles[0]);
    expect(fenn?.querySelector('[data-testid="contact-row-collapsed-toggle"]')).toBeNull();
  });

  it("names the exact set of folded records, with a true sentence for each", async () => {
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Alice Example")).toBeInTheDocument());
    await userEvent.click(await screen.findByTestId("contact-row-collapsed-toggle"));

    // The exact identity set the handler reported — not a count.
    expect(
      screen.getAllByTestId("contact-row-collapsed-record-name").map((el) => el.textContent),
    ).toEqual(["Alice E", "A. Example"]);

    const reasons = screen
      .getAllByTestId("contact-row-collapsed-record-reason")
      .map((el) => el.textContent);
    expect(reasons).toEqual([
      "Alice E from your Outlook contacts is shown on this row, because both list " +
        "the email address al…@example.test.",
      "A. Example from your iPhone is shown on this row, because both list " +
        "the phone number …0177.",
    ]);

    // The surviving row here is an UNIMPORTED address-book record, so nothing
    // may claim it is saved — this is the founder's own 1126 -> 1105 shape.
    for (const reason of reasons) {
      expect(reason?.toLowerCase()).not.toContain("already have");
      expect(reason?.toLowerCase()).not.toContain("saved from one of them");
    }
  });

  it("discloses nothing when the handler folded nothing", async () => {
    jest
      .mocked(window.api.contacts.getAvailable)
      .mockResolvedValue({ success: true, contacts: [untouched] });

    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Fenn Example")).toBeInTheDocument());
    expect(screen.queryByTestId("contact-row-collapsed-toggle")).not.toBeInTheDocument();
  });
});
