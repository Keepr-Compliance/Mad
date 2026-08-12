/**
 * The Clients & Contacts Import button forwards the WHOLE record (BACKLOG-2510).
 *
 * Founder, on finding that importing from Clients & Contacts recorded nothing
 * about where the contact came from while importing the same person from a
 * transaction did: *"shouldn't they be the same?"*
 *
 * ===========================================================================
 * THIS WAS A PARITY TEST. IT IS NOW A SINGLE-PATH TEST. READ WHY.
 * ===========================================================================
 * It used to import the same record from BOTH screens and assert the two
 * payloads were deep-equal:
 *
 *   - Clients & Contacts   -> `Contacts.tsx` `handleImportContact`   (LIVE)
 *   - the transaction flow -> `ImportContactsModal`                  (DELETED)
 *
 * `ImportContactsModal` was rendered only by `ContactSelectModal`, which no
 * user could reach, and BACKLOG-2515 deleted both. **A parity test with one
 * side gone is not a weaker parity test — it is a test of nothing**, so it has
 * been re-pointed rather than left half-asserting.
 *
 * WHAT SURVIVES IS THE PART THAT MATTERED. The defect was never "the two
 * disagree" in the abstract; it was that the Clients & Contacts path REBUILT a
 * payload field by field and the fields it did not name — `externalRecordId`,
 * `externalSourceType`, `externalUuid` — were the identity
 * of the actual address-book card. Dropping them meant no `contact_source_links`
 * row, so the record was never suppressed from the picker and nothing could ever
 * attach to that contact later. That path is the live one, and it is the one
 * pinned below.
 *
 * The deep-equal against `externalAddressBookRecord` is what replaces the
 * cross-screen comparison: the live path must forward THE WHOLE RECORD, not a
 * hand-built subset that happens to carry today's four fields. A future
 * reconstruction that drifts in some other field still fails.
 *
 * ===========================================================================
 * THE FIXTURE IS TRANSCRIBED, NOT INVENTED
 * ===========================================================================
 * `externalAddressBookRecord` below is the projection `contacts:get-available`
 * pushes at the shadow-table loop in `contacts:get-available` — every key, in
 * that order, including `isFromDatabase: false`.
 *
 * BACKLOG-2556: the fixture also carried a single-entry `collapsedSources`,
 * "the identity a row carries before it absorbs anything". The handler no
 * longer emits that field — the fold that filled it is deleted — so keeping it
 * would make this fixture describe a shape the producer CANNOT emit, which is
 * the failure mode the paragraph above exists to prevent. Removed here and in
 * the five sibling suites that copied it.
 *
 * This matters more than usual here. A fixture that omitted the identity fields
 * would describe a row the handler never emits, and every assertion below would
 * hold while the real app stayed broken — which is exactly how this shipped.
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

describe("BACKLOG-2510 — the live Import button forwards the whole record", () => {
  it("sends the address-book record itself, not a rebuilt subset", async () => {
    const fromClientsAndContacts = await importFromClientsAndContacts();

    // What the deleted cross-screen comparison was really protecting: the live
    // path must forward THE RECORD. Two hand-built payloads that happened to
    // match each other would have satisfied the old equality; only this can
    // catch a reconstruction that drifts in a field nobody thought to name.
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
    // BACKLOG-2556: `collapsedSources` was asserted here too. It is deleted,
    // and asserting it as absent on a payload the test itself builds would
    // prove nothing — the deep-equal above already fails if the live path
    // invents a field the handler does not emit.
  });

  it("does not route the import through contacts:create", async () => {
    await importFromClientsAndContacts();

    // `contacts:create` writes no crosswalk row for a source record — its only
    // crosswalk write is the synthetic `origin:<contactId>`, which matches no
    // real address-book id. Reaching it at all is the bug, whatever it returns.
    expect(window.api.contacts.create).not.toHaveBeenCalled();
  });
});
