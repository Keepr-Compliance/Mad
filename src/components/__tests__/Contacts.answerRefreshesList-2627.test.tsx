/**
 * Answering a duplicate question refreshes the contacts list (BACKLOG-2627).
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * Founder test, 2026-08-10, on PR #2270's build. He answered two questions in
 * the review queue — *not this person* on one candidate, *same person* on
 * another — then searched Clients & Contacts. The list showed the PRE-ANSWER
 * state. Only navigating away and back updated it.
 *
 * The app's own funnel proves it. The last picker computation was logged at
 * `00:37:39`, BEFORE either answer:
 *
 *     00:37:39  picker: 1154 in -> already-imported 1 -> dup-suppressed 0
 *               -> shown 1153
 *     (two answers, no recomputation)
 *
 * ===========================================================================
 * WHY IT LOOKED LIKE A WORKING REFRESH IN CODE REVIEW
 * ===========================================================================
 * `onResolved` DID refresh — it called `silentLoadContacts()`. But this screen
 * joins TWO lists in the renderer, `contacts:get-all` (saved) and
 * `contacts:get-available` (the address book), and the half an answer changes
 * is the second one. `silentLoadContacts` re-reads only the first.
 *
 * The address-book half is guarded by `externalContactsLoadedRef`
 * (`useContactList.ts`), a once-per-mount flag, so it was never asked again for
 * the life of the mount — which is exactly the silence in the funnel log. The
 * fix routes `onResolved` through `refreshBothLists`, the fetch-both-commit-once
 * function BACKLOG-2511/2526 already built for the import path.
 *
 * ===========================================================================
 * WHY THIS COST MORE THAN A STALE SCREEN
 * ===========================================================================
 * The stale list was read as evidence that a DIFFERENT fix had failed to remove
 * a record, and that was said out loud. It had worked; the screen was ten
 * minutes old. A verification that reads a cached list cannot distinguish "the
 * fix failed" from "the screen is old" — the same class of problem as a green
 * test that never ran.
 *
 * ===========================================================================
 * WHY EVERY ASSERTION BELOW IS AN ID SET AND NEVER A COUNT
 * ===========================================================================
 * The two answers move the list in OPPOSITE directions — confirm removes a row,
 * reject keeps it — and a count agrees with a build that removed the wrong one.
 * Every assertion reads `data-contact-id` (`ContactRow.tsx`) and compares the
 * SET.
 *
 * ===========================================================================
 * THE FIXTURES' SECOND `getAvailable` IS TRANSCRIBED, NOT WISHED FOR
 * ===========================================================================
 * Confirm makes the record vanish from the address book and reject does not.
 * That is an assertion about the MAIN PROCESS, and this whole file rests on it.
 * It is pinned by execution against the real handler, the real schema and the
 * real writers (`confirmProposal` / `rejectProposal`) on this exact base, in
 * `electron/__tests__/contact-handlers.stopHidingRecords-2608.test.ts`:
 *
 *   CONTROL 2 — "the confirmed record leaves the list; the other three stay"
 *   CONTROL 3 — "the rejected record REMAINS visible after the question is
 *                closed" [PRIMARY]
 *
 * `contact_source_links` is what decides; confirm writes a row there, reject
 * writes only a verdict. So the mocks below are that behaviour copied, not a
 * state the app can never reach.
 */

import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Contacts from "../Contacts";
import type { Contact } from "../../../electron/types/models";
import type { ContactReviewCluster } from "@/types/contactProvenance";

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
  (window as unknown as { matchMedia: unknown }).matchMedia = jest
    .fn()
    .mockReturnValue({
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

const USER_ID = "user-2627";

const SAVED_CONTACT_ID = "a3f5c7e9-1b2d-4e6f-8a0c-9d1e2f3a4b5c";
const CANDIDATE_ROW_ID = "7e2b9d41-6c83-4a5f-b0e2-8d7c6b5a4938";
const BYSTANDER_ROW_ID = "c1d3e5f7-2b4a-4d6c-9e8f-0a1b2c3d4e5f";
const PROPOSAL_ID = "p-2627";

/**
 * The saved contact the question is ABOUT. Already in the list before the
 * answer and still in it after — confirming a link attaches a source record to
 * an existing contact, it does not create one. That is why the interesting
 * movement is all on the address-book side.
 */
const savedRosalind = {
  id: SAVED_CONTACT_ID,
  user_id: USER_ID,
  name: "Rosalind Vance",
  display_name: "Rosalind Vance",
  email: "rosalind.vance@example.com",
  phone: "+14155550134",
  source: "manual",
  is_imported: 1,
  created_at: "2026-08-01T09:00:00Z",
  updated_at: "2026-08-01T09:00:00Z",
} as unknown as Contact;

/**
 * The candidate, exactly as `contacts:get-available` emits it — the shape the
 * BACKLOG-2510/2511 suites pin, identity fields included. Its `id` is the
 * shadow row's own UUID and can never equal the saved contact's, which is why
 * `assembleContacts` (collapses on exact `id` only) shows both rows.
 */
const candidateRecord = {
  id: CANDIDATE_ROW_ID,
  name: "R. Vance",
  phone: "+14155550134",
  email: "r.vance@example.com",
  company: "Vance & Co",
  source: "contacts_app",
  allPhones: ["+14155550134"],
  allEmails: ["r.vance@example.com"],
  isFromDatabase: false,
  last_communication_at: "2026-08-02T14:20:00Z",
  externalRecordId: "AB-RECORD-4417",
  externalSourceType: "macos",
  externalUuid: "3c9a1b7e-52d4-4f60-b8a1-9d7e2f0c4a55",
} as unknown as Contact;

/**
 * An address-book record with NO question attached to it.
 *
 * It is in the list before and after every answer, which is what separates "the
 * answered record was dropped" from "the address book was cleared". A refresh
 * that emptied the external half would satisfy every confirm assertion in this
 * file and be far worse than the defect.
 */
const bystanderRecord = {
  ...(candidateRecord as unknown as Record<string, unknown>),
  id: BYSTANDER_ROW_ID,
  name: "Marek Tull",
  email: "marek.tull@example.com",
  allEmails: ["marek.tull@example.com"],
  phone: "+14155550142",
  allPhones: ["+14155550142"],
  company: "Tull Surveying",
  externalRecordId: "AB-RECORD-9902",
} as unknown as Contact;

/**
 * One open question about `savedRosalind`, in the shape `getReviewQueue`
 * really returns.
 *
 * Transcribed from `ReviewDuplicatesModal.test.tsx`'s own fixture, which is in
 * turn pinned against the real linker in
 * `electron/services/__tests__/contactLinkReview.test.ts` ("carries the
 * candidate's own values and the contact's company"). `sourceRecordId` is the
 * candidate's `externalRecordId`, so the question and the row it is about name
 * the same record rather than two unrelated ids that happen to sit together.
 *
 * TYPED AGAINST THE PRODUCER'S OWN INTERFACE, not cast into place: `sourceType`
 * is `ExternalContactSource` (`'macos' | 'iphone' | 'outlook' | ...`) and
 * `matchedOn` is the crosswalk's own vocabulary, so a fixture that drifted off
 * either union fails `type-check:tests` rather than quietly describing a
 * cluster `getReviewQueue` cannot emit.
 */
function openQuestionCluster(): ContactReviewCluster {
  return {
    clusterKey: `contact:${SAVED_CONTACT_ID}`,
    question: 'Is "R. Vance" the same person as Rosalind Vance?',
    exclusive: false,
    items: [
      {
        proposalId: PROPOSAL_ID,
        contactId: SAVED_CONTACT_ID,
        contactName: "Rosalind Vance",
        contactCompany: null,
        sourceType: "macos",
        sourceRecordId: "AB-RECORD-4417",
        sourceLabel: "Mac address book",
        sourceName: "R. Vance",
        recordEmails: ["r.vance@example.com"],
        recordPhones: ["+14155550134"],
        reason: "identifier_reassigned",
        matchedOn: "phone",
        identity: "possibly_same_person",
        identityPhrase: "possibly the same person",
        relationship: "possibly_connected",
        relationshipPhrase: "possibly connected",
        evidence: {
          summary:
            "A record in your Mac address book carries the phone number …0134, which you also have saved against Rosalind Vance.",
          details: ['The Mac address book entry is saved as "R. Vance".'],
          contactLabel: "Rosalind Vance",
          sourceLabel: "Mac address book",
          sourceName: "R. Vance",
        },
      },
    ],
  };
}

/** Every row the list is rendering, as ids. IDENTITY, never a count. */
function renderedContactIds(): string[] {
  return screen
    .queryAllByTestId("contact-row")
    .map((row) => row.getAttribute("data-contact-id") ?? "")
    .sort();
}

/**
 * Wire both halves to answer the way the main process does.
 *
 * `availableAfterAnswer` is the whole experiment: `[bystanderRecord]` is what a
 * CONFIRM leaves behind (2608 CONTROL 2), and both records is what a REJECT
 * leaves behind (2608 CONTROL 3).
 */
function installBackend(options: { availableAfterAnswer: Contact[] }) {
  jest
    .mocked(window.api.contacts.getAll)
    .mockResolvedValue({ success: true, contacts: [savedRosalind] });

  let getAvailableCalls = 0;
  jest.mocked(window.api.contacts.getAvailable).mockImplementation(async () => {
    getAvailableCalls += 1;
    return {
      success: true,
      contacts:
        getAvailableCalls === 1
          ? [candidateRecord, bystanderRecord]
          : options.availableAfterAnswer,
    };
  });

  /*
    KEYED ON WHETHER THE QUESTION HAS BEEN ANSWERED, NOT ON THE CALL ORDINAL.

    These two used to return the question on their FIRST call and nothing after.
    That held only while exactly one consumer read them; BACKLOG-2626 added a
    second (`useOpenQuestions`, which the contact-row walk reads), and an ordinal
    mock answers the second reader as though the first had already resolved
    something.

    `answered` is what the main process actually keys on — `resolveProposal`
    flips `status` off `'pending'` and `PENDING_JOIN` selects on it — so this is
    the producer's own rule rather than a counter that happened to match it. It
    is also why the guards below still mean what they meant: nothing about WHEN
    the queue empties has changed, only what makes it empty.
  */
  let answered = false;

  // The button that opens the queue only renders while the count is > 0, so the
  // read before the answer must find the question and the read after must not.
  jest
    .mocked(window.api.contacts.getReviewQueueCount)
    .mockImplementation(async () => ({ success: true, count: answered ? 0 : 1 }));

  jest.mocked(window.api.contacts.getReviewQueue).mockImplementation(async () => ({
    success: true,
    clusters: answered ? [] : [openQuestionCluster()],
  }));

  jest.mocked(window.api.contacts.confirmLink).mockImplementation(async () => {
    answered = true;
    return { success: true, linked: true, alsoRejected: 0 };
  });
  jest.mocked(window.api.contacts.rejectLink).mockImplementation(async () => {
    answered = true;
    return { success: true };
  });
  jest
    .mocked(window.api.contacts.checkCanDelete)
    .mockResolvedValue({ success: true, transactions: [] });
}

/**
 * Open the queue OVER the list, which is the founder's situation exactly:
 * Clients & Contacts is behind it the whole time and he never navigates.
 */
async function openTheQueue() {
  await userEvent.click(await screen.findByTestId("review-duplicates-button"));
  await screen.findByTestId(`review-item-${PROPOSAL_ID}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  installMatchMedia(false);
});

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe("BACKLOG-2627 — an answer moves the list behind the queue", () => {
  /**
   * CONTROL 1 — THE FOUNDER'S CASE.
   *
   * CONTROL: revert `onResolved` to `silentLoadContacts()` and this goes red —
   * `contacts:get-available` is never asked a second time (the once-per-mount
   * guard), so `CANDIDATE_ROW_ID` is still in the set at the end.
   */
  it("'same person' takes the record off the list WITHOUT navigating away", async () => {
    installBackend({ availableAfterAnswer: [bystanderRecord] });
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);

    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [SAVED_CONTACT_ID, CANDIDATE_ROW_ID, BYSTANDER_ROW_ID].sort(),
      ),
    );

    await openTheQueue();
    await userEvent.click(screen.getByTestId(`review-confirm-${PROPOSAL_ID}`));
    await waitFor(() => expect(window.api.contacts.confirmLink).toHaveBeenCalledWith(
      USER_ID,
      PROPOSAL_ID,
    ));

    // The record is GONE and the saved contact it joined is still there. Both
    // halves matter: dropping the saved contact would also shrink the set.
    await waitFor(() =>
      expect(renderedContactIds()).toEqual([SAVED_CONTACT_ID, BYSTANDER_ROW_ID].sort()),
    );
    expect(renderedContactIds()).not.toContain(CANDIDATE_ROW_ID);

    // Nothing unmounted the list to achieve it — no navigation, no remount.
    // This is the same screen he was looking at.
    expect(screen.getByTestId("review-duplicates-modal")).toBeInTheDocument();
  });

  /**
   * The MECHANISM, stated on its own, because it is the only reason control 1
   * can pass.
   *
   * `loadExternalContacts` refuses to refetch for the life of the mount
   * (`externalContactsLoadedRef`), so a second `contacts:get-available` happens
   * only if the answer path deliberately went through `refreshBothLists`.
   */
  it("asks the ADDRESS BOOK again, which is the half the answer changed", async () => {
    installBackend({ availableAfterAnswer: [bystanderRecord] });
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(1));

    await openTheQueue();
    await userEvent.click(screen.getByTestId(`review-confirm-${PROPOSAL_ID}`));

    await waitFor(() => expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(2));
    // And the saved half is refreshed with it, in the same call.
    expect(window.api.contacts.getAll).toHaveBeenCalledTimes(2);
  });

  /**
   * CONTROL 2 — THE FOUNDER'S RULE FROM BACKLOG-2608, WHICH THIS MUST NOT UNDO.
   *
   *   "if I clicked not this person this contact shouldn't disappear."
   *
   * A refresh is not a licence to drop the row. The assertion that the SET is
   * unchanged is the guard against an optimistic fix that removes whatever was
   * just answered, and it is paired with the refresh actually having happened —
   * so this is "we asked again, and the answer was: still there", not "we never
   * looked". Without the second half the test would pass on the broken build.
   */
  it("'not this person' KEEPS the record, and still refreshes", async () => {
    installBackend({ availableAfterAnswer: [candidateRecord, bystanderRecord] });
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);

    const before = [SAVED_CONTACT_ID, CANDIDATE_ROW_ID, BYSTANDER_ROW_ID].sort();
    await waitFor(() => expect(renderedContactIds()).toEqual(before));

    await openTheQueue();
    await userEvent.click(screen.getByTestId(`review-reject-${PROPOSAL_ID}`));
    await waitFor(() =>
      expect(window.api.contacts.rejectLink).toHaveBeenCalledWith(USER_ID, PROPOSAL_ID),
    );

    // We DID go and look…
    await waitFor(() => expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(2));
    // …and the record is still on the list, by id, permanently.
    expect(renderedContactIds()).toEqual(before);

    // The question is gone from the queue, which is the visible half of the
    // count decrementing: `refreshReviewQueueCount` re-read it as 0 and the
    // reloaded queue has nothing left in it.
    await waitFor(() =>
      expect(screen.getByTestId("review-duplicates-empty")).toBeInTheDocument(),
    );
    expect(window.api.contacts.getReviewQueueCount).toHaveBeenCalledTimes(2);
  });

  /**
   * CONTROL 3 — THE BACKLOG-2502 EXCEPTION IS UNTOUCHED.
   *
   * Compare's `×` must NOT reload the queue on close, because that reshuffles a
   * list the user is part-way through answering. This change refreshes the
   * CONTACTS list on an ANSWER, which is a different surface and a different
   * trigger, and this pins that the two did not get confused.
   *
   * The guard itself lives in `ReviewDuplicatesModal.test.tsx` ("× on compare
   * pops ONE layer"), asserted there against `getReviewQueue` call count; it is
   * green before and after this change. What is asserted HERE is the property
   * that could plausibly have been broken from this file's side: answering adds
   * no extra queue read of its own.
   *
   * CONTROL: add `void load()` to the compare overlay's `onClose` and the
   * ReviewDuplicatesModal guard reads 2. Add a queue reload to `onResolved` and
   * the DELTA below reads 2.
   *
   * ASSERTED AS A DELTA, not as a total (BACKLOG-2626). The property is "the
   * contacts refresh contributes no queue read", which is about what the ANSWER
   * costs — and a total also counts every read taken before it, so it moved the
   * moment a second consumer mounted. A delta says the same thing and keeps
   * saying it.
   */
  it("adds no queue read of its own — the queue does not reshuffle mid-session", async () => {
    installBackend({ availableAfterAnswer: [bystanderRecord] });
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);

    await openTheQueue();
    const before = jest.mocked(window.api.contacts.getReviewQueue).mock.calls.length;

    await userEvent.click(screen.getByTestId(`review-confirm-${PROPOSAL_ID}`));
    await waitFor(() =>
      expect(renderedContactIds()).toEqual([SAVED_CONTACT_ID, BYSTANDER_ROW_ID].sort()),
    );

    // Exactly one: the modal's OWN post-answer reload, which is shipped
    // BACKLOG-2502 behaviour and predates this change. The contacts refresh
    // contributed none.
    const after = jest.mocked(window.api.contacts.getReviewQueue).mock.calls.length;
    expect(after - before).toBe(1);
  });

  /**
   * CONTROL 4 — THE REFRESH MUST NOT COST HIM HIS PLACE.
   *
   * Founder constraint carried over from BACKLOG-2511: *"just make sure this
   * doesn't interfere with keeping the location on the page the user was on."*
   * It matters MORE here than it did there, because an answer session is
   * several answers in a row — one spinner per answer would be unusable.
   *
   * Every row in `ContactSearchList` is gated on `!isLoading`, and
   * `externalContactsLoading` feeds `isLoading`, so raising it does not put a
   * spinner NEXT TO the list — it replaces the list with one, unmounting every
   * row and losing the scroll container's contents. `refreshBothLists` never
   * raises it.
   *
   * WHY THIS ASSERTS A DOM NODE AND NOT A SCROLL OFFSET: jsdom performs no
   * layout, so `scrollTop` cannot be made non-zero and a scroll assertion would
   * pass on `0 === 0` forever. Element identity is the property that actually
   * separates the two outcomes — React reconciling in place keeps the SAME node;
   * any unmount/remount produces a new one.
   *
   * WHY THE SECOND FETCH IS HELD OPEN: with an instant mock React 18 coalesces
   * the `true` and `false` of a loading flag into one render, so the spinner
   * state is never committed and the check cannot fail either way. The real
   * `contacts:get-available` reads the whole address book on a worker thread
   * (~3.7s at 1000+ contacts, TASK-1956), so the assertions that matter run
   * WHILE THE REFETCH IS IN FLIGHT — the only window in which the two
   * implementations differ.
   */
  it("refreshes without rebuilding the list, so an answer keeps the user's place", async () => {
    jest
      .mocked(window.api.contacts.getAll)
      .mockResolvedValue({ success: true, contacts: [savedRosalind] });

    let releaseRefetch!: () => void;
    const refetchInFlight = new Promise<void>((resolve) => {
      releaseRefetch = resolve;
    });

    let getAvailableCalls = 0;
    jest.mocked(window.api.contacts.getAvailable).mockImplementation(async () => {
      getAvailableCalls += 1;
      if (getAvailableCalls === 1) {
        return { success: true, contacts: [candidateRecord, bystanderRecord] };
      }
      await refetchInFlight;
      return { success: true, contacts: [bystanderRecord] };
    });

    // Keyed on the answer rather than the call ordinal, for the reason given in
    // `installBackend`.
    let answered = false;
    jest
      .mocked(window.api.contacts.getReviewQueueCount)
      .mockImplementation(async () => ({ success: true, count: answered ? 0 : 1 }));
    jest.mocked(window.api.contacts.getReviewQueue).mockImplementation(async () => ({
      success: true,
      clusters: answered ? [] : [openQuestionCluster()],
    }));
    jest.mocked(window.api.contacts.confirmLink).mockImplementation(async () => {
      answered = true;
      return { success: true, linked: true, alsoRejected: 0 };
    });
    jest
      .mocked(window.api.contacts.checkCanDelete)
      .mockResolvedValue({ success: true, transactions: [] });

    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [SAVED_CONTACT_ID, CANDIDATE_ROW_ID, BYSTANDER_ROW_ID].sort(),
      ),
    );

    // The row NOT involved in the answer. It is in the list before and after,
    // so if the list survives the refresh this exact element does too.
    const rowBefore = document.querySelector(
      `[data-contact-id="${BYSTANDER_ROW_ID}"]`,
    );
    expect(rowBefore).not.toBeNull();

    await openTheQueue();
    await userEvent.click(screen.getByTestId(`review-confirm-${PROPOSAL_ID}`));
    await waitFor(() => expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(2));

    // ---- THE REFETCH IS NOW IN FLIGHT. This is the window that matters. ----
    expect(screen.queryByTestId("loading-state")).not.toBeInTheDocument();
    expect(document.querySelector(`[data-contact-id="${BYSTANDER_ROW_ID}"]`)).toBe(
      rowBefore,
    );

    await act(async () => {
      releaseRefetch();
      await refetchInFlight;
    });

    await waitFor(() =>
      expect(renderedContactIds()).toEqual([SAVED_CONTACT_ID, BYSTANDER_ROW_ID].sort()),
    );
    // Survived the whole way through. Not "a row is there" — a rebuilt list also
    // has a row there. The SAME NODE, so nothing was torn down.
    expect(document.querySelector(`[data-contact-id="${BYSTANDER_ROW_ID}"]`)).toBe(
      rowBefore,
    );
    expect(screen.queryByTestId("loading-state")).not.toBeInTheDocument();
  });

  /**
   * CONTROL 5 — A FAILED REFRESH LEAVES THE SCREEN CONSISTENT, NOT HALF-NEW.
   *
   * `refreshBothLists` commits NEITHER list unless BOTH fetches succeed. If it
   * committed the address-book result alone, the candidate row would vanish
   * while the saved half was still stale — the person in neither list, which is
   * worse than the defect being fixed here. The verdict is written either way,
   * so the next load repairs it.
   */
  it("commits nothing when one half of the refresh fails", async () => {
    installBackend({ availableAfterAnswer: [bystanderRecord] });
    let getAllCalls = 0;
    jest.mocked(window.api.contacts.getAll).mockImplementation(async () => {
      getAllCalls += 1;
      return getAllCalls === 1
        ? { success: true, contacts: [savedRosalind] }
        : { success: false, error: "database is locked" };
    });

    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    const before = [SAVED_CONTACT_ID, CANDIDATE_ROW_ID, BYSTANDER_ROW_ID].sort();
    await waitFor(() => expect(renderedContactIds()).toEqual(before));

    await openTheQueue();
    await userEvent.click(screen.getByTestId(`review-confirm-${PROPOSAL_ID}`));
    await waitFor(() => expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(2));

    // The address-book fetch succeeded and would have dropped the candidate.
    // It was not committed, because its partner failed.
    await waitFor(() =>
      expect(screen.getByTestId("review-duplicates-empty")).toBeInTheDocument(),
    );
    expect(renderedContactIds()).toEqual(before);
  });
});
