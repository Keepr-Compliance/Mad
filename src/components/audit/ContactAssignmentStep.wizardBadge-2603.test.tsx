/**
 * BACKLOG-2603 — THE TRANSACTION WIZARD RENDERS CONTACTS WITHOUT THE SIGNALS
 * THE CONTACTS LIST ALREADY RENDERS.
 *
 * ===========================================================================
 * WHAT THE FOUNDER MEASURED, 2026-08-10
 * ===========================================================================
 * 1. Un-imported address-book records ARE findable here. He searched a record
 *    never imported and it appeared — refuting a hypothesis that the wizard
 *    filters on `is_imported`. That behaviour is guarded below so a fix for (2)
 *    cannot take it away.
 * 2. A contact with FOUR outstanding questions gave him no indication at all,
 *    while the same contact in Clients & Contacts carries a badge.
 *
 * ===========================================================================
 * WHY THIS WAS NEVER A BUILD
 * ===========================================================================
 * > *"if we were to reuse the search from the Clients & Contacts it shouldn't
 * > [need building], should it?"*
 *
 * Correct, and nothing was forked. Both surfaces already render the SAME
 * `ContactRow` through the SAME `ContactSearchList`; `ContactAssignmentStep` is
 * mounted by the new-transaction wizard AND by the existing-transaction Add
 * Contacts overlay, so one fix covers both.
 *
 * What stood between them was `toExtendedContact`, a FIELD-BY-FIELD ALLOWLIST
 * that copied fourteen names across and dropped everything else — including
 * `review_state`. It is the fourth field lost through that hole (BACKLOG-1270
 * `allEmails`/`allPhones`, BACKLOG-1355 `default_role`, a BACKLOG-1727 follow-up
 * `last_communication_at`), which is why the fix inverts the projection's
 * default rather than adding a fifteenth line.
 *
 * ===========================================================================
 * THE WAY IN IS THE BADGE, NOT THE ROW CLICK
 * ===========================================================================
 * In Clients & Contacts the row click opens the filtered queue. HERE the row
 * click ADDS THE CONTACT TO THE TRANSACTION — and `ContactSearchList` derives
 * `isSelectionMode` from the absence of `onContactClick`, so routing the
 * questions through that prop would take add-mode away with it. The badge takes
 * the click; the row keeps its own meaning on both surfaces.
 *
 * Fixtures: `example.com` / `example.net`, `+1 <area> 555-01xx` with 555 in the
 * exchange slot.
 */

import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import ContactAssignmentStep from "./ContactAssignmentStep";
import { ContactSearchList } from "../shared/ContactSearchList";
import type { Contact } from "../../../electron/types/models";
import type { ExtendedContact } from "../../types/components";

jest.mock("../../services", () => ({
  contactService: { create: jest.fn() },
  settingsService: { getContactAutoRoleEnabled: jest.fn().mockResolvedValue(false) },
}));

/**
 * The founder's own contact: imported, four records attached, TWO questions
 * still open at the moment he looked.
 *
 * `review_state` is transcribed from `attachReviewState`'s shape — the producer
 * behind BOTH of the wizard's fetches (`getSortedByActivity` and `getAll`), so
 * this fixture describes a state the app really emits rather than one invented
 * to make a badge appear.
 */
const BIANCA = {
  id: "contact-bianca",
  user_id: "user-123",
  name: "Bianca Okafor",
  display_name: "Bianca Okafor",
  email: "bianca@example.com",
  phone: "+1 503 555-0130",
  company: "Okafor & Co Realty",
  source: "manual",
  is_message_derived: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  review_state: {
    columns: 4,
    records: 4,
    needsReview: false,
    openQuestions: 2,
    badge: "suggestion" as const,
  },
} as Contact;

/** The ordinary contact — no auto-links, no open questions, no badge. */
const PETRA = {
  id: "contact-petra",
  user_id: "user-123",
  name: "Petra Lindqvist",
  display_name: "Petra Lindqvist",
  email: "petra@example.com",
  phone: "+1 503 555-0144",
  company: "Northshore Title",
  source: "manual",
  is_message_derived: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as Contact;

/** An address-book record never imported — the one he searched for and found. */
const BEA_UNIMPORTED = {
  id: "ext-bea",
  user_id: "user-123",
  name: "Bea Okafor",
  display_name: "Bea Okafor",
  email: "bea@example.net",
  phone: "+1 503 555-0161",
  company: "Example Escrow",
  source: "contacts_app",
  is_message_derived: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as Contact;

const defaultProps = {
  step: 2,
  contactAssignments: {},
  selectedContactIds: [] as string[],
  onSelectedContactIdsChange: jest.fn(),
  onAssignContact: jest.fn(),
  onRemoveContact: jest.fn(),
  userId: "user-123",
  transactionType: "purchase",
  propertyAddress: "123 Main St",
  contacts: [BIANCA, PETRA],
  contactsLoading: false,
  contactsError: null,
  onRefreshContacts: jest.fn(),
  onRefreshBothLists: jest.fn().mockResolvedValue(undefined),
  externalContacts: [BEA_UNIMPORTED],
  externalContactsLoading: false,
};

function rowFor(name: string): HTMLElement {
  const nameEl = screen.getByText(name, {
    selector: '[data-testid="contact-row-name"]',
  });
  return nameEl.closest('[data-testid="contact-row"]') as HTMLElement;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("the wizard renders the same signals as Clients & Contacts (BACKLOG-2603)", () => {
  /**
   * CONTROL 1 — THE SAME COMPONENT, ASSERTED AS THE SAME COMPONENT.
   *
   * Two matching strings would pass over a forked badge that happened to be
   * worded alike, and a fork is the failure this item is about. So ONE fixture
   * is rendered through BOTH surfaces and the two badge nodes are compared by
   * their full markup — testid, role, every class. A wizard-specific badge
   * cannot survive that; only the shared `ContactRow` can produce it.
   *
   * The Clients & Contacts side is mounted the way `Contacts.tsx` mounts it —
   * `ContactSearchList` with `onContactClick` — so the comparison is against the
   * real other surface and not against a second copy of the wizard.
   *
   * OBSERVED RED: restoring the field-by-field allowlist in `toExtendedContact`
   * fails here with `Unable to find an element by:
   * [data-testid="contact-row-badge"]` on the wizard side — the founder's screen,
   * printed by a test runner.
   */
  it("renders the badge from the same component as the contacts list", () => {
    const wizard = render(<ContactAssignmentStep {...defaultProps} />);
    const wizardBadge = within(rowFor("Bianca Okafor")).getByTestId("contact-row-badge");
    const wizardMarkup = wizardBadge.outerHTML;
    wizard.unmount();

    render(
      <ContactSearchList
        contacts={[BIANCA as unknown as ExtendedContact, PETRA as unknown as ExtendedContact]}
        selectedIds={[]}
        onSelectionChange={jest.fn()}
        onContactClick={jest.fn()}
        compact
      />,
    );
    const listBadge = within(rowFor("Bianca Okafor")).getByTestId("contact-row-badge");

    expect(wizardMarkup).toBe(listBadge.outerHTML);
    expect(listBadge).toHaveTextContent("2 possible duplicates");
  });

  /**
   * CONTROL 8 — the ordinary contact gains nothing on either surface. Without
   * this, "show the badge" could be satisfied by decorating every row, which is
   * the failure the founder ruled out when he refused a fourth "Confirmed"
   * state.
   */
  it("puts no badge on a contact with nothing outstanding", () => {
    render(<ContactAssignmentStep {...defaultProps} />);

    expect(
      within(rowFor("Petra Lindqvist")).queryByTestId("contact-row-badge"),
    ).not.toBeInTheDocument();
    expect(screen.getAllByTestId("contact-row-badge")).toHaveLength(1);
  });

  /**
   * CONTROL 3 — REGRESSION GUARD ON BEHAVIOUR HE MEASURED AS WORKING.
   *
   * Un-imported records are findable here, and that must survive this change.
   * The ID SET is asserted, not a count: a list rendering three rows of the
   * wrong people would pass a count.
   */
  it("still finds an address-book record that was never imported", () => {
    render(<ContactAssignmentStep {...defaultProps} />);

    const ids = screen
      .getAllByTestId("contact-row")
      .map((row) => row.getAttribute("data-contact-id"));
    expect(new Set(ids)).toEqual(new Set(["contact-bianca", "contact-petra", "ext-bea"]));
    expect(rowFor("Bea Okafor")).toBeInTheDocument();
  });

  /**
   * CONTROL 2 — CLICKING THE BADGE SURFACES HER QUESTIONS, FILTERED TO HER.
   *
   * The screen that opens is the SHIPPED `ReviewDuplicatesModal` given the same
   * `filterContactId` Clients & Contacts passes — a fourth entry point on one
   * component, not a fourth screen. Asserted by the rendered question rather
   * than by the modal's presence, so a modal that opened onto the whole queue
   * (or onto somebody else's questions) would still fail.
   *
   * OBSERVED RED: removing the `onOpenContactQuestions` prop from the
   * `ContactSearchList` call site leaves no button to press — `Unable to find
   * an element by: [data-testid="contact-row-badge-action"]`.
   */
  it("opens her outstanding questions from the badge, filtered to her", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [
        {
          clusterKey: "contact:contact-bianca",
          question: "Which of these is Bianca Okafor?",
          exclusive: false,
          items: [
            {
              proposalId: "p-bianca-1",
              contactId: "contact-bianca",
              contactName: "Bianca Okafor",
              contactCompany: "Okafor & Co Realty",
              sourceType: "macos",
              sourceRecordId: "mac-1",
              sourceLabel: "Mac address book",
              sourceName: "Bianca Okafor-Hale",
              sourceCompany: null,
              recordEmails: ["bianca@example.com"],
              recordPhones: [],
              reason: "name_not_unique",
              matchedOn: "email",
              identity: "possibly_same_person",
              identityPhrase: "possibly the same person",
              relationship: "possibly_connected",
              relationshipPhrase: "possibly connected",
              evidence: null,
            },
          ],
        },
        {
          // Somebody else's question, in the same user-wide queue read. If the
          // filter were dropped it would render here, in a transaction wizard,
          // about a contact the user never touched.
          clusterKey: "contact:contact-petra",
          question: "Is this also Petra Lindqvist?",
          exclusive: false,
          items: [
            {
              proposalId: "p-petra-1",
              contactId: "contact-petra",
              contactName: "Petra Lindqvist",
              contactCompany: null,
              sourceType: "macos",
              sourceRecordId: "mac-9",
              sourceLabel: "Mac address book",
              sourceName: "P. Lindqvist",
              sourceCompany: null,
              recordEmails: ["petra@example.com"],
              recordPhones: [],
              reason: "name_not_unique",
              matchedOn: "email",
              identity: "possibly_same_person",
              identityPhrase: "possibly the same person",
              relationship: "possibly_connected",
              relationshipPhrase: "possibly connected",
              evidence: null,
            },
          ],
        },
      ],
    } as never);

    render(<ContactAssignmentStep {...defaultProps} />);

    await userEvent.click(
      within(rowFor("Bianca Okafor")).getByTestId("contact-row-badge-action"),
    );

    expect(await screen.findByTestId("review-item-p-bianca-1")).toBeInTheDocument();
    expect(screen.getByTestId("review-name-p-bianca-1")).toHaveTextContent(
      "Bianca Okafor-Hale",
    );
    // FILTERED. The other contact's question was in the same read and must not
    // be on screen.
    expect(screen.queryByTestId("review-item-p-petra-1")).not.toBeInTheDocument();
  });

  /**
   * PRESSING THE BADGE MUST NOT ADD HER TO THE DEAL.
   *
   * The row click is the wizard's selection action and the badge sits inside it.
   * Without `stopPropagation` a user reaching for a question joins a contact to
   * the transaction on the way — a silent write triggered by a read.
   *
   * OBSERVED RED: removing `event.stopPropagation()` from `ContactRow`'s
   * `handleOpenQuestionsClick` fails here with the selection callback called
   * once.
   */
  it("does not add the contact to the transaction when the badge is pressed", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [
        {
          clusterKey: "contact:contact-bianca",
          question: "Which of these is Bianca Okafor?",
          exclusive: false,
          items: [
            {
              proposalId: "p-bianca-1",
              contactId: "contact-bianca",
              contactName: "Bianca Okafor",
              contactCompany: null,
              sourceType: "macos",
              sourceRecordId: "mac-1",
              sourceLabel: "Mac address book",
              sourceName: "Bianca Okafor-Hale",
              sourceCompany: null,
              recordEmails: ["bianca@example.com"],
              recordPhones: [],
              reason: "name_not_unique",
              matchedOn: "email",
              identity: "possibly_same_person",
              identityPhrase: "possibly the same person",
              relationship: "possibly_connected",
              relationshipPhrase: "possibly connected",
              evidence: null,
            },
          ],
        },
      ],
    } as never);
    const onSelectedContactIdsChange = jest.fn();

    render(
      <ContactAssignmentStep
        {...defaultProps}
        onSelectedContactIdsChange={onSelectedContactIdsChange}
      />,
    );

    await userEvent.click(
      within(rowFor("Bianca Okafor")).getByTestId("contact-row-badge-action"),
    );

    expect(onSelectedContactIdsChange).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("review-duplicates-modal")).toBeInTheDocument(),
    );
  });

  /**
   * ANSWERING HERE REFRESHES THE LIST BEHIND THE SCREEN.
   *
   * The badge's count lives on `review_state`, which is stamped by the same
   * producer the wizard's fetch reads — so an answered question must be followed
   * by a re-read or the row keeps advertising a question that is settled. That
   * is the BACKLOG-2626 complaint (*"the app is behaving correctly and reporting
   * that it is not"*) reappearing on a third surface.
   *
   * SILENT, so answering does not blank a list the user is part-way through
   * choosing from.
   */
  it("re-reads the contacts silently after a question is answered", async () => {
    jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({
      success: true,
      clusters: [
        {
          clusterKey: "contact:contact-bianca",
          question: "Which of these is Bianca Okafor?",
          exclusive: false,
          items: [
            {
              proposalId: "p-bianca-1",
              contactId: "contact-bianca",
              contactName: "Bianca Okafor",
              contactCompany: null,
              sourceType: "macos",
              sourceRecordId: "mac-1",
              sourceLabel: "Mac address book",
              sourceName: "Bianca Okafor-Hale",
              sourceCompany: null,
              recordEmails: ["bianca@example.com"],
              recordPhones: [],
              reason: "name_not_unique",
              matchedOn: "email",
              identity: "possibly_same_person",
              identityPhrase: "possibly the same person",
              relationship: "possibly_connected",
              relationshipPhrase: "possibly connected",
              evidence: null,
            },
          ],
        },
      ],
    } as never);
    jest.mocked(window.api.contacts.rejectLink).mockResolvedValue({
      success: true,
    } as never);
    const onRefreshBothLists = jest.fn().mockResolvedValue(undefined);
    const onRefreshContacts = jest.fn();

    render(
      <ContactAssignmentStep
        {...defaultProps}
        onRefreshBothLists={onRefreshBothLists}
        onRefreshContacts={onRefreshContacts}
      />,
    );

    await userEvent.click(
      within(rowFor("Bianca Okafor")).getByTestId("contact-row-badge-action"),
    );
    await userEvent.click(await screen.findByTestId("review-reject-p-bianca-1"));

    await waitFor(() => expect(onRefreshBothLists).toHaveBeenCalled());
    // SILENT means silent: the loud refresh raises `contactsLoading` and
    // replaces the list with a spinner, losing the user's place mid-selection.
    expect(onRefreshContacts).not.toHaveBeenCalled();
  });
});
