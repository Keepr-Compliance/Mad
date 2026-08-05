/**
 * The two Import buttons send the SAME payload (BACKLOG-2510).
 *
 * Founder, on finding that importing from Clients & Contacts recorded nothing
 * about where the contact came from while importing the same person from a
 * transaction did: *"shouldn't they be the same?"*
 *
 * ===========================================================================
 * WHAT THIS FILE IS FOR
 * ===========================================================================
 * Both screens offer an Import button over the same address-book records:
 *
 *   - Clients & Contacts   -> `Contacts.tsx` `handleImportContact`
 *   - the transaction flow -> `ImportContactsModal` `handleImportSelected`
 *
 * They disagreed because only one of them FORWARDED the row. The other rebuilt
 * a payload field by field, and the fields it did not name — `externalRecordId`,
 * `externalSourceType`, `externalUuid`, `collapsedSources` — were the identity
 * of the actual address-book card. Dropping them meant no `contact_source_links`
 * row, so the record was never suppressed from the picker and nothing could ever
 * attach to that contact later.
 *
 * The equivalence itself is the requirement. Asserting only that the fields are
 * present would pass while the two paths drifted apart in some other field, and
 * drift is what produced this defect. So: same record in, deep-equal payload out
 * of both, or this test fails.
 *
 * ===========================================================================
 * THE FIXTURE IS TRANSCRIBED, NOT INVENTED
 * ===========================================================================
 * `externalAddressBookRecord` below is the projection `contacts:get-available`
 * pushes at `electron/handlers/contactHandlers.ts:1720-1758` — every key, in
 * that order, including `isFromDatabase: false` and the single-entry
 * `collapsedSources` a row carries before it absorbs anything.
 *
 * This matters more than usual here. A fixture that omitted the identity fields
 * would describe a row the handler never emits, and every assertion below would
 * hold while the real app stayed broken — which is exactly how this shipped.
 */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Contacts from "../Contacts";
import ImportContactsModal from "../contact/components/ImportContactsModal";
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

const USER_ID = "user-2510";

/**
 * ONE address-book record, exactly as `contacts:get-available` emits it.
 *
 * Transcribed from `contactHandlers.ts:1720-1758`. `id` is the shadow row's own
 * UUID — regenerated on every upsert, which is precisely why it is useless as
 * identity and why `externalRecordId` exists.
 */
const externalAddressBookRecord = {
  id: "8f14e45f-ceea-4e78-9e2d-3b1a7c0d5e62",
  name: "Tam Wexford",
  phone: "+15550187",
  email: "tam.wexford@example.test",
  company: "Wexford Realty",
  source: "contacts_app",
  allPhones: ["+15550187"],
  allEmails: ["tam.wexford@example.test"],
  isFromDatabase: false,
  last_communication_at: "2026-07-30T11:04:00Z",
  externalRecordId: "AB-RECORD-4417",
  externalSourceType: "macos",
  externalUuid: "3c9a1b7e-52d4-4f60-b8a1-9d7e2f0c4a55",
  collapsedSources: [
    {
      sourceType: "macos",
      sourceRecordId: "AB-RECORD-4417",
      externalUuid: "3c9a1b7e-52d4-4f60-b8a1-9d7e2f0c4a55",
    },
  ],
} as unknown as Contact;

/** What the handler returns once the record has become a saved contact. */
const savedTam = {
  id: "b2c4d6e8-1a3f-4c5b-8d7e-6f9a0b1c2d3e",
  user_id: USER_ID,
  name: "Tam Wexford",
  display_name: "Tam Wexford",
  email: "tam.wexford@example.test",
  phone: "+15550187",
  source: "contacts_app",
  created_at: "2026-07-30T11:04:00Z",
  updated_at: "2026-07-30T11:04:00Z",
} as unknown as Contact;

/** The payload `window.api.contacts.import` was handed, for a single record. */
function soleImportPayload(): unknown {
  const calls = jest.mocked(window.api.contacts.import).mock.calls;
  expect(calls).toHaveLength(1);
  const [userId, contacts] = calls[0];
  expect(userId).toBe(USER_ID);
  expect(contacts).toHaveLength(1);
  return contacts[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  installMatchMedia(false);
  jest.mocked(window.api.contacts.getAll).mockResolvedValue({ success: true, contacts: [] });
  jest
    .mocked(window.api.contacts.getAvailable)
    .mockResolvedValue({ success: true, contacts: [externalAddressBookRecord] });
  jest
    .mocked(window.api.contacts.import)
    .mockResolvedValue({ success: true, contacts: [savedTam] });
  jest
    .mocked(window.api.contacts.checkCanDelete)
    .mockResolvedValue({ success: true, transactions: [] });
});

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

/** Import the record from Clients & Contacts, via the detail card. */
async function importFromClientsAndContacts(): Promise<unknown> {
  render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText("Tam Wexford")).toBeInTheDocument());
  await userEvent.click(screen.getByText("Tam Wexford"));
  await userEvent.click(await screen.findByRole("button", { name: /^import$/i }));
  await waitFor(() => expect(window.api.contacts.import).toHaveBeenCalled());
  return soleImportPayload();
}

/** Import the same record from the transaction flow's modal. */
async function importFromTransactionModal(): Promise<unknown> {
  render(
    <ImportContactsModal
      userId={USER_ID}
      onClose={jest.fn()}
      onSuccess={jest.fn()}
      onAddManually={jest.fn()}
    />,
  );
  await waitFor(() => expect(screen.getByText("Tam Wexford")).toBeInTheDocument());
  await userEvent.click(screen.getByText("Tam Wexford"));
  await userEvent.click(screen.getByRole("button", { name: /import selected \(1\)/i }));
  await waitFor(() => expect(window.api.contacts.import).toHaveBeenCalled());
  return soleImportPayload();
}

describe("BACKLOG-2510 — the two Import buttons agree", () => {
  it("sends a byte-for-byte identical payload from both screens", async () => {
    const fromClientsAndContacts = await importFromClientsAndContacts();

    // Unmount the first screen before rendering the second. Both render the
    // same person, and RTL only auto-cleans between TESTS — leaving the first
    // mounted makes "Tam Wexford" ambiguous and the query throws.
    cleanup();
    jest.mocked(window.api.contacts.import).mockClear();

    const fromTransactionModal = await importFromTransactionModal();

    // THE assertion. Not "both carry externalRecordId" — that would stay green
    // while the two drifted in some other field, and drift is the defect.
    expect(fromClientsAndContacts).toEqual(fromTransactionModal);

    // And what they agree ON is the whole record, identity included. Pinned
    // explicitly so a future change that makes both paths equally WRONG — two
    // hand-built payloads that happen to match — cannot pass the line above.
    expect(fromClientsAndContacts).toEqual(externalAddressBookRecord);
  });

  it("carries every field the crosswalk needs, from Clients & Contacts", async () => {
    const payload = (await importFromClientsAndContacts()) as Record<string, unknown>;

    // `toSourceIdentities` reads exactly these (contactHandlers.ts:330-333).
    // Without them `linkImportedContact` writes nothing and the import records
    // no source at all — the founder's defect.
    expect(payload.externalRecordId).toBe("AB-RECORD-4417");
    expect(payload.externalSourceType).toBe("macos");
    expect(payload.externalUuid).toBe("3c9a1b7e-52d4-4f60-b8a1-9d7e2f0c4a55");
    expect(payload.collapsedSources).toEqual([
      {
        sourceType: "macos",
        sourceRecordId: "AB-RECORD-4417",
        externalUuid: "3c9a1b7e-52d4-4f60-b8a1-9d7e2f0c4a55",
      },
    ]);
  });

  it("does not route the import through contacts:create", async () => {
    await importFromClientsAndContacts();

    // `contacts:create` writes no crosswalk row for a source record — its only
    // crosswalk write is the synthetic `origin:<contactId>`, which matches no
    // real address-book id. Reaching it at all is the bug, whatever it returns.
    expect(window.api.contacts.create).not.toHaveBeenCalled();
  });
});
