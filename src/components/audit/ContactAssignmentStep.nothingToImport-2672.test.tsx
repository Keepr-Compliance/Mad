/**
 * BACKLOG-2672 — the transaction picker lists the empty record and refuses to
 * add it.
 *
 * ===========================================================================
 * WHY THIS SURFACE HAS ITS OWN FILE
 * ===========================================================================
 * Control 4 of the founder's decision, and BACKLOG-2603's lesson stated as a
 * rule: the contacts list and the transaction picker DIVERGE unless both are
 * tested. They do not even share an import path — Clients & Contacts imports
 * through the detail pane's `Import` button, while this screen imports through
 * the row's `+ Add`, and in add-mode the ROW BODY does it too, without passing
 * through `handleImport` at all.
 *
 * ===========================================================================
 * THE FIXTURE IS THE PROJECTION, NOT AN INVENTION
 * ===========================================================================
 * `emptyMessageRecord` below is the row `getMessageDerivedContacts` actually
 * emits for a message with no resolvable handle. That shape is not asserted
 * here — it is DERIVED BY EXECUTION against the real schema and the real
 * producer in
 * `electron/services/db/__tests__/contactDbService.nothingToImport-2672.test.ts`
 * ("a message with NO handle projects name 'unknown' and phone 'unknown'"), and
 * transcribed from it. If the producer changes, that suite goes red first.
 *
 * `namelessButReachable` is control 2: no name, but a phone. It must keep its
 * working `+ Add`.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import ContactAssignmentStep from "./ContactAssignmentStep";
import type { Contact } from "../../../electron/types/models";

jest.mock("../../services", () => ({
  contactService: { create: jest.fn() },
  settingsService: { getContactAutoRoleEnabled: jest.fn().mockResolvedValue(false) },
}));

/**
 * Harness transcribed from `ContactAssignmentStep.sameName-2663.test.tsx`.
 *
 * `over` is deliberately loose rather than `Partial<Contact>`: the projection
 * these fixtures stand in for emits SQL NULLs, and `Contact` declares those
 * fields `string | undefined`. Typing the overrides strictly would force the
 * fixtures to say `undefined` where the producer says `null` — the two are not
 * interchangeable for `!!x` checks, and the whole item turns on what those
 * checks do with a placeholder.
 */
function contact(over: Record<string, unknown> & { id: string }): Contact {
  return {
    user_id: "user-2672",
    email: null,
    phone: null,
    company: null,
    source: "manual",
    is_message_derived: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  } as unknown as Contact;
}

/**
 * THE FOUNDER'S ROW. `msg_unknown`, name and phone both the literal string
 * `unknown`, `source: "messages"`, `is_message_derived: 1`.
 */
const emptyMessageRecord = contact({
  id: "msg_unknown",
  display_name: "unknown",
  name: "unknown",
  phone: "unknown",
  email: null,
  company: null,
  source: "messages",
  is_message_derived: 1,
  last_communication_at: "2026-08-09T12:00:00Z",
});

/** CONTROL 2 — no name, but a real number. Same population, must stay addable. */
const namelessButReachable = contact({
  id: "msg_reachable",
  display_name: null,
  name: null,
  phone: "+16175550147",
  email: null,
  company: null,
  source: "messages",
  is_message_derived: 1,
  last_communication_at: "2026-08-09T11:00:00Z",
});

/** An ordinary saved contact, so "everything was blocked" cannot pass. */
const ordinarySaved = contact({
  id: "c-marisol",
  display_name: "Marisol Vantrees",
  name: "Marisol Vantrees",
  phone: "+16175550101",
});

function propsWith(contacts: Contact[], overrides: Record<string, unknown> = {}) {
  return {
    step: 2,
    contactAssignments: {},
    selectedContactIds: [] as string[],
    onSelectedContactIdsChange: jest.fn(),
    onAssignContact: jest.fn(),
    onRemoveContact: jest.fn(),
    userId: "user-2672",
    transactionType: "purchase",
    propertyAddress: "123 Main St",
    contacts,
    contactsLoading: false,
    contactsError: null,
    onRefreshContacts: jest.fn(),
    onRefreshBothLists: jest.fn(),
    externalContacts: [] as Contact[],
    externalContactsLoading: false,
    ...overrides,
  };
}

/** Every row on screen, as ids. IDENTITY, never a count. */
function renderedContactIds(): string[] {
  return screen
    .queryAllByTestId("contact-row")
    .map((row) => row.getAttribute("data-contact-id") ?? "")
    .sort();
}

function rowFor(id: string): HTMLElement {
  const row = document.querySelector(`[data-contact-id="${id}"]`);
  if (!row) throw new Error(`no row rendered for ${id}`);
  return row as HTMLElement;
}

beforeEach(() => jest.clearAllMocks());

describe("BACKLOG-2672 — the transaction picker", () => {
  /**
   * FOUNDER RULE 1. He rejected suppression precisely so he could see these:
   * *"a record you cannot see is a record you cannot investigate"*.
   */
  it("still LISTS the record with nothing on it", () => {
    render(
      <ContactAssignmentStep
        {...propsWith([emptyMessageRecord, namelessButReachable, ordinarySaved])}
      />,
    );

    expect(renderedContactIds()).toEqual(
      ["c-marisol", "msg_reachable", "msg_unknown"].sort(),
    );
  });

  /**
   * FOUNDER RULES 2 AND 3, plus control 3 — the reason is the control's
   * ACCESSIBLE NAME, so `getByRole` can find it by what it says. A `data-testid`
   * would be satisfied by a button that said nothing at all.
   */
  it("refuses the add, and the reason names the missing fields", () => {
    render(<ContactAssignmentStep {...propsWith([emptyMessageRecord])} />);

    const blocked = screen.getByRole("button", {
      name: /no name, phone, or email — nothing to import/i,
    });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
  });

  /**
   * `aria-disabled`, NOT `disabled`, and this is the assertion that pins the
   * difference. A natively disabled button is removed from the tab order, so a
   * keyboard user could never reach it and would never hear the reason — the
   * same failure as the tooltip the founder rejected in rule 2.
   */
  it("keeps the refused control reachable by keyboard", () => {
    render(<ContactAssignmentStep {...propsWith([emptyMessageRecord])} />);

    const blocked = screen.getByRole("button", { name: /nothing to import/i });
    expect(blocked).not.toBeDisabled();
    blocked.focus();
    expect(blocked).toHaveFocus();
  });

  /** The press is inert — `aria-disabled` announces, it does not enforce. */
  it("pressing the refused control selects nothing", () => {
    const onSelectedContactIdsChange = jest.fn();
    render(
      <ContactAssignmentStep
        {...propsWith([emptyMessageRecord], { onSelectedContactIdsChange })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /nothing to import/i }));

    expect(onSelectedContactIdsChange).not.toHaveBeenCalled();
  });

  /**
   * THE HOLE THE BUTTON GUARD DOES NOT COVER. In add-mode a click anywhere on
   * the row adds the contact, without going through the button at all.
   */
  it("clicking the row BODY of a refused record selects nothing", () => {
    const onSelectedContactIdsChange = jest.fn();
    render(
      <ContactAssignmentStep
        {...propsWith([emptyMessageRecord], { onSelectedContactIdsChange })}
      />,
    );

    fireEvent.click(rowFor("msg_unknown"));

    expect(onSelectedContactIdsChange).not.toHaveBeenCalled();
  });

  /**
   * CONTROL 2 — THE BOUNDARY THIS FIX MUST NOT CROSS.
   *
   * 23 nameless records were parsed at the founder's last app start. A record
   * with no name but WITH a phone is the common, useful case, and it is the leg
   * a too-broad predicate eats.
   */
  it("a record with NO NAME but WITH a phone keeps a working + Add", () => {
    const onSelectedContactIdsChange = jest.fn();
    render(
      <ContactAssignmentStep
        {...propsWith([emptyMessageRecord, namelessButReachable], {
          onSelectedContactIdsChange,
        })}
      />,
    );

    // Its own row carries the live control, not the refusal.
    const reachableRow = rowFor("msg_reachable");
    expect(
      reachableRow.querySelector('[data-testid="contact-row-add-button"]'),
    ).not.toBeNull();
    expect(
      reachableRow.querySelector('[data-testid="contact-row-add-blocked"]'),
    ).toBeNull();

    fireEvent.click(rowFor("msg_reachable"));
    expect(onSelectedContactIdsChange).toHaveBeenCalledWith(["msg_reachable"]);
  });

  /** And an ordinary saved contact is untouched by any of this. */
  it("an ordinary saved contact still adds", () => {
    const onSelectedContactIdsChange = jest.fn();
    render(
      <ContactAssignmentStep
        {...propsWith([emptyMessageRecord, ordinarySaved], {
          onSelectedContactIdsChange,
        })}
      />,
    );

    fireEvent.click(rowFor("c-marisol"));
    expect(onSelectedContactIdsChange).toHaveBeenCalledWith(["c-marisol"]);
  });
});

/**
 * =============================================================================
 * BACKLOG-2707 — the transaction flow's import legs, DRIVEN rather than read
 * =============================================================================
 * The Step 6 plan for the renderer half claimed this surface had no diverting
 * name check, on the strength of reading `handlePreviewImportAction`. SR ruled
 * that insufficient — and it was the same read-not-driven reasoning that let
 * the founder's Step 12a failure through in the first place. `window.api.contacts.import`
 * was asserted NOWHERE on this surface for a nameless record; the nearest test
 * (`a record with NO NAME but WITH a phone keeps a working + Add`) asserts
 * SELECTION, which is a different thing entirely.
 *
 * Both legs are exercised here:
 *   - row-body leg  — `ContactAssignmentStep.tsx` `onImportContact={handleImportContact}`
 *   - card leg      — `ContactPreview` `onImport={handlePreviewImportAction}` (step 3)
 *
 * Reachability is not assumed either: this component is rendered by
 * `AuditTransactionModal` (Start New Audit → step 2) and by `EditContactsModal`
 * (editing contacts on an existing transaction). Both are live user surfaces.
 *
 * The records are ADDRESS-BOOK rows, because those are what actually carry
 * `name: null`. A message-derived row cannot — `getMessageDerivedContacts`
 * selects `json_extract(participants,'$.from')` into BOTH `display_name` and
 * `name`, so its "nameless" records carry the phone string as their name.
 */
const namelessExternal = contact({
  id: "ext_reachable",
  display_name: null,
  name: null,
  phone: "+16175550147",
  email: null,
  company: null,
  source: "google_contacts",
  is_message_derived: 0,
  isFromDatabase: false,
  externalRecordId: "GC-RECORD-1",
  externalSourceType: "google_contacts",
});

/**
 * A message-derived person, transcribed from `getMessageDerivedContacts` — see
 * the card-leg test for the producer's columns and its WHERE clause. The handle
 * is a display name, and the same string lands in `display_name`, `name` and
 * `phone`.
 */
const messageDerivedPerson = contact({
  id: "msg_dana whitlock",
  display_name: "Dana Whitlock",
  name: "Dana Whitlock",
  phone: "Dana Whitlock",
  email: null,
  company: null,
  source: "messages",
  is_imported: 0,
  is_message_derived: 1,
  last_communication_at: "2026-08-09T10:00:00Z",
});

const companyOnlyExternal = contact({
  id: "ext_company",
  display_name: null,
  name: null,
  phone: null,
  email: null,
  company: "Vantrees Realty Test",
  source: "google_contacts",
  is_message_derived: 0,
  isFromDatabase: false,
  externalRecordId: "GC-RECORD-3",
  externalSourceType: "google_contacts",
});

describe("the transaction flow imports a nameless record too (BACKLOG-2707)", () => {
  beforeEach(() => {
    jest.mocked(window.api.contacts.import).mockResolvedValue({
      success: true,
      contacts: [contact({ id: "saved-1", display_name: "", name: "" })],
    });
  });

  it("row-body leg — pressing the row imports it", async () => {
    render(
      <ContactAssignmentStep
        {...propsWith([], { externalContacts: [namelessExternal] })}
      />,
    );

    fireEvent.click(rowFor("ext_reachable"));

    await waitFor(() => expect(window.api.contacts.import).toHaveBeenCalled());
    const [, records] = jest.mocked(window.api.contacts.import).mock.calls[0];
    expect((records[0] as unknown as { id: string }).id).toBe("ext_reachable");
  });

  /**
   * =========================================================================
   * CARD LEG — DRIVEN. AND THE TEST THAT USED TO SIT HERE WAS FALSE.
   * =========================================================================
   * This case previously read *"no preview opens from the list, so it has no
   * reachable caller"* and passed. **The sentence was wrong.** It checked the
   * step-2 LIST; the opener is at step 3. SR reached the card in two ordinary
   * presses and the preview carries a live Import button wired to the very
   * handler the test said nothing calls.
   *
   * A green test recording a falsehood, shipped inside the PR whose subject is
   * a control that could not fail. It is replaced by the drive, not amended.
   *
   * The opener, traced by execution rather than read: `setPreviewContact` has
   * exactly one value-setting caller — `handleContactClick`, wired to
   * `ContactRoleRow.onClick` inside the step-3 `selectedContacts.map(...)`.
   *
   * THE FIXTURE IS TRANSCRIBED FROM `getMessageDerivedContacts`, and its
   * constraints are why it looks like this:
   *
   *     'msg_' || LOWER(from)  as id
   *     from                   as display_name, as name
   *     CASE WHEN from NOT LIKE '%@%' THEN from END as phone
   *     NULL                   as company
   *     1                      as is_message_derived
   *     WHERE from NOT LIKE '%@%' AND NOT LIKE '+%' AND NOT GLOB '[0-9]*'
   *
   * So the handle is always a DISPLAY NAME — never an email, never a number —
   * and it lands in `display_name`, `name` AND `phone` at once. The company is
   * always NULL. A company-only case cannot be written on this leg because the
   * producer cannot emit one.
   */
  it("card leg — two presses reach the preview, and its Import control is live", async () => {
    const onSelectedContactIdsChange = jest.fn();

    // STEP 2 — pressing the row selects it. This is the first of the two
    // presses, and it is what puts the record in front of step 3.
    const { unmount } = render(
      <ContactAssignmentStep
        {...propsWith([messageDerivedPerson], { onSelectedContactIdsChange })}
      />,
    );
    fireEvent.click(rowFor("msg_dana whitlock"));
    expect(onSelectedContactIdsChange).toHaveBeenCalledWith(["msg_dana whitlock"]);
    unmount();

    // STEP 3 — the selected record gets a ContactRoleRow, and pressing it opens
    // the card. This is the caller the old test said did not exist.
    render(
      <ContactAssignmentStep
        {...propsWith([messageDerivedPerson], {
          step: 3,
          selectedContactIds: ["msg_dana whitlock"],
        })}
      />,
    );

    fireEvent.click(
      screen
        .getByTestId("contact-role-row-msg_dana whitlock")
        .querySelector('[role="button"]') as HTMLElement,
    );

    await screen.findByTestId("contact-preview-name");

    const live = screen.getByTestId("contact-preview-import");
    expect(live).toBeEnabled();
    expect(
      screen.queryByTestId("contact-preview-import-blocked"),
    ).not.toBeInTheDocument();

    // The press reaches `handlePreviewImportAction`, which closes the card.
    //
    // WHAT THIS DELIBERATELY DOES NOT ASSERT: that the record is imported. On
    // this leg the press does NOT import — `handleImportContact` decides
    // "external" by membership of `contacts`, and message-derived rows arrive
    // inside `contacts`, so the already-imported branch runs and a synthesized
    // `msg_*` id with no `contacts` row is added to the transaction. That is
    // pre-existing, untouched by BACKLOG-2707, and filed as BACKLOG-3188.
    // Asserting an import here would claim a path is handled when it is not,
    // which is the mistake this whole item exists to stop.
    fireEvent.click(live);
    await waitFor(() =>
      expect(screen.queryByTestId("contact-preview-name")).not.toBeInTheDocument(),
    );
  });

  /**
   * The founder's ruling `a41a805b` reaches this surface too: a company-only
   * record is refused before the press, on the row, with the accurate reason.
   */
  it("a company-only record is blocked on the row, with a reason true of it", () => {
    render(
      <ContactAssignmentStep
        {...propsWith([], { externalContacts: [companyOnlyExternal] })}
      />,
    );

    const row = rowFor("ext_company");
    expect(row.querySelector('[data-testid="contact-row-add-blocked"]')).not.toBeNull();
    expect(row.textContent).toContain("company on its own");
    expect(row.textContent).not.toContain("nothing to import");

    fireEvent.click(row);
    expect(window.api.contacts.import).not.toHaveBeenCalled();
  });
});
