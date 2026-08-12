/**
 * BACKLOG-2471 PR F, REWRITTEN BY BACKLOG-2626 — what a click opens.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED, AND WHY THIS FILE STILL EXISTS
 * ---------------------------------------------------------------------------
 * PR F made the MULTI-COLUMN compare screen the default way in: clicking any
 * contact whose links were unratified opened it, "always, until confirmed".
 * BACKLOG-2626 took that away. The founder clicked a contact he had answered
 * two candidates for and got three columns of ALREADY-APPROVED records, while
 * the fourth, unanswered candidate — the actual reason it opened — was nowhere
 * on screen.
 *
 * So the rule is now: an unratified LINK is not a question, and only questions
 * intercept — onto the duplicates screen filtered to that contact.
 * `Contacts.filteredQuestions-2626` owns that surface; this file keeps the
 * guards PR F built, retargeted at the new rule:
 *
 * 1. `unratified links alone open the ORDINARY CARD` — the deleted interception,
 *    asserted as an absence that a revert turns red. Without it, restoring one
 *    line of PR F would ship silently.
 *
 * 2. `search survives open -> confirm -> return`, on BOTH viewport widths. This
 *    was R1, called "the sharpest risk in the plan": `searchQuery` used to live
 *    inside `ContactSearchList`, and on a narrow viewport the list unmounts
 *    behind the detail pane, so the box came back empty. BACKLOG-2509 lifted it.
 *    It now runs through the FILTERED REVIEW SCREEN, because that is the surface
 *    a click reaches.
 *
 * The badge is driven by the STAMPED `review_state`, so these fixtures carry it
 * exactly as `attachReviewState` would — see the transcription note on
 * `combined` below.
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

type Listener = (event: { matches: boolean }) => void;

function installMatchMedia(narrow: boolean) {
  const listeners = new Set<Listener>();
  (window as unknown as { matchMedia: unknown }).matchMedia = jest.fn().mockReturnValue({
    matches: narrow,
    media: "",
    addEventListener: (_e: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_e: string, cb: Listener) => listeners.delete(cb),
    addListener: (cb: Listener) => listeners.add(cb),
    removeListener: (cb: Listener) => listeners.delete(cb),
    onchange: null,
    dispatchEvent: () => true,
  });
}

const USER = "user-2471f";

/**
 * TRANSCRIBED, not invented. `review_state` is what `attachReviewState`
 * (`db/contactSourceSets.ts`) stamps onto the imported bucket, carrying BOTH
 * counts — `columns` for the compare screen and `records` for the row's own
 * sentence — plus the badge the row wears. `undefined` is the third state:
 * nothing linked, nothing outstanding, no badge.
 *
 * `openQuestions: 0` on both of these is the point of this file: they hold
 * LINKS, not questions, and after BACKLOG-2626 a link does not intercept a
 * click however unratified it is.
 */
const combined = {
  id: "c-paul",
  name: "Paul Dorian",
  display_name: "Paul Dorian",
  email: "paul@example.com",
  source: "contacts_app",
  review_state: {
    columns: 2,
    records: 2,
    needsReview: true,
    openQuestions: 0,
    badge: "autolinked",
  },
} as unknown as Contact;

const confirmed = {
  id: "c-ada",
  name: "Ada Lovelace",
  display_name: "Ada Lovelace",
  email: "ada@example.test",
  source: "contacts_app",
  review_state: {
    columns: 2,
    records: 2,
    needsReview: false,
    openQuestions: 0,
    badge: "user_linked",
  },
} as unknown as Contact;

/** No crosswalk rows at all — the ordinary case, and it must stay ordinary. */
const plain = {
  id: "c-grace",
  name: "Grace Hopper",
  display_name: "Grace Hopper",
  email: "grace@example.com",
  source: "manual",
} as unknown as Contact;

const compareView = {
  contactId: "c-paul",
  isConfirmed: false,
  title: "Is this the same Paul Dorian?",
  reason: "Both records list the phone number +1 (206) 555-0142, and the names match.",
  namesMatch: true,
  columns: [
    {
      linkId: "l-origin",
      kind: "contact",
      columnLabel: "Mac address book",
      displayName: "Paul Dorian",
      name: { value: "Paul Dorian", matched: true },
      emails: [],
      phones: [],
      company: null,
      transactions: [],
      recentCommunication: [],
      sourceRecordPresent: true,
    },
    {
      linkId: "l-outlook",
      kind: "source",
      columnLabel: "Outlook contacts",
      displayName: "Paul Dorian",
      name: { value: "Paul Dorian", matched: true },
      emails: [],
      phones: [],
      company: null,
      transactions: [],
      recentCommunication: [],
      sourceRecordPresent: true,
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(window.api.contacts.getAll).mockResolvedValue({
    success: true,
    contacts: [combined, confirmed, plain],
  });
  jest.mocked(window.api.contacts.checkCanDelete).mockResolvedValue({
    success: true,
    transactions: [],
  });
  const api = window.api.contacts as unknown as Record<string, jest.Mock>;
  api.getCompareColumns = jest.fn().mockResolvedValue({ success: true, view: compareView });
  api.confirmSources = jest
    .fn()
    .mockResolvedValue({ ok: true, confirmed: 2, alreadyConfirmed: 0, proposalsResolved: 0 });
  api.getSources = jest.fn().mockResolvedValue({ success: true, sources: [] });
});

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

async function renderList(narrow = false) {
  installMatchMedia(narrow);
  render(<Contacts userId={USER} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText("Paul Dorian")).toBeInTheDocument());
}

describe("what a click opens", () => {
  /**
   * THE DELETED INTERCEPTION, ASSERTED AS AN ABSENCE.
   *
   * Paul holds an unratified auto-link and NO open question. Under PR F that was
   * the interception's headline case; under BACKLOG-2626 it must open his card.
   *
   * OBSERVED RED: restore the single deleted line —
   * `if (contact.review_state?.needsReview) setCompareOpen(true);` — in
   * `handleContactClick` and this goes red, while `Ada` and `Grace` below stay
   * green. That asymmetry is what makes this a real control rather than a test
   * that would pass with the predicate inverted.
   */
  it("opens the ORDINARY CARD for unratified links with no question open", async () => {
    await renderList();

    await userEvent.click(screen.getByText("Paul Dorian"));

    await waitFor(() =>
      expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("contact-compare-screen")).not.toBeInTheDocument();
  });

  it("opens the ORDINARY CARD once the contact is confirmed", async () => {
    await renderList();

    await userEvent.click(screen.getByText("Ada Lovelace"));

    await waitFor(() =>
      expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("contact-compare-screen")).not.toBeInTheDocument();
  });

  it("never intercepts a contact with nothing to compare", async () => {
    await renderList();

    await userEvent.click(screen.getByText("Grace Hopper"));

    // `review_state` undefined must read as "no interception", never as a
    // reason to open a screen that would have nothing in it.
    await waitFor(() =>
      expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("contact-compare-screen")).not.toBeInTheDocument();
  });

  it("`Compare sources` still reaches the screen after confirming", async () => {
    jest.mocked(window.api.contacts.getSources).mockResolvedValue({
      success: true,
      sources: [
        {
          linkId: "l-outlook",
          sourceType: "outlook",
          sourceLabel: "Outlook contacts",
          matchMethod: "email",
          matchDescription: "Matched by an email address you already had for this person",
          sourceName: "Ada Lovelace",
          sourceRecordPresent: true,
          matchedAt: null,
          lastSyncedAt: null,
        },
      ],
    } as never);

    await renderList();
    await userEvent.click(screen.getByText("Ada Lovelace"));
    await waitFor(() =>
      expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument(),
    );

    // The button is gated on HAVING RECORDS TO COMPARE, not on confirmation, so
    // confirming must not take it away. CONTROL: gate it on the review flag.
    await userEvent.click(screen.getByTestId("contact-compare-open"));
    await waitFor(() =>
      expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument(),
    );
  });
});

describe("the search box survives the round trip", () => {
  /**
   * R1, end to end: type -> click a row with a question -> answer it -> back on
   * the list, with the text still in the box.
   *
   * Routed through the WALK rather than through the old interception, because
   * the walk is what a click now reaches. The risk it guards is unchanged and
   * belongs to the LIST, not to whichever screen covers it.
   *
   * CONTROL: unmount the list behind the detail pane (revert BACKLOG-2509's
   * lift) and the NARROW case goes red while the wide one stays green — which
   * is exactly how the defect behaved before it was fixed.
   */
  const PAUL_QUESTION = {
    proposalId: "p-paul-search",
    contactId: "c-paul",
    contactName: "Paul Dorian",
    contactCompany: null,
    sourceType: "outlook",
    sourceRecordId: "out-paul",
    sourceLabel: "Outlook contacts",
    sourceName: "Paul Dorian",
    recordEmails: ["paul@example.com"],
    recordPhones: [],
    reason: "ambiguous_identifier",
    matchedOn: "email",
    identity: "possibly_same_person",
    identityPhrase: "possibly the same person",
    relationship: "possibly_connected",
    relationshipPhrase: "possibly connected",
    evidence: { summary: "Shared email address.", details: [] },
  };

  beforeEach(() => {
    // Stateful, because the round trip depends on the question LEAVING the queue
    // — that is what closes the review screen and puts the card back.
    let answered = false;
    const api = window.api.contacts as unknown as Record<string, jest.Mock>;
    api.getReviewQueue = jest.fn().mockImplementation(async () => ({
      success: true,
      clusters: answered
        ? []
        : [
            {
              clusterKey: "contact:c-paul",
              question: "Is this the same Paul Dorian?",
              exclusive: false,
              items: [PAUL_QUESTION],
            },
          ],
    }));
    api.confirmLink = jest.fn().mockImplementation(async () => {
      answered = true;
      return { success: true, linked: true };
    });
  });

  it.each([
    ["wide", false],
    ["narrow", true],
  ])("%s viewport", async (_name, narrow) => {
    await renderList(narrow as boolean);

    await userEvent.type(screen.getByTestId("contact-search-input"), "Paul");
    expect(screen.getByTestId("contact-search-input")).toHaveValue("Paul");

    await userEvent.click(screen.getByText("Paul Dorian"));
    await waitFor(() =>
      expect(screen.getByTestId("review-duplicates-modal")).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByTestId(`review-confirm-${PAUL_QUESTION.proposalId}`));

    await waitFor(() =>
      expect(screen.queryByTestId("review-duplicates-modal")).not.toBeInTheDocument(),
    );
    // On narrow the list is unmounted behind the detail card, so getting the
    // value back at all is the assertion.
    if (narrow) {
      await userEvent.click(screen.getByTestId("contacts-detail-back"));
    }
    await waitFor(() =>
      expect(screen.getByTestId("contact-search-input")).toHaveValue("Paul"),
    );
  });
});

describe("the row badges and the Autolinked filter (BACKLOG-2626)", () => {
  it("names each state with the founder's own word", async () => {
    await renderList();

    // Paul holds an unratified auto-link; Ada's are all her own doing. Asserted
    // as name -> badge PAIRS, not as a bag of words: a bag would stay green if
    // the two badges swapped rows, which is the failure that would tell the
    // founder the app had decided something he did.
    const pairs = screen.getAllByTestId("contact-row").map((row) => [
      within(row).getByTestId("contact-row-name").textContent,
      within(row).queryByRole("status")?.textContent ?? null,
    ]);
    expect(pairs).toEqual(
      expect.arrayContaining([
        ["Paul Dorian", "Autolinked"],
        ["Ada Lovelace", "You linked these"],
        ["Grace Hopper", null],
      ]),
    );
    expect(pairs).toHaveLength(3);
  });

  it("puts no badge on a contact with nothing linked and nothing open", async () => {
    await renderList();

    // Three rows, two badges — `review_state: undefined` earns none of the
    // three. The regression guard against decorating every row.
    expect(screen.getAllByTestId("contact-row").length).toBe(3);
    expect(screen.getAllByTestId("contact-row-badge").length).toBe(2);
  });

  it("the Autolinked option reveals exactly the rows wearing that badge", async () => {
    await renderList();

    const option = screen.getByTestId("filter-autolinked");
    // `11abce67`: the word, and no count. A number turns a lens into a backlog.
    expect(option.textContent).toBe("Autolinked");

    await userEvent.click(option);

    await waitFor(() =>
      expect(screen.getAllByTestId("contact-row-name").map((n) => n.textContent)).toEqual([
        "Paul Dorian",
      ]),
    );
  });

  it("is a filter, not a mode — pressing it again restores the list", async () => {
    await renderList();

    await userEvent.click(screen.getByTestId("filter-autolinked"));
    await waitFor(() => expect(screen.getAllByTestId("contact-row").length).toBe(1));

    await userEvent.click(screen.getByTestId("filter-autolinked"));
    await waitFor(() => expect(screen.getAllByTestId("contact-row").length).toBe(3));
  });

  it("hides the option when the app has linked nothing on its own", async () => {
    jest.mocked(window.api.contacts.getAll).mockResolvedValue({
      success: true,
      contacts: [confirmed, plain],
    });
    installMatchMedia(false);
    render(<Contacts userId={USER} onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText("Ada Lovelace")).toBeInTheDocument());

    // A filter that can only ever return an empty list is a dead control — the
    // same rule the header's review button already follows. Note the
    // user-linked contact is on screen, so this is not passing because the list
    // is empty.
    expect(screen.queryByTestId("filter-autolinked")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("You linked these");
  });
});

// ===========================================================================
// BACKLOG-2502 — `Confirm & edit` LANDS IN THE SAME PLACE FROM BOTH WAYS IN
// ===========================================================================

/**
 * FOUNDER RULING, 2026-08-09. The compare screen is reached two ways, and the
 * two entry paths deliberately differ on `Confirm` — from the duplicates queue
 * it returns to the queue, from the contact list it returns to the card. They
 * must NOT differ on `Confirm & edit`: *"open the contact card, exactly as
 * confirm-and-edit does when a contact is opened from the main list. Same
 * destination, same behaviour — not a variant."*
 *
 * So the destination is compared rather than described. Both paths are walked in
 * ONE test and their end states are asserted EQUAL, which is what makes a future
 * fork fail here instead of shipping: `Contacts.tsx` hands both routes the same
 * `openContactCardForEdit`, and a second implementation added to either side
 * would have to reproduce every field below to stay green.
 */
describe("Confirm & edit, from both entry paths", () => {
  const REVIEW_ITEM = {
    proposalId: "p-paul",
    contactId: "c-paul",
    contactName: "Paul Dorian",
    contactCompany: null,
    sourceType: "outlook",
    sourceRecordId: "out-paul",
    sourceLabel: "Outlook contacts",
    sourceName: "Paul Dorian",
    recordEmails: ["paul@example.com"],
    recordPhones: [],
    reason: "ambiguous_identifier",
    matchedOn: "email",
    identity: "possibly_same_person",
    identityPhrase: "possibly the same person",
    relationship: "possibly_connected",
    relationshipPhrase: "possibly connected",
    evidence: { summary: "Shared email address.", details: [] },
  };

  beforeEach(() => {
    const api = window.api.contacts as unknown as Record<string, jest.Mock>;
    api.confirmLink = jest.fn().mockResolvedValue({ success: true, linked: true });
    api.getReviewQueueCount = jest.fn().mockResolvedValue({ success: true, count: 1 });
    // `Compare sources` is gated on the card HAVING records to compare
    // (`showSourcesPanel`), so PATH A needs a source list that clears it.
    api.getSources = jest.fn().mockResolvedValue({
      success: true,
      sources: [
        {
          linkId: "l-outlook",
          sourceType: "outlook",
          sourceLabel: "Outlook contacts",
          matchMethod: "email",
          matchDescription: "Matched by an email address you already had for this person",
          sourceName: "Paul Dorian",
          sourceRecordPresent: true,
          matchedAt: null,
          lastSyncedAt: null,
        },
      ],
    });
    api.getReviewQueue = jest.fn().mockResolvedValue({
      success: true,
      clusters: [
        {
          clusterKey: "contact:c-paul",
          question: "Is this the same Paul Dorian?",
          exclusive: false,
          items: [REVIEW_ITEM],
        },
      ],
    });
  });

  /**
   * WHERE THE USER ENDED UP, as facts on the screen rather than as a spy on a
   * handler. A spy would pass while the two routes called the same function with
   * different arguments, or wired it to a different pane.
   */
  const destination = () => ({
    editFormOpen: screen.queryAllByText("Edit Contact").length > 0,
    editingWho: (screen.queryByPlaceholderText("John Doe") as HTMLInputElement | null)?.value,
    cardStillMountedUnderIt: screen.queryByTestId("contact-preview-modal") !== null,
    // BOTH LAYERS OF THE STACK, POPPED. `Confirm & edit` is the one action that
    // takes the whole stack down — unlike `×`, which pops exactly one, and
    // `Confirm`, which pops compare and leaves the list up. On the main-list
    // path there is only ever one layer and `queueClosed` is vacuously true,
    // which is why it is COMPARED against that path rather than asserted alone.
    compareScreenClosed: screen.queryByTestId("contact-compare-screen") === null,
    queueClosed: screen.queryByTestId("review-duplicates-modal") === null,
  });

  it("lands on the same screen, in the same state, from the card and from the queue", async () => {
    /*
      ---- PATH A: the CONTACT CARD's own `Compare sources` button.

      This used to be "the main contacts list", reached by the interception that
      BACKLOG-2626 deleted. The founder's ruling is about the two ways the
      compare screen is REACHED, and after 2626 those are `Compare sources` and
      the queue's eye — so the comparison moves with them rather than being
      dropped. Both must still land in the same place.

      The card is reached by closing the filtered review screen the click opens,
      which is a real user path and not a shortcut around one.
    */
    const listPath = render(<Contacts userId={USER} onClose={jest.fn()} />);
    installMatchMedia(false);
    await waitFor(() => expect(screen.getByText("Paul Dorian")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Paul Dorian"));
    await waitFor(() =>
      expect(screen.getByTestId("review-duplicates-modal")).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByTestId("review-duplicates-close"));
    await waitFor(() =>
      expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument(),
    );
    await userEvent.click(await screen.findByTestId("contact-compare-open"));
    await waitFor(() => expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("compare-confirm-edit"));
    await waitFor(() => expect(screen.queryAllByText("Edit Contact").length).toBeGreaterThan(0));
    const fromTheList = destination();
    listPath.unmount();

    // ---- PATH B: the duplicates queue, via the compare screen inside it.
    render(<Contacts userId={USER} onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText("Paul Dorian")).toBeInTheDocument());
    await userEvent.click(await screen.findByTestId("review-duplicates-button"));
    // The candidate's own eye — R7 removed `Compare` from the queue card's
    // contact row, where it had to pick one of the contact's candidates.
    await userEvent.click(await screen.findByTestId("review-view-p-paul"));
    await waitFor(() => expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("compare-confirm-edit"));
    await waitFor(() => expect(screen.queryAllByText("Edit Contact").length).toBeGreaterThan(0));
    const fromTheQueue = destination();

    // The answer went through the PROPOSAL channel on the queue route — it is a
    // different write from the card route's `confirmSources`, and only the
    // destination is shared.
    expect(window.api.contacts.confirmLink).toHaveBeenCalledWith(USER, "p-paul");

    // THE ASSERTION THIS BLOCK EXISTS FOR.
    // CONTROL: give the queue route its own destination — for instance drop
    // `showPreviewContact` from `openContactCardForEdit`, or have `Contacts.tsx`
    // handle `onConfirmedAndEdit` by only closing the modal — and these diverge.
    // `queueClosed` is vacuously true on the card path, which is exactly why it
    // is COMPARED against the queue path rather than asserted on its own.
    expect(fromTheQueue).toEqual(fromTheList);
    expect(fromTheList).toEqual({
      editFormOpen: true,
      editingWho: "Paul Dorian",
      cardStillMountedUnderIt: true,
      compareScreenClosed: true,
      queueClosed: true,
    });
  });
});
