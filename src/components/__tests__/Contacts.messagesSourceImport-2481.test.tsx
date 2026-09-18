/**
 * =============================================================================
 * BACKLOG-2481 — the Import press on a text-derived person, driven
 * =============================================================================
 * Two different things are pinned here and neither substitutes for the other.
 *
 * C2 — WHAT THE SCREEN SENDS. The renderer hands `source: "messages"` to
 * `contacts:import` and must go on doing so. The mapping belongs at the IPC
 * write boundary, where every caller passes through it; a renderer-side map
 * would look identical on this screen and leave every other caller — the sync
 * services, any future entry point — writing a value the CHECK refuses. This
 * control does NOT reproduce the defect (the renderer was already correct). It
 * forbids a particular wrong fix, and it is written down as such.
 *
 * C5 — WHERE THE PERSON ENDS UP. After the import the contact must be on
 * Clients & Contacts under the DEFAULT filter. Stored as `sms` — the value this
 * item was originally briefed to use — the row is absent by default, absent with
 * every leaf ticked, and not found by searching its own name. A `manual` control
 * row renders in every case below, which is what makes an absent subject a fact
 * about the filter rather than about the harness.
 *
 * -----------------------------------------------------------------------------
 * WHY THE PSEUDO-CONTACT ARRIVES THROUGH `contacts:get-all`
 * -----------------------------------------------------------------------------
 * Not through `contacts:get-available`. `getImportedContactsByUserId` merges
 * `messageDerivedAsContacts` into the SAVED half (`contactDbService.ts:833`, and
 * the worker path at `:882`), so a message-derived person is in the saved array
 * with `is_message_derived = 1`. `isUnimportedSourceRecord` is what puts the
 * Import control on the row. Supplying it through the external array instead
 * would be a fixture describing a state the producer cannot emit.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

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

const USER_ID = "550e8400-e29b-41d4-a716-446655440000"; // pii-allow-uuid: RFC 4122 example value, not from any live row

/** Invented names. Kept off any line that also carries a number, per the PII guard. */
const SUBJECT = "Rosalind Quill";
const CONTROL = "Casey Ledger";

/**
 * Transcribed from `getMessageDerivedContacts` (`contactDbService.ts:257-294`):
 * `display_name`/`name` are the participant string, `email` is NULL because the
 * WHERE clause excludes anything containing '@', `phone` is that same string,
 * `company` is NULL, `source` is the synthetic label and `is_message_derived` is 1.
 */
const pseudoContact = {
  id: "msg_rosalind quill",
  user_id: USER_ID,
  display_name: SUBJECT,
  name: SUBJECT,
  email: null,
  phone: SUBJECT,
  company: null,
  source: "messages",
  is_imported: 0,
  is_message_derived: 1,
  last_communication_at: "2026-02-04 13:00:00",
  communication_count: 3,
} as unknown as Contact;

/**
 * A SAVED contact as the read path emits one: `contactProjectionSql.ts:117`
 * hard-codes `0 as is_message_derived`, and `attachLiveSources` stamps
 * `source_types` from the crosswalk row the import writes.
 */
function savedContact(name: string, id: string, source: string): Contact {
  return {
    id,
    user_id: USER_ID,
    display_name: name,
    name,
    email: null,
    phone: null,
    company: null,
    title: null,
    source,
    source_types: [source],
    is_imported: 1,
    is_message_derived: 0,
    removed_at: null,
    last_communication_at: "2026-02-04 13:00:00",
  } as unknown as Contact;
}

const SUBJECT_ID = "5ab29099-5ebe-4fd5-b10b-6b6e0c5b5648"; // pii-allow-uuid: from a local test database, not from any live row
const CONTROL_ID = "0715ab79-6c0d-40b4-88c3-687eb4b77fe8"; // pii-allow-uuid: from a local test database, not from any live row

function install(saved: Contact[]) {
  jest.mocked(window.api.contacts.getAll).mockResolvedValue({
    success: true,
    contacts: saved,
  } as any);
  jest
    .mocked(window.api.contacts.getAvailable)
    .mockResolvedValue({ success: true, contacts: [] } as any);
  jest
    .mocked(window.api.contacts.checkCanDelete)
    .mockResolvedValue({ success: true, transactions: [] } as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  (window as any).matchMedia = jest.fn().mockReturnValue({
    matches: false,
    media: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => true,
  });
});

afterEach(() => {
  delete (window as any).matchMedia;
});

/* ==========================================================================
 * C2 — the screen sends the synthetic value; the boundary maps it, not the UI
 * ========================================================================== */
describe("the Import press on a message-derived row (BACKLOG-2481)", () => {
  it("hands contacts:import the record with source 'messages' untouched", async () => {
    install([pseudoContact]);
    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: true, contacts: [savedContact(SUBJECT, SUBJECT_ID, "manual")] } as any);

    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);

    /**
     * The default source selection does not include the Inferred leaves, so the
     * row is HIDDEN until "Show all" is pressed. Stated by driving it rather
     * than worked around, because it is also the instruction founder QA needs:
     * without this press the screen reports no text-derived people at all.
     */
    await userEvent.click(await screen.findByText("Show all"));
    await waitFor(() => expect(screen.getAllByText(SUBJECT).length).toBeGreaterThan(0));
    await userEvent.click(screen.getAllByText(SUBJECT)[0]);

    const button = await screen.findByTestId("contact-preview-import");
    expect(button).toBeEnabled();
    await userEvent.click(button);

    await waitFor(() => expect(window.api.contacts.import).toHaveBeenCalled());
    const [, records] = jest.mocked(window.api.contacts.import).mock.calls[0] as any;
    expect(records[0].source).toBe("messages");
    // And the renderer badge is dropped at the boundary, as it has been since
    // BACKLOG-2707 — so the handler decides on `source` alone.
    expect(records[0]).not.toHaveProperty("is_message_derived");
  });
});

/* ==========================================================================
 * C5 — after the import, the person is findable
 * ========================================================================== */
describe("a saved text-derived person on Clients & Contacts (BACKLOG-2481)", () => {
  async function renderWith(subjectSource: string): Promise<boolean> {
    install([
      savedContact(SUBJECT, SUBJECT_ID, subjectSource),
      savedContact(CONTROL, CONTROL_ID, "manual"),
    ]);
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    // The positive control. If this never appears the harness is broken and any
    // statement about the subject is worthless.
    await waitFor(() => expect(screen.getAllByText(CONTROL).length).toBeGreaterThan(0));
    return screen.queryAllByText(SUBJECT).length > 0;
  }

  it("is on the list under the DEFAULT filter when stored as 'manual'", async () => {
    expect(await renderWith("manual")).toBe(true);
  });

  /**
   * The discriminator. Same harness, same control row, one value changed — and
   * the person is gone. This is the whole reason the destination is not `sms`.
   */
  it("is NOT on the list when stored as 'sms', with the control still showing", async () => {
    expect(await renderWith("sms")).toBe(false);
    expect(screen.getAllByText(CONTROL).length).toBeGreaterThan(0);
  });

  it("stored as 'sms', is not reachable by Show all either", async () => {
    expect(await renderWith("sms")).toBe(false);
    const reveal = screen.queryByText(/Show \d+ more contact/i) ?? screen.queryByText("Show all");
    if (reveal) await userEvent.click(reveal.closest("button") ?? reveal);
    expect(screen.queryAllByText(SUBJECT).length).toBe(0);
  });
});
