/**
 * Contacts — editing a contact does not navigate away from it (BACKLOG-2566).
 *
 * Founder-verified: on the Contacts screen, clicking "Edit Contact" opened the
 * form and DESTROYED the detail screen behind it (`setPreviewContact(null)`),
 * so Save and Cancel both dropped the user on the list. The person they were
 * working on — and the change they had just made — vanished from the screen.
 *
 * Same defect shape as BACKLOG-2459 (import), at the sibling call sites PR #2204
 * did not touch: `handlePreviewEdit`, and the incomplete-record branch of
 * `handlePreviewImport`.
 *
 * Founder decision, 2026-08-06: ONE rule for all three flows. Edit-from-pane,
 * complete-an-incomplete-record, and plain Add Contact all leave the pane
 * showing the contact that was just saved. (This deliberately reverses the plan
 * review's request for a `selectedContact !== undefined` discriminator that
 * would have left the plain-Add pane untouched — recorded on BACKLOG-2566, not
 * an engineering deviation.)
 */

import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
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
 * An IMPORTED (database) contact: `is_message_derived: 0` is what
 * `Contacts.tsx:357` reads to decide external-vs-imported, and it is what makes
 * the card offer "Edit Contact" rather than "Import"
 * (ContactPreview.tsx:676-683).
 *
 * `source: "manual"` is not decoration — it is what `contacts:create` writes for
 * a contact added through this form (contactHandlers.ts:2602-2607), and the
 * list's grouped Source filter (BACKLOG-2352, `filterMode="persistent"`) drops
 * any row without one. A fixture missing it is a row the producer never emits,
 * and it renders as an empty list.
 *
 * Fixtures use RFC 2606 domains and NANP fictional numbers only.
 */
const tomBefore = {
  id: "db-tom",
  user_id: USER_ID,
  name: "Tom Example",
  display_name: "Tom Example",
  email: "tom@example.test",
  phone: "+15550101",
  company: "Northgate Realty",
  source: "manual",
  is_message_derived: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as unknown as Contact;

/** The same row after the edit lands — same id, new name. */
const tomAfter = {
  ...tomBefore,
  name: "Tom Renamed",
  display_name: "Tom Renamed",
} as unknown as Contact;

/** A brand-new contact created through the plain Add Contact flow. */
const newPerson = {
  id: "db-nina",
  user_id: USER_ID,
  name: "Nina Example",
  display_name: "Nina Example",
  email: "nina@example.test",
  phone: "",
  source: "manual",
  is_message_derived: 0,
  created_at: "2026-01-02T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
} as unknown as Contact;

/** Wide renders the pane; narrow renders a full-screen card. Different testids. */
const WIDE_DETAIL = "contacts-detail-pane";
const NARROW_DETAIL = "contacts-detail-view";

/**
 * Open Tom's detail view, then his edit form — and assert the detail view is
 * still mounted UNDERNEATH the open form.
 *
 * That last assertion is the one that pins `handlePreviewEdit` itself. Without
 * it, the save cases would still pass with the bug restored, because the
 * `onSuccess` handler re-creates the pane after the fact; only Cancel would
 * notice. The modal is `z-[70]` and covers the pane — covering it was always
 * fine, unmounting it was not.
 */
async function openTomsEditForm(detailTestId: string) {
  await waitFor(() => expect(screen.getByText("Tom Example")).toBeInTheDocument());
  await userEvent.click(screen.getByText("Tom Example"));
  await userEvent.click(await screen.findByTestId("contact-preview-edit"));
  // The form's submit button — unique to the modal. Its two <h3> headers (mobile
  // and desktop) are BOTH in the DOM under jsdom, which applies no CSS, so a
  // heading query matches twice.
  await screen.findByRole("button", { name: /update contact/i });

  expect(screen.getByTestId(detailTestId)).toHaveTextContent("Tom Example");
  expect(screen.queryByTestId("contacts-detail-empty")).not.toBeInTheDocument();
}

describe("Contacts — edit keeps the user on the contact (BACKLOG-2566)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installMatchMedia(false);
    jest
      .mocked(window.api.contacts.getAll)
      .mockResolvedValue({ success: true, contacts: [tomBefore] });
    jest
      .mocked(window.api.contacts.getAvailable)
      .mockResolvedValue({ success: true, contacts: [] });
    jest
      .mocked(window.api.contacts.checkCanDelete)
      .mockResolvedValue({ success: true, transactions: [] });
    jest.mocked(window.api.contacts.update).mockResolvedValue({ success: true });
    // `contacts:create` returns the whole created row, not just its id
    // (contactHandlers.ts:2687-2690) — the modal happens to read only
    // `contact.id`, but the mock is the producer's shape, not the consumer's.
    jest
      .mocked(window.api.contacts.create)
      .mockResolvedValue({ success: true, contact: newPerson });
  });

  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it("wide: saving keeps the detail pane open, showing the value just saved", async () => {
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await openTomsEditForm(WIDE_DETAIL);

    await userEvent.clear(screen.getByPlaceholderText("John Doe"));
    await userEvent.type(screen.getByPlaceholderText("John Doe"), "Tom Renamed");

    // Once the update lands, the reload must return the NEW row — otherwise the
    // assertions below would be reading a stale list and could not tell a
    // refreshed pane from a frozen one.
    jest
      .mocked(window.api.contacts.getAll)
      .mockResolvedValue({ success: true, contacts: [tomAfter] });

    await userEvent.click(screen.getByRole("button", { name: /update contact/i }));

    await waitFor(() =>
      expect(window.api.contacts.update).toHaveBeenCalledWith("db-tom", expect.anything()),
    );

    // The pane is STILL mounted. The empty "Select a contact" state is the
    // failure this test exists to catch.
    await waitFor(() => {
      expect(screen.queryByTestId("contacts-detail-empty")).not.toBeInTheDocument();
    });
    const pane = screen.getByTestId("contacts-detail-pane");

    // And it is re-rendered to show the change that was just made.
    await waitFor(() => expect(pane).toHaveTextContent("Tom Renamed"));
  });

  it("wide: cancelling keeps the detail pane open on the unchanged contact", async () => {
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await openTomsEditForm(WIDE_DETAIL);

    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /update contact/i })).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId("contacts-detail-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("contacts-detail-pane")).toHaveTextContent("Tom Example");
    expect(window.api.contacts.update).not.toHaveBeenCalled();
  });

  it("narrow: saving keeps the full-screen detail card, showing the value just saved", async () => {
    // The narrow branch (Contacts.tsx:835) has a DIFFERENT condition from wide
    // (:942) — `showDetailPane` participates only on narrow — so a wide-only
    // test cannot see a narrow regression.
    installMatchMedia(true);
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await openTomsEditForm(NARROW_DETAIL);

    await userEvent.clear(screen.getByPlaceholderText("John Doe"));
    await userEvent.type(screen.getByPlaceholderText("John Doe"), "Tom Renamed");

    jest
      .mocked(window.api.contacts.getAll)
      .mockResolvedValue({ success: true, contacts: [tomAfter] });

    await userEvent.click(screen.getByRole("button", { name: /update contact/i }));

    await waitFor(() =>
      expect(screen.getByTestId("contacts-detail-view")).toHaveTextContent("Tom Renamed"),
    );
  });

  it("narrow: cancelling keeps the full-screen detail card", async () => {
    installMatchMedia(true);
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await openTomsEditForm(NARROW_DETAIL);

    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /update contact/i })).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("contacts-detail-view")).toHaveTextContent("Tom Example");
  });

  it("Add Contact with a pane open swaps the pane to the newly created contact", async () => {
    // FOUNDER DECISION, 2026-08-06. The shared `onSuccess` lands the pane on
    // whatever was just saved, in all three flows — so adding someone while
    // Tom's pane is open moves the pane to the new person, and the selection
    // and transactions follow the new id.
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Tom Example")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Tom Example"));
    await waitFor(() =>
      expect(screen.getByTestId("contacts-detail-pane")).toHaveTextContent("Tom Example"),
    );

    await userEvent.click(screen.getByTestId("add-manually-button"));
    await screen.findByRole("button", { name: /^add contact$/i });

    await userEvent.type(screen.getByPlaceholderText("John Doe"), "Nina Example");
    await userEvent.click(screen.getByRole("button", { name: /add email/i }));
    await userEvent.type(
      screen.getByPlaceholderText("email@example.com"),
      "nina@example.test",
    );

    jest
      .mocked(window.api.contacts.getAll)
      .mockResolvedValue({ success: true, contacts: [tomBefore, newPerson] });

    await userEvent.click(screen.getByRole("button", { name: /^add contact$/i }));

    await waitFor(() => expect(window.api.contacts.create).toHaveBeenCalled());

    // The pane SWAPPED — it shows Nina, not Tom.
    await waitFor(() =>
      expect(screen.getByTestId("contacts-detail-pane")).toHaveTextContent("Nina Example"),
    );
    expect(screen.queryByTestId("contacts-detail-empty")).not.toBeInTheDocument();

    // Transactions are re-loaded under the NEW id: `previewTransactions` is
    // manual state, so without this the pane would carry Tom's rows under
    // Nina's name. (`loadContactTransactions` reads through `checkCanDelete`.)
    await waitFor(() =>
      expect(window.api.contacts.checkCanDelete).toHaveBeenCalledWith("db-nina"),
    );
  });

  it("saving refreshes the list SILENTLY — no spinner, the rows never leave", async () => {
    // The second defect, independent of the pane: `onSuccess` called
    // `loadContacts()`, which raises `loading` and replaces every row with a
    // spinner (ContactSearchList.tsx:848), collapsing the list to nothing and
    // throwing away the user's place.
    //
    // A `scrollTop` assertion cannot see this — jsdom has no layout, so
    // scrollTop never clamps and the check passes either way. The spinner can:
    // hold the reload open and look at the list while it is in flight.
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await openTomsEditForm(WIDE_DETAIL);

    let releaseReload: (value: { success: boolean; contacts: Contact[] }) => void = () => {};
    const deferredReload = new Promise<{ success: boolean; contacts: Contact[] }>((resolve) => {
      releaseReload = resolve;
    });
    jest.mocked(window.api.contacts.getAll).mockReturnValue(deferredReload as never);

    await userEvent.click(screen.getByRole("button", { name: /update contact/i }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /update contact/i })).not.toBeInTheDocument(),
    );

    // Mid-reload: no spinner, and Tom's row is still on screen.
    expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("loading-state")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("contact-list")).getByText("Tom Example")).toBeInTheDocument();

    releaseReload({ success: true, contacts: [tomAfter] });
    await waitFor(() =>
      expect(screen.getByTestId("contacts-detail-pane")).toHaveTextContent("Tom Renamed"),
    );
  });
});
