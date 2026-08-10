/**
 * BACKLOG-2471 PR F — the compare screen is the default way in.
 *
 * ---------------------------------------------------------------------------
 * THE TWO THAT MATTER
 * ---------------------------------------------------------------------------
 * 1. `a confirmed contact opens the ordinary card`. "Stops intercepting once
 *    confirmed" is the whole point of the PR, and its failure is INVISIBLE
 *    until a user confirms something and it opens again anyway. A test that
 *    only proved interception would pass with the predicate inverted.
 *
 * 2. `search survives open -> confirm -> return`, on BOTH viewport widths. This
 *    was R1, called "the sharpest risk in the plan": `searchQuery` used to live
 *    inside `ContactSearchList`, and on a narrow viewport the list unmounts
 *    behind the detail pane, so the box came back empty. BACKLOG-2509 lifted it;
 *    this is where the product starts promising it, so it is proved end to end
 *    through the REAL lifted state rather than by asserting a prop.
 *
 * The interception is driven by the STAMPED `review_state`, so these fixtures
 * carry it exactly as `attachReviewState` would — see the transcription note on
 * `combined` below.
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
 * (`db/contactSourceSets.ts`) stamps onto the imported bucket: present ONLY for
 * contacts the compare screen opens for, carrying the COLUMN count rather than
 * the link count. `undefined` is the third state — nothing to compare.
 */
const combined = {
  id: "c-paul",
  name: "Paul Dorian",
  display_name: "Paul Dorian",
  email: "paul@example.com",
  source: "contacts_app",
  review_state: { columns: 2, needsReview: true },
} as unknown as Contact;

const confirmed = {
  id: "c-ada",
  name: "Ada Lovelace",
  display_name: "Ada Lovelace",
  email: "ada@example.test",
  source: "contacts_app",
  review_state: { columns: 2, needsReview: false },
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

describe("the interception", () => {
  it("opens the compare screen for a contact that still needs review", async () => {
    await renderList();

    await userEvent.click(screen.getByText("Paul Dorian"));

    // CONTROL: invert the `review_state?.needsReview` check and this goes red.
    await waitFor(() =>
      expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("contact-preview-modal")).not.toBeInTheDocument();
  });

  it("opens the ORDINARY CARD once the contact is confirmed", async () => {
    await renderList();

    await userEvent.click(screen.getByText("Ada Lovelace"));

    // THE ONE THAT MATTERS. CONTROL: drop the `needsReview` half of the check
    // and this goes red while the test above stays green — that asymmetry is
    // what makes both of them real. Without it, a predicate that intercepted
    // EVERY combined contact would pass the suite and the founder would confirm
    // a contact only to have it open the same screen again.
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
   * R1, end to end: type -> click a flagged row (intercepted) -> Confirm ->
   * back on the list, with the text still in the box.
   *
   * CONTROL: unmount the list behind the detail pane (revert BACKLOG-2509's
   * lift) and the NARROW case goes red while the wide one stays green — which
   * is exactly how the defect behaved before it was fixed.
   */
  it.each([
    ["wide", false],
    ["narrow", true],
  ])("%s viewport", async (_name, narrow) => {
    await renderList(narrow as boolean);

    await userEvent.type(screen.getByTestId("contact-search-input"), "Paul");
    expect(screen.getByTestId("contact-search-input")).toHaveValue("Paul");

    await userEvent.click(screen.getByText("Paul Dorian"));
    await waitFor(() =>
      expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByTestId("compare-confirm"));

    await waitFor(() =>
      expect(screen.queryByTestId("contact-compare-screen")).not.toBeInTheDocument(),
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

describe("the list's flags and the Needs review chip", () => {
  it("flags a combined contact with the COLUMN count, and marks a decided one Confirmed", async () => {
    await renderList();

    // CONTROL: render the link count instead of `review_state.columns` and this
    // reads "3 records combined" while the screen opens two columns.
    expect(screen.getByTestId("contact-row-review-flag").textContent).toBe(
      "2 records combined",
    );
    expect(screen.getByTestId("contact-row-confirmed-flag").textContent).toBe("Confirmed");
  });

  it("puts no flag on a contact with nothing to compare", async () => {
    await renderList();

    // Three rows, two flags — `review_state: undefined` earns neither badge.
    expect(screen.getAllByTestId("contact-row").length).toBe(3);
    expect(screen.getAllByTestId(/contact-row-(review|confirmed)-flag/).length).toBe(2);
  });

  it("the chip's count equals the rows it reveals", async () => {
    await renderList();

    const chip = screen.getByTestId("needs-review-chip");
    // One contact needs review, and pressing the chip must show exactly it.
    // CONTROL: count from a second source (a prop, another query) and the two
    // can differ — "Review 12" opening onto 9.
    expect(chip.textContent).toBe("Needs review · 1");

    await userEvent.click(chip);

    await waitFor(() =>
      expect(screen.getAllByTestId("contact-row-name").map((n) => n.textContent)).toEqual([
        "Paul Dorian",
      ]),
    );
  });

  it("is a filter, not a mode — pressing it again restores the list", async () => {
    await renderList();

    await userEvent.click(screen.getByTestId("needs-review-chip"));
    await waitFor(() => expect(screen.getAllByTestId("contact-row").length).toBe(1));

    await userEvent.click(screen.getByTestId("needs-review-chip"));
    await waitFor(() => expect(screen.getAllByTestId("contact-row").length).toBe(3));
  });

  it("hides the chip when nothing needs review", async () => {
    jest.mocked(window.api.contacts.getAll).mockResolvedValue({
      success: true,
      contacts: [confirmed, plain],
    });
    installMatchMedia(false);
    render(<Contacts userId={USER} onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText("Ada Lovelace")).toBeInTheDocument());

    // A filter that can only ever return an empty list is a dead control — the
    // same rule the header's review button already follows. Note the CONFIRMED
    // contact is on screen, so this is not passing because the list is empty.
    expect(screen.queryByTestId("needs-review-chip")).not.toBeInTheDocument();
    expect(screen.getByTestId("contact-row-confirmed-flag")).toBeInTheDocument();
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

  it("lands on the same screen, in the same state, from the list and from the queue", async () => {
    // ---- PATH A: the main contacts list. UNCHANGED BEHAVIOUR, and the guard.
    const listPath = render(<Contacts userId={USER} onClose={jest.fn()} />);
    installMatchMedia(false);
    await waitFor(() => expect(screen.getByText("Paul Dorian")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Paul Dorian"));
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
    // different write from the list route's `confirmSources`, and only the
    // destination is shared.
    expect(window.api.contacts.confirmLink).toHaveBeenCalledWith(USER, "p-paul");

    // THE ASSERTION THIS BLOCK EXISTS FOR.
    // CONTROL: give the queue route its own destination — for instance drop
    // `showPreviewContact` from `openContactCardForEdit`, or have `Contacts.tsx`
    // handle `onConfirmedAndEdit` by only closing the modal — and these diverge.
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
