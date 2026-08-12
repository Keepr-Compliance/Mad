/**
 * BACKLOG-2638 — THE WIZARD'S "+ Add" MUST CLAIM THE RECORD IT CREATED THE
 * CONTACT FROM. ASSERTED THROUGH BOTH TRANSACTION SURFACES.
 *
 * ===========================================================================
 * THE DEFECT, STATED PRECISELY — THE OBVIOUS STATEMENT OF IT IS WRONG
 * ===========================================================================
 * It is tempting to say "the wizard creates instead of importing". It does not.
 * Pressing "+ Add" created a contact and the person DID appear in Clients &
 * Contacts afterwards; from the user's side it imported.
 *
 * What it never did was CLAIM the address-book record the user picked. On the
 * founder's clean database, 2026-08-11:
 *
 *   - Priya Raman, imported from Clients & Contacts -> `origin` AND `source_id`
 *     crosswalk rows, written in the same second.
 *   - Dana Whitlock, added from this wizard        -> `origin` ONLY.
 *
 * `handleImportContact` called `contacts:create` with a payload rebuilt from
 * seven named fields. `toSourceIdentities` reads `externalRecordId`,
 * `externalSourceType` and `externalUuid` (`contactHandlers.ts:342-360`) — none
 * of them named, all three present on every row `contacts:get-available`
 * emits. A payload that does not carry the record's identity cannot produce a
 * link to it, whatever the handler at the other end does.
 *
 * The founder-visible consequence, and the sentence the item is titled after:
 * after a sweep, **the record was filed as a `pending` duplicate proposal
 * against the contact it had just created** — the app asked whether Dana
 * Whitlock is the same person as the card Dana Whitlock was made out of. That
 * half is asserted against the real handlers and real SQL in
 * `electron/__tests__/contact-handlers.wizardClaimsRecord-2638.test.ts`, which
 * is fed the payload THIS suite observes.
 *
 * ===========================================================================
 * WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY IS NOT
 * ===========================================================================
 * This is the RENDERER half: what the two containers hand across the IPC
 * boundary. It cannot see a crosswalk row, and does not pretend to. The
 * division is the one BACKLOG-2510 used: `Contacts.importForwardsRecord-2510`
 * pins the payload, the electron suites pin what the handler does with it.
 *
 * ===========================================================================
 * BOTH CONTAINERS ARE DRIVEN END-TO-END, AND ASSERTED SEPARATELY
 * ===========================================================================
 *   - `AuditTransactionModal`  — new transaction
 *   - `EditContactsModal`      — existing transaction, Add Contacts overlay
 *
 * They mount the SAME `ContactAssignmentStep`, so one fix reaches both. That is
 * a code-reading claim, and this epic has twice been caught by a surface that
 * "shares its list component" while disagreeing about its write path — which is
 * precisely how this defect shipped. So the containers are rendered and each is
 * asserted on its own. `EditContactsModal` is NOT allowed to mock
 * `ContactsContext` here: the provider supplies the address-book rows, so
 * mocking it away would leave a test that cannot go red when the wiring is cut.
 * (Same reasoning, same shape, as `ContactAssignmentStep.oneRefreshPath-2631`.)
 *
 * ===========================================================================
 * THE FIXTURE IS TRANSCRIBED, NOT INVENTED
 * ===========================================================================
 * `addressBookRecord` is the object `contacts:get-available` pushes at its
 * shadow-table loop (`contactHandlers.ts:1669-1697`) — every key, in that
 * order, `isFromDatabase: false` included — with `is_message_derived: true`
 * added because `useContactDirectory` stamps it on every address-book row on
 * the way to these two containers (`useContactDirectory.ts:255-259`). Both
 * containers read that hook, so a fixture without the badge would describe a
 * row NEITHER container ever receives, and the "the badge is stripped at the
 * boundary" assertion below would be vacuous.
 *
 * A fixture that omitted the identity fields would describe a row the handler
 * never emits, every assertion here would hold, and the app would stay broken.
 * That is exactly how this shipped.
 */

import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import AuditTransactionModal from "../AuditTransactionModal";
import { EditContactsModal } from "../transactionDetailsModule/components/modals/EditContactsModal";
import { PlatformProvider } from "../../contexts/PlatformContext";
import type { Contact, Transaction } from "../../../electron/types/models";

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

jest.mock("../../appCore", () => ({
  ...jest.requireActual("../../appCore"),
  useAppStateMachine: () => ({ isDatabaseInitialized: true }),
}));

const USER_ID = "user-2638";
const PROPERTY_ADDRESS = "1420 Alder Court";

/** The shadow row's own UUID — regenerated on every upsert, hence useless as identity. */
const RECORD_ROW_ID = "4d9b0c31-7e52-4a86-b1f4-2c60d8a7e935";
/** The id the contact gets once `contacts:import` has saved it. */
const SAVED_CONTACT_ID = "a1f2e3d4-5b6c-4d7e-8f90-1a2b3c4d5e6f";
/** A second record, present throughout, so no ID set below can be satisfied by an empty list. */
const BYSTANDER_ROW_ID = "c7e81a4f-2b93-4d05-9a6c-3f8e0b1d2c47";

/**
 * ONE address-book record, exactly as the two containers receive it.
 *
 * `contacts:get-available`'s shadow-table projection, plus the
 * `is_message_derived` badge `useContactDirectory` stamps on. See the docblock.
 */
const addressBookRecord = {
  id: RECORD_ROW_ID,
  name: "Dana Whitlock",
  phone: "+15035550118",
  email: "dana.whitlock@example.test",
  company: "Whitlock Escrow",
  source: "contacts_app",
  allPhones: ["+15035550118"],
  allEmails: ["dana.whitlock@example.test"],
  isFromDatabase: false,
  last_communication_at: "2026-08-10T16:45:00Z",
  externalRecordId: "AB-RECORD-7731",
  externalSourceType: "macos",
  externalUuid: "9b1d4c7a-08e6-4f23-a5b9-7c2e6d0f8a14",
  is_message_derived: true,
} as unknown as Contact;

/** A record nobody touches. Its presence is what separates "the record was claimed" from "the list emptied". */
const bystanderRecord = {
  ...(addressBookRecord as unknown as Record<string, unknown>),
  id: BYSTANDER_ROW_ID,
  name: "Marek Tull",
  email: "marek.tull@example.test",
  allEmails: ["marek.tull@example.test"],
  phone: "+15035550171",
  allPhones: ["+15035550171"],
  company: "Tull Surveying",
  externalRecordId: "AB-RECORD-9902",
  externalUuid: "1e6f2a90-4c73-4b8d-90a1-5f3c7e2b8d06",
} as unknown as Contact;

/**
 * What `contacts:import` hands back: a saved contact row.
 *
 * Thin on purpose — `getContactById` returns the `contacts` row, which has no
 * `allEmails`/`allPhones` and none of the external identity fields. A fixture
 * that echoed the record back would let a "the payload came through" assertion
 * pass on a handler that returned its own input.
 */
const savedDana = {
  id: SAVED_CONTACT_ID,
  user_id: USER_ID,
  name: "Dana Whitlock",
  display_name: "Dana Whitlock",
  email: "dana.whitlock@example.test",
  phone: "+15035550118",
  company: "Whitlock Escrow",
  source: "contacts_app",
  is_imported: 1,
  created_at: "2026-08-11T20:00:00Z",
  updated_at: "2026-08-11T20:00:00Z",
} as unknown as Contact;

/**
 * A saved contact with no connection to this item, on the deal's books but not
 * on the deal.
 *
 * Present for two unrelated reasons, both load-bearing:
 *
 *   1. It is the "the list did not empty" control on the saved half.
 *   2. `Screen2Overlay` derives the user id it passes to the import as
 *      `contacts.length > 0 ? contacts[0].user_id : ""`
 *      (`EditContactsModal.tsx:853`) — NOT from its own `userId` prop. With an
 *      empty saved list it sends `""`. See the dedicated test at the foot of
 *      this file; that is a pre-existing smell this item does not fix, and
 *      seeding one saved contact keeps every OTHER assertion here about the
 *      payload rather than about that.
 */
const unrelatedSavedContact = {
  id: "f0e1d2c3-b4a5-4968-8877-665544332211",
  user_id: USER_ID,
  name: "Office Front Desk",
  display_name: "Office Front Desk",
  email: "front.desk@example.test",
  phone: "+15035550100",
  source: "manual",
  is_imported: 1,
  created_at: "2026-07-01T09:00:00Z",
  updated_at: "2026-07-01T09:00:00Z",
} as unknown as Contact;

/**
 * The single payload `window.api.contacts.import` was handed.
 *
 * Asserts the arity too: two calls, or a call carrying two records, would mean
 * something quite different from what the assertions below claim.
 */
function soleImportPayload(): Record<string, unknown> {
  const calls = jest.mocked(window.api.contacts.import).mock.calls;
  expect(calls).toHaveLength(1);
  const [userId, records] = calls[0];
  expect(userId).toBe(USER_ID);
  expect(records).toHaveLength(1);
  return records[0] as unknown as Record<string, unknown>;
}

/**
 * Wire both halves to answer the way the main process does.
 *
 * Keyed on WHETHER THE IMPORT HAS HAPPENED, not on the call ordinal: the saved
 * half gains the contact and the address-book half loses the record because
 * `contacts:import` wrote a `contact_source_links` row and
 * `contacts:get-available` suppresses on exactly that table
 * (`contactHandlers.ts:1636-1641`). That is the producer's own rule. An ordinal
 * mock would encode "the second call is different", which is a different claim
 * and answers a second READER as though it were a second WRITE.
 *
 * The suppression itself is pinned against real SQL in
 * `electron/__tests__/contact-handlers.wizardClaimsRecord-2638.test.ts`; here it
 * is a faithful stand-in so the renderer can be driven past the import.
 */
function installBackend(): void {
  let imported = false;

  const savedHalf = () => (imported ? [unrelatedSavedContact, savedDana] : [unrelatedSavedContact]);

  jest
    .mocked(window.api.contacts.getAll)
    .mockImplementation(async () => ({ success: true, contacts: savedHalf() }));
  jest
    .mocked(window.api.contacts.getSortedByActivity)
    .mockImplementation(async () => ({ success: true, contacts: savedHalf() }));
  jest.mocked(window.api.contacts.getAvailable).mockImplementation(async () => ({
    success: true,
    contacts: imported ? [bystanderRecord] : [addressBookRecord, bystanderRecord],
  }));
  jest.mocked(window.api.contacts.import).mockImplementation(async () => {
    imported = true;
    return { success: true, contacts: [savedDana] };
  });
}

function rowFor(name: string): HTMLElement {
  const nameEl = screen.getByText(name, {
    selector: '[data-testid="contact-row-name"]',
  });
  return nameEl.closest('[data-testid="contact-row"]') as HTMLElement;
}

/** Press "+ Add" on an address-book row and wait for the import to be issued. */
async function pressAdd(name: string): Promise<void> {
  await userEvent.click(within(rowFor(name)).getByTestId("contact-row-add-button"));
  await waitFor(() => expect(window.api.contacts.import).toHaveBeenCalled());
}

const existingTransaction = {
  id: "txn-2638",
  user_id: USER_ID,
  property_address: PROPERTY_ADDRESS,
  transaction_type: "purchase",
  status: "active",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
} as unknown as Transaction;

// ===========================================================================
// ENTRY POINT A — NEW TRANSACTION (AuditTransactionModal)
// ===========================================================================

/** Walk the wizard to step 2, which is where the picker lives. */
async function openTheNewTransactionPicker(): Promise<void> {
  render(
    <PlatformProvider>
      <AuditTransactionModal
        userId={USER_ID}
        provider="google"
        onClose={jest.fn()}
        onSuccess={jest.fn()}
      />
    </PlatformProvider>,
  );

  await userEvent.type(
    screen.getByPlaceholderText(/enter property address/i),
    PROPERTY_ADDRESS,
  );
  await userEvent.click(screen.getAllByRole("button", { name: /continue/i })[0]);
  await screen.findByTestId("contact-assignment-step-2");
  await waitFor(() => expect(screen.getByText("Dana Whitlock")).toBeInTheDocument());
}

// ===========================================================================
// ENTRY POINT B — EXISTING TRANSACTION (EditContactsModal -> Screen2Overlay)
// ===========================================================================

/** Open the modal, then the Add Contacts overlay — the picker's second home. */
async function openTheExistingTransactionPicker(): Promise<void> {
  render(
    <EditContactsModal
      transaction={existingTransaction}
      userId={USER_ID}
      onClose={jest.fn()}
      onSave={jest.fn()}
    />,
  );

  // No parties on the deal yet, so Screen 1 shows its empty state and its own
  // button. Deliberately empty: it leaves `selectedContactIds` unseeded, so the
  // Added column below says only what this item is about.
  await userEvent.click(await screen.findByTestId("empty-state-add-button"));
  await screen.findByTestId("contact-assignment-step-2");
  await waitFor(() => expect(screen.getByText("Dana Whitlock")).toBeInTheDocument());
}

beforeEach(() => {
  jest.clearAllMocks();
  installBackend();

  jest.mocked(window.api.address.initialize).mockResolvedValue({ success: true });
  jest
    .mocked(window.api.address.getSuggestions)
    .mockResolvedValue({ success: true, suggestions: [] });
  jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
    success: true,
    transaction: { ...existingTransaction, contact_assignments: [] },
  } as never);
});

describe("BACKLOG-2638 — the wizard hands the record over whole, from both surfaces", () => {
  /**
   * CONTROL 6A — NEW-TRANSACTION WIZARD.
   *
   * OBSERVED RED: `git checkout -- src/components/audit/ContactAssignmentStep.tsx`
   * (restoring the `contactService.create` rebuild) and this test fails at
   * `expect(window.api.contacts.import).toHaveBeenCalled()` inside `pressAdd` —
   * the import is never issued at all.
   */
  it("A: sends the address-book record itself, not a rebuilt subset", async () => {
    await openTheNewTransactionPicker();
    await pressAdd("Dana Whitlock");

    /**
     * THE RECORD, MINUS THE RENDERER BADGE, PLUS `display_name`.
     *
     * A deep-equal rather than a field list, because the defect was a payload
     * that carried today's fields and dropped the ones nobody named. Only an
     * equality can catch a reconstruction that drifts in a field this test's
     * author did not think of.
     *
     * The two documented differences from the raw record, and why each is
     * correct rather than tolerated:
     *
     *   - `is_message_derived` GONE. A renderer badge for the "External" pill,
     *     stamped by `useContactDirectory`, meaningless on the far side of the
     *     IPC boundary. Clients & Contacts strips it in the same destructure
     *     (`Contacts.tsx:721`), so the two screens hand the handler one shape.
     *   - `display_name` ADDED. `toExtendedContact` sets it from `name` so the
     *     list can sort and search on one field; a `get-available` row has no
     *     `display_name`. It is additive and `validateContactData` reads
     *     `name`, so it changes nothing about what is saved.
     */
    expect(soleImportPayload()).toEqual({
      id: RECORD_ROW_ID,
      name: "Dana Whitlock",
      display_name: "Dana Whitlock",
      phone: "+15035550118",
      email: "dana.whitlock@example.test",
      company: "Whitlock Escrow",
      source: "contacts_app",
      allPhones: ["+15035550118"],
      allEmails: ["dana.whitlock@example.test"],
      isFromDatabase: false,
      last_communication_at: "2026-08-10T16:45:00Z",
      externalRecordId: "AB-RECORD-7731",
      externalSourceType: "macos",
      externalUuid: "9b1d4c7a-08e6-4f23-a5b9-7c2e6d0f8a14",
    });
  });

  /**
   * CONTROL 6B — EXISTING-TRANSACTION OVERLAY.
   *
   * Asserted separately from 6A. The two are separate call sites reached
   * through separate containers, and a fix to one is the same bug with a
   * smaller radius.
   *
   * OBSERVED RED: same revert, same failure — `pressAdd` times out waiting for
   * an import that the `create` path never issues.
   */
  it("B: sends the address-book record itself, from the existing-transaction overlay", async () => {
    await openTheExistingTransactionPicker();
    await pressAdd("Dana Whitlock");

    expect(soleImportPayload()).toEqual({
      id: RECORD_ROW_ID,
      name: "Dana Whitlock",
      display_name: "Dana Whitlock",
      phone: "+15035550118",
      email: "dana.whitlock@example.test",
      company: "Whitlock Escrow",
      source: "contacts_app",
      allPhones: ["+15035550118"],
      allEmails: ["dana.whitlock@example.test"],
      isFromDatabase: false,
      last_communication_at: "2026-08-10T16:45:00Z",
      externalRecordId: "AB-RECORD-7731",
      externalSourceType: "macos",
      externalUuid: "9b1d4c7a-08e6-4f23-a5b9-7c2e6d0f8a14",
    });
  });

  /**
   * THE THREE FIELDS THE CROSSWALK IS WRITTEN FROM.
   *
   * Redundant against the deep-equals above and kept anyway: when this suite
   * goes red, this is the assertion that names the defect rather than printing
   * a fourteen-key diff.
   */
  it.each([
    ["A: new transaction", openTheNewTransactionPicker],
    ["B: existing transaction", openTheExistingTransactionPicker],
  ])("%s — carries every field toSourceIdentities reads", async (_label, open) => {
    await open();
    await pressAdd("Dana Whitlock");

    const payload = soleImportPayload();
    expect(payload.externalRecordId).toBe("AB-RECORD-7731");
    expect(payload.externalSourceType).toBe("macos");
    expect(payload.externalUuid).toBe("9b1d4c7a-08e6-4f23-a5b9-7c2e6d0f8a14");
  });

  /**
   * `contacts:create` writes no crosswalk row for a source record — its only
   * crosswalk write is `recordContactOrigin`'s synthetic `origin:<contactId>`,
   * which matches no real address-book id. Reaching it at all is the bug,
   * whatever it returns.
   */
  it.each([
    ["A: new transaction", openTheNewTransactionPicker],
    ["B: existing transaction", openTheExistingTransactionPicker],
  ])("%s — does not route the add through contacts:create", async (_label, open) => {
    await open();
    await pressAdd("Dana Whitlock");

    expect(window.api.contacts.create).not.toHaveBeenCalled();
  });

  /**
   * CONTROL 4 — THE CONTACT IS STILL ADDED TO THE DEAL.
   *
   * The point of the "+ Add" button is unchanged, and the chip must carry the
   * SAVED contact's id, not the address-book row's — `selectedContactIds` is
   * what the transaction is built from, and the shadow row's UUID is not a
   * contact id.
   *
   * This is the control the `includes` guard added alongside the fix could
   * break: a second press now returns the incumbent (BACKLOG-2525), so the
   * append is guarded, and a guard written wrongly would drop the FIRST add.
   */
  it.each([
    ["A: new transaction", openTheNewTransactionPicker],
    ["B: existing transaction", openTheExistingTransactionPicker],
  ])("%s — adds the saved contact to the deal, by its new id", async (_label, open) => {
    await open();
    await pressAdd("Dana Whitlock");

    const chip = await screen.findByTestId(`added-chip-${SAVED_CONTACT_ID}`);
    expect(chip).toHaveTextContent("Dana Whitlock");
    // The shadow row's UUID is not a contact id and must never reach selection.
    expect(screen.queryByTestId(`added-chip-${RECORD_ROW_ID}`)).not.toBeInTheDocument();
  });

  /**
   * The wizard carries the added contact into step 3, where the role is set and
   * the transaction is actually assembled. Asserting the chip alone would leave
   * "added" meaning only "a chip appeared".
   */
  it("A: carries the added contact into role assignment", async () => {
    await openTheNewTransactionPicker();
    await pressAdd("Dana Whitlock");
    await screen.findByTestId(`added-chip-${SAVED_CONTACT_ID}`);

    // Step 3 renders from `contacts` — the saved half, which the refresh that
    // followed the import has already re-read (see `installBackend`).
    await userEvent.click(screen.getAllByRole("button", { name: /continue/i })[0]);

    await screen.findByTestId("contact-assignment-step-3");
    expect(
      await screen.findByTestId(`contact-role-row-${SAVED_CONTACT_ID}`),
    ).toBeInTheDocument();
  });

  /**
   * And the overlay carries it onto the deal: "Add Selected" closes Screen 2
   * and the contact is on Screen 1's assigned list. This is the existing
   * transaction's equivalent of the step-3 assertion above.
   */
  it("B: carries the added contact onto the deal via Add Selected", async () => {
    await openTheExistingTransactionPicker();
    await pressAdd("Dana Whitlock");
    await screen.findByTestId(`added-chip-${SAVED_CONTACT_ID}`);

    await userEvent.click(screen.getByTestId("add-selected-button"));

    // By ID, not by name: `ContactRoleRow` renders the name in more than one
    // place, and this item is precisely about a screen that could not tell one
    // "Dana Whitlock" from another.
    const assigned = await screen.findByTestId("assigned-contacts-list");
    expect(
      within(assigned).getByTestId(`contact-role-row-${SAVED_CONTACT_ID}`),
    ).toBeInTheDocument();
    expect(
      within(assigned).queryByTestId(`contact-role-row-${RECORD_ROW_ID}`),
    ).not.toBeInTheDocument();
  });

  /**
   * ===========================================================================
   * FOUND BY THIS SUITE, NOT FIXED BY IT — Screen2Overlay's user id.
   * ===========================================================================
   * `Screen2Overlay` takes the user id it hands to the import from the saved
   * contact list rather than from the `userId` prop `EditContactsModal` already
   * receives:
   *
   *     const userId = contacts.length > 0 ? contacts[0].user_id : "";
   *
   * On a deal opened against an empty address book — a first-run install, or
   * any account whose saved contacts have not loaded yet — that is `""`, and
   * `contacts:import` is called with an empty user id.
   *
   * NOT A LIVE DEFECT TODAY, and that is why it is pinned rather than fixed
   * here: `getValidUserId` treats a falsy id as absent and falls back to
   * `SELECT id FROM users_local LIMIT 1` (`userIdHelper.ts:38-63`), which on a
   * single-user desktop install is the right user. It is correct by accident,
   * and it inverts the day this app has two accounts on one machine.
   *
   * It is PRE-EXISTING: the `contacts:create` call this item replaced read the
   * same `userId`. Fixing it means editing `EditContactsModal` to pass its own
   * prop down, which is a different item's diff. Filed on BACKLOG-2638's
   * comments; asserted here so the next reader meets it as a fact rather than
   * rediscovering it through a confusing test failure.
   */
  it("B: sends an EMPTY user id when the deal has no saved contacts (pre-existing, filed)", async () => {
    // Override the saved half to genuinely empty — the state the smell needs.
    jest
      .mocked(window.api.contacts.getAll)
      .mockResolvedValue({ success: true, contacts: [] });
    jest
      .mocked(window.api.contacts.getSortedByActivity)
      .mockResolvedValue({ success: true, contacts: [] });

    await openTheExistingTransactionPicker();
    await pressAdd("Dana Whitlock");

    const [userId, records] = jest.mocked(window.api.contacts.import).mock.calls[0];
    expect(userId).toBe("");
    // The RECORD is still handed over whole — this item's fix is unaffected by
    // the smell, which is the other half of why it is not being fixed here.
    expect((records[0] as unknown as Record<string, unknown>).externalRecordId).toBe(
      "AB-RECORD-7731",
    );
  });
});
