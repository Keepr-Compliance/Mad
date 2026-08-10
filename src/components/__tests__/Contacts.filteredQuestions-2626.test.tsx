/**
 * BACKLOG-2626 — CLICKING A CONTACT OPENS THE DUPLICATES SCREEN, FILTERED TO HER.
 *
 * ===========================================================================
 * THE DEFECT, IN THE FOUNDER'S WORDS
 * ===========================================================================
 *   > *"I approved it and when I go to open the contact it shows me the compare
 *   > screen as if it wasn't approved."*
 *
 * He had answered two candidates. Clicking the contact opened the multi-column
 * compare screen showing THREE COLUMNS OF RECORDS HE HAD ALREADY APPROVED, while
 * the actual reason it opened — a fourth unanswered candidate — was nowhere on
 * screen. Two faults at once: settled decisions re-presented as unsettled, and
 * the outstanding one hidden.
 *
 * **Opening is fine. Opening onto the wrong content is the defect.**
 *
 * ===========================================================================
 * WHAT IT OPENS ONTO, AND WHAT IT DELIBERATELY DOES NOT
 * ===========================================================================
 * *"We should reuse the Possible duplicates [screen] and only filter for that
 * contact."* — founder, 2026-08-10, twice.
 *
 * So: the shipped duplicates surface with `filterContactId` set. The tucked
 * review card, her outstanding candidates STACKED beneath it, each answered
 * independently and in place, each keeping its own eye into the pairwise
 * compare. NOT a chain of compare modals — that was the wrong reading of *"shows
 * all compares one after another"*, and it would have been a second review
 * surface to keep in step with this one.
 *
 * The assertions below therefore name the RENDERED SURFACE — `review-tuck-*`,
 * the card that only this screen draws — and not merely "a compare screen
 * appeared". A modal chain would have satisfied the latter.
 *
 * ===========================================================================
 * WHY THE MOCK IS STATEFUL, AND WHY THAT IS NOT AN INVENTION
 * ===========================================================================
 * `getReviewQueue` is backed by a mutable `pending` array that `confirmLink` and
 * `rejectLink` remove from. That is what `contactLinkReview.ts` does in SQL:
 * `resolveProposal` flips `status` off `'pending'`, and `PENDING_JOIN` selects
 * `WHERE p.status = 'pending'`, so an answered proposal leaves the queue and
 * every later read is short by it.
 *
 * A FIXED array would have made the mandatory control vacuous: the screen would
 * re-derive the same three questions forever, and "never re-shows the answered
 * one" could not be distinguished from "shows them all again". The check's
 * inputs must be able to separate pass from fail, and a frozen queue cannot.
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

function installMatchMedia() {
  (window as unknown as { matchMedia: unknown }).matchMedia = jest.fn().mockReturnValue({
    matches: false,
    media: "",
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    onchange: null,
    dispatchEvent: () => true,
  });
}

const USER = "user-2626";

/**
 * Rosalind Vance — the founder's own case, from the 2026-08-09 clean-database
 * import that filed four questions against her while her row looked ordinary.
 *
 * `review_state` is transcribed from what `getReviewStateByContact` now emits
 * for a contact with pending proposals: the badge is `suggestion` because an
 * open question outranks everything else, and `openQuestions` is the count
 * behind it.
 */
const ROSALIND = {
  id: "c-ros",
  name: "Rosalind Vance",
  display_name: "Rosalind Vance",
  email: "rosalind@example.com",
  source: "contacts_app",
  review_state: {
    columns: 2,
    records: 2,
    needsReview: false,
    openQuestions: 3,
    badge: "suggestion",
  },
} as unknown as Contact;

/** No links, no questions, no badge — the ordinary case. */
const SETTLED = {
  id: "c-tomas",
  name: "Tomas Iyer",
  display_name: "Tomas Iyer",
  email: "tomas@example.com",
  source: "manual",
} as unknown as Contact;

/**
 * A SECOND contact with her own open question.
 *
 * The filter's whole job is to leave her out, and a fixture with only one
 * question-bearing contact cannot tell a working filter from no filter at all.
 */
const OTHER = {
  id: "c-mira",
  name: "Mira Halloran",
  display_name: "Mira Halloran",
  email: "mira@example.com",
  source: "contacts_app",
  review_state: {
    columns: 1,
    records: 1,
    needsReview: false,
    openQuestions: 1,
    badge: "suggestion",
  },
} as unknown as Contact;

interface Question {
  proposalId: string;
  sourceRecordId: string;
  contactId: string;
  contactName: string;
}

const ROS_QUESTIONS: Question[] = [
  { proposalId: "p-alpha", sourceRecordId: "rec-alpha", contactId: "c-ros", contactName: "Rosalind Vance" },
  { proposalId: "p-bravo", sourceRecordId: "rec-bravo", contactId: "c-ros", contactName: "Rosalind Vance" },
  { proposalId: "p-charlie", sourceRecordId: "rec-charlie", contactId: "c-ros", contactName: "Rosalind Vance" },
];

const MIRA_QUESTION: Question = {
  proposalId: "p-delta",
  sourceRecordId: "rec-delta",
  contactId: "c-mira",
  contactName: "Mira Halloran",
};

/** The queue's live contents. Answers remove from it, as `status` does in SQL. */
let pending: Question[] = [];

function queueItem(q: Question) {
  return {
    proposalId: q.proposalId,
    contactId: q.contactId,
    contactName: q.contactName,
    contactCompany: null,
    sourceType: "outlook",
    sourceRecordId: q.sourceRecordId,
    sourceLabel: "Outlook contacts",
    sourceName: q.contactName,
    recordEmails: ["rosalind@example.com"],
    recordPhones: ["+1 (206) 555-0148"],
    reason: "ambiguous_identifier",
    matchedOn: "email",
    identity: "possibly_same_person",
    identityPhrase: "possibly the same person",
    relationship: "possibly_connected",
    relationshipPhrase: "possibly connected",
    evidence: { summary: "Shared email address.", details: [] },
  };
}

/** One cluster per contact, which is the shape `getReviewQueue` emits. */
function clusters() {
  const byContact = new Map<string, Question[]>();
  for (const q of pending) {
    byContact.set(q.contactId, [...(byContact.get(q.contactId) ?? []), q]);
  }
  return [...byContact.entries()].map(([contactId, items]) => ({
    clusterKey: `contact:${contactId}`,
    question: `Are these also ${items[0].contactName}?`,
    exclusive: false,
    items: items.map(queueItem),
  }));
}

/** The pairwise view the EYE opens, for one candidate. */
function viewFor(sourceRecordId: string) {
  return {
    contactId: ROSALIND.id,
    isConfirmed: false,
    title: "Is this the same Rosalind Vance?",
    reason: "Both records list the email address rosalind@example.com.",
    namesMatch: true,
    columns: [
      {
        linkId: "contact-side",
        kind: "contact",
        columnLabel: "Rosalind Vance",
        displayName: "Rosalind Vance",
        name: { value: "Rosalind Vance", matched: true },
        emails: [],
        phones: [],
        company: null,
        transactions: [],
        recentCommunication: [],
        sourceRecordPresent: true,
      },
      {
        linkId: `q:${sourceRecordId}`,
        kind: "proposed",
        columnLabel: "Outlook contacts",
        displayName: "Rosalind Vance",
        name: { value: "Rosalind Vance", matched: true },
        emails: [],
        phones: [],
        company: null,
        transactions: [],
        recentCommunication: [],
        sourceRecordPresent: true,
      },
    ],
  };
}

/** Every linked record side by side, SETTLED ONES INCLUDED. */
const COMPARE_SOURCES_VIEW = {
  contactId: ROSALIND.id,
  isConfirmed: false,
  title: "Is this the same Rosalind Vance?",
  reason: "Both records list the email address rosalind@example.com.",
  namesMatch: true,
  columns: [
    {
      linkId: "l-origin",
      kind: "contact",
      columnLabel: "Mac address book",
      displayName: "Rosalind Vance",
      name: { value: "Rosalind Vance", matched: true },
      emails: [],
      phones: [],
      company: null,
      transactions: [],
      recentCommunication: [],
      sourceRecordPresent: true,
    },
    {
      linkId: "l-settled-one",
      kind: "source",
      columnLabel: "Outlook contacts",
      displayName: "Rosalind Vance",
      name: { value: "Rosalind Vance", matched: true },
      emails: [],
      phones: [],
      company: null,
      transactions: [],
      recentCommunication: [],
      sourceRecordPresent: true,
    },
    {
      linkId: "l-settled-two",
      kind: "source",
      columnLabel: "iPhone contacts",
      displayName: "Rosalind Vance",
      name: { value: "Rosalind Vance", matched: true },
      emails: [],
      phones: [],
      company: null,
      transactions: [],
      recentCommunication: [],
      sourceRecordPresent: true,
    },
  ],
};

function api() {
  return window.api.contacts as unknown as Record<string, jest.Mock>;
}

beforeEach(() => {
  jest.clearAllMocks();
  pending = [...ROS_QUESTIONS, MIRA_QUESTION];

  jest.mocked(window.api.contacts.getAll).mockResolvedValue({
    success: true,
    contacts: [ROSALIND, SETTLED, OTHER],
  });
  jest.mocked(window.api.contacts.checkCanDelete).mockResolvedValue({
    success: true,
    transactions: [],
  });
  /*
    REQUIRED, not incidental. `refreshBothLists` commits BOTH halves or neither
    (BACKLOG-2526), so an unmocked external read returns `null`, the commit is
    skipped, and the list keeps its pre-answer rows.
  */
  jest.mocked(window.api.contacts.getAvailable).mockResolvedValue({
    success: true,
    contacts: [],
  });

  const a = api();
  a.getReviewQueue = jest
    .fn()
    .mockImplementation(() => Promise.resolve({ success: true, clusters: clusters() }));
  a.getReviewQueueCount = jest
    .fn()
    .mockImplementation(() => Promise.resolve({ success: true, count: pending.length }));

  a.getCompareColumns = jest
    .fn()
    .mockImplementation(
      (_user: string, _contactId: string, proposed?: { sourceRecordId: string }) =>
        Promise.resolve({
          success: true,
          view: proposed ? viewFor(proposed.sourceRecordId) : COMPARE_SOURCES_VIEW,
        }),
    );

  a.confirmLink = jest.fn().mockImplementation((_u: string, proposalId: string) => {
    pending = pending.filter((q) => q.proposalId !== proposalId);
    return Promise.resolve({ success: true, linked: true });
  });
  a.rejectLink = jest.fn().mockImplementation((_u: string, proposalId: string) => {
    pending = pending.filter((q) => q.proposalId !== proposalId);
    return Promise.resolve({ success: true });
  });
  a.confirmSources = jest
    .fn()
    .mockResolvedValue({ ok: true, confirmed: 2, alreadyConfirmed: 0, proposalsResolved: 0 });
  a.getSources = jest.fn().mockResolvedValue({
    success: true,
    sources: [
      {
        linkId: "l-settled-one",
        sourceType: "outlook",
        sourceLabel: "Outlook contacts",
        matchMethod: "email",
        matchDescription: "Matched by an email address you already had for this person",
        sourceName: "Rosalind Vance",
        sourceRecordPresent: true,
        matchedAt: null,
        lastSyncedAt: null,
      },
      {
        linkId: "l-settled-two",
        sourceType: "icloud",
        sourceLabel: "iPhone contacts",
        matchMethod: "manual",
        matchDescription: "You linked this record yourself",
        sourceName: "Rosalind Vance",
        sourceRecordPresent: true,
        matchedAt: null,
        lastSyncedAt: null,
      },
    ],
  });
});

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

async function renderList() {
  installMatchMedia();
  render(<Contacts userId={USER} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText("Rosalind Vance")).toBeInTheDocument());
  // The click reads the queue, so nothing may be clicked until it has arrived —
  // otherwise the first click races the fetch and the test measures the race.
  await waitFor(() => expect(api().getReviewQueue).toHaveBeenCalled());
}

/**
 * Click a contact's ROW, not merely her name.
 *
 * Once her card is open the name is on screen twice — in the list and on the
 * card — and `getByText` would throw on a second visit. Scoping to the row also
 * keeps this clicking the thing a user clicks.
 */
async function openContact(name: string) {
  const row = screen.getAllByTestId("contact-row").find((r) => within(r).queryByText(name));
  await userEvent.click(within(row!).getByTestId("contact-row-name"));
}

/** The candidates currently listed on the review screen, by proposal id. */
function candidatesOnScreen(): string[] {
  const modal = screen.queryByTestId("review-duplicates-modal");
  if (!modal) return [];
  return within(modal)
    .queryAllByTestId(/^review-item-/)
    .map((el) => el.getAttribute("data-testid")!.replace("review-item-", ""));
}

describe("clicking a contact with open questions", () => {
  /**
   * CONTROL 1 — the FILTERED DUPLICATES CARD, listing exactly her outstanding
   * candidates, stacked.
   *
   * The surface is asserted by `review-tuck-c-ros`, the tucked amber card only
   * this screen draws, so a chain of compare modals could not satisfy it. Mira's
   * question is in the same queue and must not appear: without her, a filter
   * that did nothing would pass.
   *
   * OBSERVED RED, the surface: revert `handleContactClick` to
   * `setCompareOpen(true)` and no review screen opens at all.
   * OBSERVED RED, the filter: drop the `filterContactId` guard from the groups
   * memo and `p-delta` joins the list.
   */
  it("opens the duplicates card filtered to her, with every outstanding candidate", async () => {
    await renderList();
    await openContact("Rosalind Vance");

    await waitFor(() =>
      expect(screen.getByTestId("review-duplicates-modal")).toBeInTheDocument(),
    );
    // The tucked card — the surface, not merely "something opened".
    expect(screen.getByTestId("review-tuck-c-ros")).toBeInTheDocument();
    expect(screen.queryByTestId("review-contact-c-mira")).not.toBeInTheDocument();

    expect(candidatesOnScreen()).toEqual(["p-alpha", "p-bravo", "p-charlie"]);
    // Each answerable IN PLACE, independently: its own controls, on its own row.
    for (const id of ["p-alpha", "p-bravo", "p-charlie"]) {
      expect(screen.getByTestId(`review-confirm-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`review-reject-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`review-view-${id}`)).toBeInTheDocument();
    }
  });

  /**
   * THE MANDATORY CONTROL. His exact complaint.
   *
   * Answer one, leave, come back: the screen lists what is OUTSTANDING and never
   * re-shows the answered question. Exiting is explicitly NOT "dealt with" — he
   * chose *"compare again — you didn't answer"* — so the two unanswered ones are
   * still asked.
   *
   * OBSERVED RED: remove the `await load()` that follows a successful answer in
   * `ReviewDuplicatesModal.answer()` — the reload its own docblock says must not
   * become a local splice — and `p-alpha` is still listed after being confirmed.
   * The failure reads `Received +1: "p-alpha"`, which is the founder's screen
   * printed by a test runner.
   *
   * Stated precisely, because it is not where I first looked: what guarantees
   * this property is that the review screen RE-READS the queue — after every
   * answer, and again on every mount. `refreshOpenQuestions()` on close governs
   * something narrower and still necessary, namely whether the NEXT click
   * intercepts at all; removing it leaves this test green because the screen
   * still corrects itself once open. Both are asserted; only one of them is
   * asserted here.
   */
  it("re-opens on the OUTSTANDING questions and never re-shows an answered one", async () => {
    await renderList();
    await openContact("Rosalind Vance");
    await waitFor(() => expect(candidatesOnScreen()).toHaveLength(3));

    await userEvent.click(screen.getByTestId("review-confirm-p-alpha"));
    await waitFor(() => expect(candidatesOnScreen()).toEqual(["p-bravo", "p-charlie"]));

    // Leave part-way. `×` pops this layer and decides nothing.
    await userEvent.click(screen.getByTestId("review-duplicates-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("review-duplicates-modal")).not.toBeInTheDocument(),
    );

    // Come back. The list never unmounted on a wide viewport, so this is the
    // second click on the same row — exactly what the founder did.
    await openContact("Rosalind Vance");

    await waitFor(() =>
      expect(screen.getByTestId("review-duplicates-modal")).toBeInTheDocument(),
    );
    // THE ASSERTION THIS TEST EXISTS FOR.
    expect(candidatesOnScreen()).toEqual(["p-bravo", "p-charlie"]);
    expect(candidatesOnScreen()).not.toContain("p-alpha");
  });

  /**
   * Answer them all → the contact card, and the badge is gone.
   *
   * The badge is read from the RELOADED list rather than from the fixture:
   * answering re-reads `contacts:get-all`, so this measures what the user would
   * see and not what the test set up.
   *
   * OBSERVED RED: remove the auto-close effect and the emptied review screen
   * stays up in front of the card, asking nothing.
   */
  it("closes onto the contact card once the last question is answered", async () => {
    await renderList();
    await openContact("Rosalind Vance");
    await waitFor(() => expect(candidatesOnScreen()).toHaveLength(3));

    for (const id of ["p-alpha", "p-bravo", "p-charlie"]) {
      // The list the app re-reads after each answer loses the badge with the
      // last question, so the fixture stops claiming one at the same moment the
      // queue empties.
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: [
          id === "p-charlie" ? ({ ...ROSALIND, review_state: undefined } as unknown as Contact) : ROSALIND,
          SETTLED,
          OTHER,
        ],
      });
      await userEvent.click(screen.getByTestId(`review-confirm-${id}`));
    }

    await waitFor(() =>
      expect(screen.queryByTestId("review-duplicates-modal")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument();
    await waitFor(() => {
      const row = screen
        .getAllByTestId("contact-row")
        .find((r) => within(r).queryByText("Rosalind Vance"))!;
      expect(within(row).queryByRole("status")).not.toBeInTheDocument();
    });
  });

  /**
   * The EYE still opens the pairwise compare for ONE candidate — untouched, and
   * the same behaviour it has from the full queue. This is the surface the
   * founder tested and passed; the filter must not have moved it.
   */
  it("the eye still opens the pairwise compare for a single candidate", async () => {
    await renderList();
    await openContact("Rosalind Vance");
    await waitFor(() => expect(candidatesOnScreen()).toHaveLength(3));

    await userEvent.click(screen.getByTestId("review-view-p-bravo"));

    await waitFor(() =>
      expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument(),
    );
    // Pairwise: the contact's own records as ONE column, the candidate beside it.
    expect(
      within(screen.getByTestId("contact-compare-screen")).getAllByTestId(/^compare-column-/),
    ).toHaveLength(2);
    expect(screen.getByTestId("compare-column-q:rec-bravo")).toBeInTheDocument();
  });

  /**
   * No open questions, no interception. The ordinary case gains nothing, which
   * is the whole reason the badge exists instead of a modal.
   */
  it("opens the card directly when nothing is outstanding", async () => {
    await renderList();

    await openContact("Tomas Iyer");

    await waitFor(() =>
      expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("review-duplicates-modal")).not.toBeInTheDocument();
  });

  /**
   * THE HALF THAT CAN ACTUALLY FAIL.
   *
   * The case above cannot be made red by any plausible mistake: Tomas carries no
   * `review_state` at all, so every candidate implementation opens his card. A
   * check whose inputs cannot separate pass from fail carries no information, so
   * here is one whose inputs can.
   *
   * A contact wearing a STALE `Suggestion` badge — stamped when the list was
   * last read, answered since — with an EMPTY queue. Driving the click off
   * `review_state.openQuestions`, which is the obvious and wrong implementation,
   * opens a review screen with nothing on it: the founder's defect rebuilt out
   * of a different stale number.
   *
   * OBSERVED RED: swap the click's test for
   * `(contact.review_state?.openQuestions ?? 0) > 0` and this goes red while
   * every other test in the file stays green.
   *
   * The absence is asserted IMMEDIATELY after the click, before anything is
   * awaited. That is deliberate and is what gives the test its teeth: the
   * badge-driven version mounts the screen synchronously and only takes it down
   * again once its own fetch resolves and the auto-close effect fires. Waiting
   * first would let the screen open and shut and call it a pass, while the
   * founder would have watched it flash.
   */
  it("does not open on a stale badge when the queue has nothing to ask", async () => {
    pending = [];
    await renderList();

    const row = screen
      .getAllByTestId("contact-row")
      .find((r) => within(r).queryByText("Rosalind Vance"))!;
    expect(within(row).getByRole("status")).toHaveTextContent("Suggestion");

    const readsBefore = api().getReviewQueue.mock.calls.length;
    await openContact("Rosalind Vance");

    await waitFor(() =>
      expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("review-duplicates-modal")).not.toBeInTheDocument();
    // The observable difference, and the reason this is asserted as a READ COUNT
    // rather than only as an absence: a badge-driven click MOUNTS the review
    // screen, which fetches, finds nothing and closes itself again. JSDOM cannot
    // see that flash — the auto-close lands inside the same act() — but the
    // fetch it costs is right here in the mock.
    expect(api().getReviewQueue.mock.calls.length).toBe(readsBefore);
  });

  /**
   * `Compare sources` survives, and it is the ONE surface where settled records
   * appear side by side.
   *
   * The founder kept this button explicitly: *"Keep the button."* It is the only
   * way to inspect what a merged contact is actually made of, and it costs
   * nothing unpressed. Three columns come back, none of them a proposal.
   */
  it("`Compare sources` still shows every linked record, settled ones included", async () => {
    pending = [];
    await renderList();

    await openContact("Rosalind Vance");
    await waitFor(() =>
      expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByTestId("contact-compare-open"));

    await waitFor(() =>
      expect(screen.getByTestId("contact-compare-screen")).toBeInTheDocument(),
    );
    const columns = within(screen.getByTestId("contact-compare-screen"))
      .getAllByTestId(/^compare-column-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(columns).toEqual([
      "compare-column-l-origin",
      "compare-column-l-settled-one",
      "compare-column-l-settled-two",
    ]);
  });

  /**
   * THE HEADER BUTTON IS UNFILTERED — the regression guard on the shared call
   * site.
   *
   * One component, two entry points. If the filter leaked into the header route
   * — a `questionsForContactId` left standing from an earlier click, say — the
   * full queue would silently show one contact's questions and the user would
   * have no way to tell.
   */
  it("the header button still opens the WHOLE queue after a filtered visit", async () => {
    await renderList();

    await openContact("Rosalind Vance");
    await waitFor(() => expect(candidatesOnScreen()).toHaveLength(3));
    await userEvent.click(screen.getByTestId("review-duplicates-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("review-duplicates-modal")).not.toBeInTheDocument(),
    );

    await userEvent.click(await screen.findByTestId("review-duplicates-button"));

    await waitFor(() => expect(candidatesOnScreen()).toHaveLength(4));
    expect(candidatesOnScreen()).toEqual(["p-alpha", "p-bravo", "p-charlie", "p-delta"]);
    expect(screen.getByTestId("review-tuck-c-mira")).toBeInTheDocument();
  });
});
