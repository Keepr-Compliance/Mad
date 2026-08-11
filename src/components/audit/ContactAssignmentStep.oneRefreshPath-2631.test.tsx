/**
 * BACKLOG-2631 — ONE REFRESH PATH, ASSERTED THROUGH BOTH TRANSACTION SURFACES.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * Madison is adding parties to a deal. In the Add Contacts picker she sees a
 * `Suggestion` badge on "Bianca Okafor", opens it, and answers "yes, same
 * person" about the address-book record "Petra Lindqvist". The badge clears.
 * PETRA IS STILL SITTING IN THE LIST UNDERNEATH, AS HER OWN SELECTABLE ROW —
 * and she stays there for the life of the modal. Madison can add, as a second
 * party on the same deal, the person she has just said is the first one.
 *
 * Close the modal and reopen it and Petra is gone, because the picker reloads
 * on mount.
 *
 * ===========================================================================
 * WHY IT SURVIVED A FIX THAT WAS WRITTEN FOR EXACTLY THIS
 * ===========================================================================
 * The LIST is shared — `ContactSearchList` / `ContactRow` render all three
 * surfaces. The DATA-AND-REFRESH LAYER was three separate copies, and
 * BACKLOG-2627/2629 fixed the one that Clients & Contacts uses. The two
 * transaction copies each reloaded the SAVED half only, with the address-book
 * half behind a once-per-mount guard (`useAuditContactAssignment:111`,
 * `EditContactsModal:839`), so the fix could not reach them.
 *
 * Answering "same person" writes a `contact_source_links` row
 * (`confirmProposal` -> `createLink`), and `contacts:get-available` suppresses
 * on exactly that table — pinned against the real handler, the real schema and
 * the real writers in
 * `electron/__tests__/contact-handlers.stopHidingRecords-2608.test.ts`
 * (CONTROL 2: the confirmed record leaves the list; CONTROL 3: a REJECTED
 * record stays). So the record should vanish on the next read; there was no
 * next read.
 *
 * The fixtures below are that behaviour copied — a state the main process really
 * produces — not one invented to make an assertion pass.
 *
 * ===========================================================================
 * WHY BOTH ENTRY POINTS ARE DRIVEN END-TO-END, AND NEITHER IS MOCKED OUT
 * ===========================================================================
 * The two surfaces were SEPARATE COPIES. A test that renders
 * `ContactAssignmentStep` with hand-passed props asserts the leaf, which was
 * never the broken part, and would stay green with either container still
 * holding its own guard. So the CONTAINERS are rendered:
 *
 *   - `AuditTransactionModal`      — new transaction
 *   - `EditContactsModal`          — existing transaction
 *
 * `EditContactsModal` in particular is NOT allowed to mock `ContactsContext`
 * here, though every other suite for it does. The provider is now half of the
 * thing under test; mocking it away would leave a test that cannot go red when
 * the wiring is cut.
 *
 * ===========================================================================
 * EVERY ASSERTION IS AN ID SET, NEVER A COUNT
 * ===========================================================================
 * A refresh that emptied the address-book half would satisfy "Petra is gone"
 * and be far worse than the defect. `bystanderRecord` is in the list before and
 * after every answer, which is what separates "the answered record was dropped"
 * from "the address book was cleared".
 */

import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import AuditTransactionModal from "../AuditTransactionModal";
import { EditContactsModal } from "../transactionDetailsModule/components/modals/EditContactsModal";
import { PlatformProvider } from "../../contexts/PlatformContext";
import type { Contact, Transaction } from "../../../electron/types/models";
import type { ContactReviewCluster } from "@/types/contactProvenance";

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

const USER_ID = "user-2631";
const PROPERTY_ADDRESS = "123 Main Street";
const PROPOSAL_ID = "p-2631";

const SAVED_CONTACT_ID = "b7f1c8a2-4d3e-4f51-9c6a-2e8b0d4f7a13";
const MERGED_RECORD_ID = "5c9d2e71-8a4b-4c33-b1e7-6f0a9d3c5b82";
const BYSTANDER_RECORD_ID = "e3a6b904-1f27-4d58-8b0c-7a5e2c9f4d16";

/**
 * The saved contact the question is ABOUT. In the list before the answer and
 * still in it after — confirming a link ATTACHES a source record to an existing
 * contact, it does not create one. All the movement is on the address-book side.
 *
 * `review_state` is the shape `attachReviewState` stamps onto every row of
 * `contacts:get-all` / `contacts:get-sorted-by-activity`; it is what puts the
 * `Suggestion` badge on the row, and the badge is the only way into the
 * questions from this surface (BACKLOG-2603 — the row click ADDS the contact to
 * the deal, so the questions could not be routed through it).
 */
const savedBianca = {
  id: SAVED_CONTACT_ID,
  user_id: USER_ID,
  name: "Bianca Okafor",
  display_name: "Bianca Okafor",
  email: "bianca.okafor@example.com",
  phone: "+15035550130",
  company: "Okafor & Co Realty",
  source: "manual",
  is_imported: 1,
  created_at: "2026-08-01T09:00:00Z",
  updated_at: "2026-08-01T09:00:00Z",
  review_state: {
    columns: 2,
    records: 2,
    needsReview: false,
    openQuestions: 1,
    badge: "suggestion" as const,
  },
} as unknown as Contact;

/**
 * The address-book record the question is about — the one the user merges away.
 *
 * Emitted by `contacts:get-available` in the shape the BACKLOG-2510/2511 suites
 * pin, identity fields included. Its `id` is the shadow row's own UUID and can
 * never equal the saved contact's, which is why both rows render.
 */
const mergedAwayPetra = {
  id: MERGED_RECORD_ID,
  name: "Petra Lindqvist",
  display_name: "Petra Lindqvist",
  phone: "+15035550144",
  email: "p.lindqvist@example.net",
  company: "Northshore Title",
  source: "contacts_app",
  allPhones: ["+15035550144"],
  allEmails: ["p.lindqvist@example.net"],
  isFromDatabase: false,
  last_communication_at: "2026-08-02T14:20:00Z",
  externalRecordId: "AB-RECORD-6620",
  externalSourceType: "macos",
  externalUuid: "0f4c8a17-93b2-4d6e-a015-7c8e1b2f3d49",
} as unknown as Contact;

/**
 * An address-book record with NO question attached to it. Present before and
 * after every answer. Without it, a refresh that CLEARED the address-book half
 * would satisfy every "the merged record is gone" assertion in this file.
 */
const bystanderRecord = {
  ...(mergedAwayPetra as unknown as Record<string, unknown>),
  id: BYSTANDER_RECORD_ID,
  name: "Marek Tull",
  display_name: "Marek Tull",
  email: "marek.tull@example.net",
  allEmails: ["marek.tull@example.net"],
  phone: "+15035550171",
  allPhones: ["+15035550171"],
  company: "Tull Surveying",
  externalRecordId: "AB-RECORD-9902",
} as unknown as Contact;

/**
 * One open question about `savedBianca`, in the shape `getReviewQueue` really
 * returns — transcribed from `ReviewDuplicatesModal.test.tsx`'s fixture, which
 * is itself pinned against the real linker in
 * `electron/services/__tests__/contactLinkReview.test.ts`. `sourceRecordId` is
 * the record's own `externalRecordId`, so the question and the row it is about
 * name the SAME record rather than two ids that happen to sit together.
 *
 * Typed against the producer's interface, not cast into place, so a fixture that
 * drifted off `ExternalContactSource` or the crosswalk's `matchedOn` vocabulary
 * fails `type-check:tests` instead of quietly describing an impossible cluster.
 */
function openQuestionCluster(): ContactReviewCluster {
  return {
    clusterKey: `contact:${SAVED_CONTACT_ID}`,
    question: 'Is "Petra Lindqvist" the same person as Bianca Okafor?',
    exclusive: false,
    items: [
      {
        proposalId: PROPOSAL_ID,
        contactId: SAVED_CONTACT_ID,
        contactName: "Bianca Okafor",
        contactCompany: "Okafor & Co Realty",
        sourceType: "macos",
        sourceRecordId: "AB-RECORD-6620",
        sourceLabel: "Mac address book",
        sourceName: "Petra Lindqvist",
        sourceCompany: "Northshore Title",
        recordEmails: ["p.lindqvist@example.net"],
        recordPhones: ["+15035550144"],
        reason: "identifier_reassigned",
        matchedOn: "phone",
        identity: "possibly_same_person",
        identityPhrase: "possibly the same person",
        relationship: "possibly_connected",
        relationshipPhrase: "possibly connected",
        evidence: {
          summary:
            "A record in your Mac address book carries the phone number …0144, which you also have saved against Bianca Okafor.",
          details: ['The Mac address book entry is saved as "Petra Lindqvist".'],
          contactLabel: "Bianca Okafor",
          sourceLabel: "Mac address book",
          sourceName: "Petra Lindqvist",
        },
      },
    ],
  };
}

/** Every row the picker is rendering, as ids. IDENTITY, never a count. */
function renderedContactIds(): string[] {
  return screen
    .queryAllByTestId("contact-row")
    .map((row) => row.getAttribute("data-contact-id") ?? "")
    .sort();
}

function rowFor(name: string): HTMLElement {
  const nameEl = screen.getByText(name, {
    selector: '[data-testid="contact-row-name"]',
  });
  return nameEl.closest('[data-testid="contact-row"]') as HTMLElement;
}

const getAvailableCallCount = () =>
  jest.mocked(window.api.contacts.getAvailable).mock.calls.length;

/**
 * Let every settled promise and every React commit land.
 *
 * Needed where the property is that NOTHING changed. `waitFor` cannot express
 * that — it passes the instant the condition holds, which on an unchanged list
 * is immediately, before the refresh it is supposed to be outliving has even
 * committed. A macrotask boundary is past both instant mocks, past the
 * microtask queue React 18 defers its flush behind, and past the commit.
 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Wire both halves to answer the way the main process does.
 *
 * The address-book mock is keyed on WHETHER THE QUESTION HAS BEEN ANSWERED, not
 * on the call ordinal. `resolveProposal` flips `status` off `'pending'` and the
 * crosswalk suppression keys on the `contact_source_links` row the confirm
 * writes — so this is the producer's own rule rather than a counter that happens
 * to match it. An ordinal mock would also answer a SECOND reader as though the
 * first had already resolved something, which is how BACKLOG-2626 broke the 2627
 * fixtures.
 */
function installBackend() {
  let answered = false;

  jest
    .mocked(window.api.contacts.getAll)
    .mockResolvedValue({ success: true, contacts: [savedBianca] });
  jest
    .mocked(window.api.contacts.getSortedByActivity)
    .mockResolvedValue({ success: true, contacts: [savedBianca] });

  jest.mocked(window.api.contacts.getAvailable).mockImplementation(async () => ({
    success: true,
    contacts: answered
      ? // CONFIRMED: the record is claimed by a crosswalk row, so
        // `contacts:get-available` stops offering it (2608 CONTROL 2).
        [bystanderRecord]
      : [mergedAwayPetra, bystanderRecord],
  }));

  jest.mocked(window.api.contacts.getReviewQueue).mockImplementation(async () => ({
    success: true,
    clusters: answered ? [] : [openQuestionCluster()],
  }));
  jest
    .mocked(window.api.contacts.getReviewQueueCount)
    .mockImplementation(async () => ({ success: true, count: answered ? 0 : 1 }));

  jest.mocked(window.api.contacts.confirmLink).mockImplementation(async () => {
    answered = true;
    return { success: true, linked: true, alsoRejected: 0 };
  });
  jest.mocked(window.api.contacts.rejectLink).mockImplementation(async () => {
    answered = true;
    return { success: true };
  });

  return {
    /** For the reject control: the record SURVIVES a "not this person". */
    keepRecordOnAnswer() {
      jest.mocked(window.api.contacts.getAvailable).mockImplementation(async () => ({
        success: true,
        contacts: [mergedAwayPetra, bystanderRecord],
      }));
    },
  };
}

/**
 * Answer the question from inside the picker. The badge is the way in — the row
 * click adds the contact to the deal (BACKLOG-2603).
 */
async function answerSamePersonFromThePicker() {
  await userEvent.click(
    within(rowFor("Bianca Okafor")).getByTestId("contact-row-badge-action"),
  );
  await userEvent.click(await screen.findByTestId(`review-confirm-${PROPOSAL_ID}`));
  await waitFor(() =>
    expect(window.api.contacts.confirmLink).toHaveBeenCalledWith(USER_ID, PROPOSAL_ID),
  );
}

/**
 * The questions screen closes ITSELF once the contact it was filtered to has
 * nothing outstanding (`ReviewDuplicatesModal:293-295`, shipped). That is why no
 * assertion here says "the questions modal is still open" — it should not be.
 *
 * "Without closing the modal" in the report means the PICKER: the wizard the
 * user is part-way through, which never unmounted. Asserted by NODE IDENTITY,
 * because a picker that was torn down and rebuilt also renders a step-2
 * container, and rebuilding it is exactly the workaround (close and reopen) the
 * defect forced on the user.
 */
function pickerNode(): HTMLElement {
  return screen.getByTestId("contact-assignment-step-2");
}

// ===========================================================================
// ENTRY POINT A — NEW TRANSACTION (AuditTransactionModal)
// ===========================================================================

/** Walk the wizard to step 2, which is where the picker lives. */
async function openTheNewTransactionPicker() {
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
}

// ===========================================================================
// ENTRY POINT B — EXISTING TRANSACTION (EditContactsModal)
// ===========================================================================

const existingTransaction = {
  id: "txn-2631",
  user_id: USER_ID,
  property_address: PROPERTY_ADDRESS,
  transaction_type: "purchase",
  status: "active",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
} as unknown as Transaction;

/** Open the modal, then the Add Contacts overlay — the picker's second home. */
async function openTheExistingTransactionPicker() {
  render(
    <EditContactsModal
      transaction={existingTransaction}
      userId={USER_ID}
      onClose={jest.fn()}
      onSave={jest.fn()}
    />,
  );

  // No parties on the deal yet, so Screen 1 shows its empty state and its own
  // button. Deliberately empty: it keeps `selectedContactIds` unseeded, so every
  // row below is in "Available" and the ID sets say only what this item is about.
  await userEvent.click(await screen.findByTestId("empty-state-add-button"));
  await screen.findByTestId("contact-assignment-step-2");
}

beforeEach(() => {
  jest.clearAllMocks();

  jest.mocked(window.api.address.initialize).mockResolvedValue({ success: true });
  jest
    .mocked(window.api.address.getSuggestions)
    .mockResolvedValue({ success: true, suggestions: [] });
  jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
    success: true,
    transaction: { ...existingTransaction, contact_assignments: [] },
  } as never);
});

describe("BACKLOG-2631 — one refresh path, both transaction surfaces", () => {
  /**
   * CONTROL 1A — THE REPORTED DEFECT, NEW-TRANSACTION WIZARD.
   *
   * OBSERVED RED: point `ContactAssignmentStep`'s `onResolved` back at a
   * saved-half-only reload (`void onRefreshContacts()`, or restore the deleted
   * `silentRefreshContacts`) and the final ID set still contains
   * `MERGED_RECORD_ID` — `contacts:get-available` is never asked a second time.
   */
  it("A: answering 'same person' takes the record off the list without closing the wizard", async () => {
    installBackend();
    await openTheNewTransactionPicker();

    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [SAVED_CONTACT_ID, MERGED_RECORD_ID, BYSTANDER_RECORD_ID].sort(),
      ),
    );
    const pickerBefore = pickerNode();

    await answerSamePersonFromThePicker();

    // The merged-away record is GONE. The saved contact it joined is still
    // there, and so is the record nobody asked about.
    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [SAVED_CONTACT_ID, BYSTANDER_RECORD_ID].sort(),
      ),
    );
    expect(renderedContactIds()).not.toContain(MERGED_RECORD_ID);

    // WITHOUT CLOSING AND REOPENING — the same picker node the whole way
    // through. That is the property; reopening was the workaround the defect
    // forced, and a test that reopened would pass on the broken build.
    expect(pickerNode()).toBe(pickerBefore);
  });

  /**
   * CONTROL 1B — THE SAME DEFECT, EXISTING-TRANSACTION OVERLAY.
   *
   * Asserted separately because these were separate copies: a fix that unified
   * only the wizard is the same bug with a smaller radius. Note this suite does
   * NOT mock `ContactsContext` — see the file docblock.
   *
   * OBSERVED RED: restore `Screen2Overlay`'s private `getAvailable` state and
   * mount guard, or point `onRefreshBothLists` at a saved-only refresh, and
   * `MERGED_RECORD_ID` is still rendered at the end.
   */
  it("B: answering 'same person' takes the record off the list without closing the overlay", async () => {
    installBackend();
    await openTheExistingTransactionPicker();

    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [SAVED_CONTACT_ID, MERGED_RECORD_ID, BYSTANDER_RECORD_ID].sort(),
      ),
    );
    const pickerBefore = pickerNode();

    await answerSamePersonFromThePicker();

    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [SAVED_CONTACT_ID, BYSTANDER_RECORD_ID].sort(),
      ),
    );
    expect(renderedContactIds()).not.toContain(MERGED_RECORD_ID);
    expect(pickerNode()).toBe(pickerBefore);
    expect(screen.getByTestId("add-contacts-overlay")).toBeInTheDocument();
  });

  /**
   * THE MECHANISM, STATED ON ITS OWN FOR BOTH SURFACES.
   *
   * The list moving is downstream of one thing: the address book being ASKED
   * AGAIN. Before this change neither surface could, and asserting it directly
   * is what distinguishes "we looked again and it was gone" from any renderer
   * rule that removed the row by resemblance.
   */
  it("A: asks the ADDRESS BOOK again — the half the answer changed", async () => {
    installBackend();
    await openTheNewTransactionPicker();
    await waitFor(() => expect(getAvailableCallCount()).toBe(1));

    await answerSamePersonFromThePicker();

    await waitFor(() => expect(getAvailableCallCount()).toBe(2));
    // And the saved half moves with it, in the same call — that is what makes it
    // one commit rather than two renders.
    expect(window.api.contacts.getSortedByActivity).toHaveBeenCalledTimes(2);
  });

  it("B: asks the ADDRESS BOOK again — the half the answer changed", async () => {
    installBackend();
    await openTheExistingTransactionPicker();
    await waitFor(() => expect(getAvailableCallCount()).toBe(1));

    await answerSamePersonFromThePicker();

    await waitFor(() => expect(getAvailableCallCount()).toBe(2));
    expect(window.api.contacts.getSortedByActivity).toHaveBeenCalledTimes(2);
  });

  /**
   * CONTROL — THE FOUNDER'S RULE FROM BACKLOG-2608, WHICH THIS MUST NOT UNDO.
   *
   *   "if I clicked not this person this contact shouldn't disappear."
   *
   * A refresh is not a licence to drop the row. The SET is unchanged AND the
   * refresh demonstrably happened, so this reads "we asked again, and the answer
   * was: still there" rather than "we never looked" — without the second half it
   * would pass on the broken build.
   */
  it("A: 'not this person' KEEPS the record, and still refreshes both halves", async () => {
    const backend = installBackend();
    backend.keepRecordOnAnswer();
    await openTheNewTransactionPicker();

    const before = [SAVED_CONTACT_ID, MERGED_RECORD_ID, BYSTANDER_RECORD_ID].sort();
    await waitFor(() => expect(renderedContactIds()).toEqual(before));

    await userEvent.click(
      within(rowFor("Bianca Okafor")).getByTestId("contact-row-badge-action"),
    );
    await userEvent.click(await screen.findByTestId(`review-reject-${PROPOSAL_ID}`));
    await waitFor(() =>
      expect(window.api.contacts.rejectLink).toHaveBeenCalledWith(USER_ID, PROPOSAL_ID),
    );

    // We DID go and look…
    await waitFor(() => expect(getAvailableCallCount()).toBe(2));
    // …and the record is still on the list, by id.
    expect(renderedContactIds()).toEqual(before);
  });

  /**
   * CONTROL 5 — NO DOUBLE-FETCH. A CORRECT LIST THAT COSTS FORTY QUERIES IS A
   * NEW DEFECT.
   *
   * `contacts:get-available` reads the whole address book. BACKLOG-2633 brought
   * it from 7.4s at the founder's corpus (91s at a realistic mailbox) to ~11ms,
   * which is what made removing the mount guard safe — but "safe to ask again"
   * is not "ask on every render".
   *
   * WHAT DRIVES THE RENDER HERE, STATED PRECISELY, BECAUSE THE OBVIOUS ANSWER IS
   * WRONG: the search box is UNCONTROLLED on this surface — `ContactSearchList`
   * keeps `searchQuery` in its own state and `ContactAssignmentStep` passes none
   * — so typing re-renders the LIST and not the container that owns the hook. A
   * keystroke-only assertion could not separate the two implementations, so it
   * is not the load-bearing half of this test.
   *
   * SELECTING A CONTACT is. "+ Add" calls `onSelectedContactIdsChange`, which
   * lands in `useAuditContactAssignment`'s own state — the hook's container
   * re-renders, `useContactDirectory` is called again, and any fetch reachable
   * from a render or from an unstable effect dependency fires here. The
   * keystrokes stay because they cost nothing and cover the list's own renders.
   *
   * ASSERTED AS A COUNT, and deliberately: the resulting LIST is identical
   * either way, so no assertion about rows can separate the two.
   *
   * The guard that makes this hold is measured directly, one layer down, in
   * `useContactDirectory.fetchDiscipline-2631.test.tsx`.
   */
  it("A: does not re-read the address book on render, selection, or keystroke", async () => {
    installBackend();
    await openTheNewTransactionPicker();
    await waitFor(() => expect(getAvailableCallCount()).toBe(1));

    const search = screen.getByPlaceholderText(/search contacts/i);
    await userEvent.type(search, "Lindqvist");
    await waitFor(() =>
      expect(renderedContactIds()).toEqual([MERGED_RECORD_ID]),
    );
    expect(getAvailableCallCount()).toBe(1);

    await userEvent.clear(search);
    await waitFor(() => expect(renderedContactIds()).toHaveLength(3));

    // THE LOAD-BEARING PART: container re-renders driven by real selection.
    // The SAVED contact, not an address-book row — "+ Add" on an external record
    // IMPORTS it, which is a different action with its own refresh, and would
    // confound the count this test exists to read.
    await userEvent.click(
      within(rowFor("Bianca Okafor")).getByTestId("contact-row-add-button"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("added-count")).toHaveTextContent("1"),
    );
    await userEvent.click(screen.getByTestId(`remove-added-${SAVED_CONTACT_ID}`));
    await waitFor(() =>
      expect(screen.getByTestId("added-count")).toHaveTextContent("0"),
    );
    await userEvent.click(
      within(rowFor("Bianca Okafor")).getByTestId("contact-row-add-button"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("added-count")).toHaveTextContent("1"),
    );
    await settle();

    expect(getAvailableCallCount()).toBe(1);
    expect(window.api.contacts.getSortedByActivity).toHaveBeenCalledTimes(1);
  });

  /**
   * CONTROL 5, THE HALF THAT IS ABOUT THE PROVIDER.
   *
   * `ContactsProvider` wraps Screen 1 as well as the picker. Moving the
   * address-book half up into it would have put a whole-corpus read on every
   * open of EditContactsModal — including the many that never open Add Contacts.
   * So the provider loads the SAVED half eagerly and the address book only when
   * `Screen2Overlay` mounts.
   *
   * OBSERVED RED: drop `autoLoadExternal: false` from the provider's
   * `useContactDirectory` options and the first expectation reads 1.
   */
  it("B: reads the address book when the PICKER opens, not when the modal opens", async () => {
    installBackend();
    render(
      <EditContactsModal
        transaction={existingTransaction}
        userId={USER_ID}
        onClose={jest.fn()}
        onSave={jest.fn()}
      />,
    );

    // Screen 1 is up and its parties are loaded…
    await screen.findByTestId("empty-state-add-button");
    await waitFor(() =>
      expect(window.api.contacts.getSortedByActivity).toHaveBeenCalledTimes(1),
    );
    // …and the address book has not been touched.
    await settle();
    expect(getAvailableCallCount()).toBe(0);

    await userEvent.click(screen.getByTestId("empty-state-add-button"));
    await screen.findByTestId("contact-assignment-step-2");

    await waitFor(() => expect(getAvailableCallCount()).toBe(1));
  });

  /**
   * THE REFRESH MUST NOT COST THE USER THEIR PLACE.
   *
   * Founder constraint carried over from BACKLOG-2511/2459. It matters more here
   * than on Clients & Contacts: this list is one the user is part-way through
   * SELECTING from, and an answer session is several answers in a row.
   *
   * Every row in `ContactSearchList` is gated on `!isLoading`, and both loading
   * flags feed it — so raising one does not show a spinner NEXT TO the list, it
   * REPLACES the list with one, unmounting every row and any selection scroll
   * position with them. `refreshBothLists` never raises the external flag.
   *
   * WHY THIS ASSERTS A DOM NODE, NOT A SCROLL OFFSET: jsdom performs no layout,
   * so `scrollTop` cannot be made non-zero and a scroll assertion would pass on
   * `0 === 0` forever. Element identity is the property that separates the two
   * outcomes — React reconciling in place keeps the SAME node; any
   * unmount/remount produces a new one.
   *
   * WHY THE SECOND FETCH IS HELD OPEN: with an instant mock React 18 coalesces
   * the `true` and `false` of a loading flag into one render, so the spinner
   * state is never committed and the check cannot fail either way. The
   * assertions that matter run WHILE THE REFETCH IS IN FLIGHT — the only window
   * in which the two implementations differ.
   */
  it("A: refreshes without rebuilding the list, so an answer keeps the user's place", async () => {
    installBackend();

    let releaseRefetch!: () => void;
    const refetchInFlight = new Promise<void>((resolve) => {
      releaseRefetch = resolve;
    });
    let answered = false;
    jest.mocked(window.api.contacts.confirmLink).mockImplementation(async () => {
      answered = true;
      return { success: true, linked: true, alsoRejected: 0 };
    });
    jest.mocked(window.api.contacts.getReviewQueue).mockImplementation(async () => ({
      success: true,
      clusters: answered ? [] : [openQuestionCluster()],
    }));
    jest
      .mocked(window.api.contacts.getReviewQueueCount)
      .mockImplementation(async () => ({ success: true, count: answered ? 0 : 1 }));
    jest.mocked(window.api.contacts.getAvailable).mockImplementation(async () => {
      if (!answered) {
        return { success: true, contacts: [mergedAwayPetra, bystanderRecord] };
      }
      await refetchInFlight;
      return { success: true, contacts: [bystanderRecord] };
    });

    await openTheNewTransactionPicker();
    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [SAVED_CONTACT_ID, MERGED_RECORD_ID, BYSTANDER_RECORD_ID].sort(),
      ),
    );

    // The row NOT involved in the answer. In the list before and after, so if
    // the list survives the refresh this exact element does too.
    const rowBefore = document.querySelector(
      `[data-contact-id="${BYSTANDER_RECORD_ID}"]`,
    );
    expect(rowBefore).not.toBeNull();

    await answerSamePersonFromThePicker();
    await waitFor(() => expect(getAvailableCallCount()).toBe(2));

    // ---- THE REFETCH IS NOW IN FLIGHT. This is the window that matters. ----
    expect(document.querySelector(`[data-contact-id="${BYSTANDER_RECORD_ID}"]`)).toBe(
      rowBefore,
    );

    releaseRefetch();
    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [SAVED_CONTACT_ID, BYSTANDER_RECORD_ID].sort(),
      ),
    );
    // Survived the whole way through. Not "a row is there" — a rebuilt list also
    // has a row there. The SAME NODE, so nothing was torn down.
    expect(document.querySelector(`[data-contact-id="${BYSTANDER_RECORD_ID}"]`)).toBe(
      rowBefore,
    );
  });

  /**
   * A FAILED REFRESH LEAVES THE SCREEN CONSISTENT, NOT HALF-NEW.
   *
   * `refreshBothLists` commits NEITHER half unless BOTH fetches succeed. If it
   * committed the address-book result alone, the record would vanish while the
   * saved half was still stale — and on THIS surface the saved half is what the
   * user is picking parties from. The verdict is written either way, so the next
   * open repairs it.
   */
  it("A: commits nothing when one half of the refresh fails", async () => {
    installBackend();
    let savedCalls = 0;
    jest.mocked(window.api.contacts.getSortedByActivity).mockImplementation(async () => {
      savedCalls += 1;
      return savedCalls === 1
        ? { success: true, contacts: [savedBianca] }
        : { success: false, error: "database is locked" };
    });

    await openTheNewTransactionPicker();
    const before = [SAVED_CONTACT_ID, MERGED_RECORD_ID, BYSTANDER_RECORD_ID].sort();
    await waitFor(() => expect(renderedContactIds()).toEqual(before));

    await answerSamePersonFromThePicker();
    await waitFor(() => expect(getAvailableCallCount()).toBe(2));
    // Both halves have been asked and both have answered. `settle` — not
    // `waitFor` — because the property is that NOTHING moved, and `waitFor`
    // passes the instant an unchanged list is unchanged, which is before the
    // refresh it is meant to outlive has committed.
    await settle();

    // The address-book fetch succeeded and would have dropped the record. It was
    // not committed, because its partner failed.
    expect(renderedContactIds()).toEqual(before);
  });
});
