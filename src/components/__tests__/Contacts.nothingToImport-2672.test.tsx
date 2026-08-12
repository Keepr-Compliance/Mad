/**
 * BACKLOG-2672 — Clients & Contacts lists the empty record and refuses to
 * import it.
 *
 * ===========================================================================
 * WHAT THE FOUNDER FOUND
 * ===========================================================================
 * Gate 4, check 6, 11 Aug. He searched the contacts list for "Unknown":
 *
 *     U   unknown
 *         Message · Not Imported · [Import]
 *         Phone: unknown
 *
 * Six of them are in his book. Pressing Import would have created a contact
 * with nothing on it — the state BACKLOG-2461 exists to eliminate, arriving
 * through a door 2461 did not close.
 *
 * FOUNDER DECISION, 12 Aug: option 2 — **list it, refuse the import, put the
 * reason on the button**. Suppressing the row was the recommendation and was
 * NOT taken: *"a record you cannot see is a record you cannot investigate"*.
 *
 * ===========================================================================
 * THE BUTTON UNDER TEST IS THE PREVIEW'S, AND THAT IS NOT AN ASSUMPTION
 * ===========================================================================
 * On this screen `ContactSearchList` runs with `compact`, so the row-level
 * "+ Add Contact" is suppressed — as `Contacts.importButtonState-2525.test.tsx`
 * records. The live control is `ContactPreview`'s header button, reached by
 * clicking the row.
 *
 * `Contacts.tsx:1190` wires it on `external = is_message_derived`, NOT on
 * membership of the `externalContacts` array — which is exactly why this record
 * has one. Message-derived pseudo-contacts are synthesised out of the `messages`
 * table and arrive in the SAVED half's array (`contacts:get-all`), so a fix
 * gated on the external set would have missed the founder's record with every
 * test green.
 *
 * ===========================================================================
 * THE FIXTURE IS THE PROJECTION
 * ===========================================================================
 * `emptyMessageRecord` is what `getMessageDerivedContacts` actually emits for a
 * message with no resolvable handle. Derived by execution against the real
 * schema and the real producer in
 * `electron/services/db/__tests__/contactDbService.nothingToImport-2672.test.ts`
 * and transcribed from there, not written from the screenshot.
 */

import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Contacts from "../Contacts";
import {
  ALL_SOURCE_LEAF_IDS,
  defaultRoleSelection,
} from "../../utils/contactFilterModel";
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

/** Harness transcribed from `Contacts.importButtonState-2525.test.tsx`. */
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

const USER_ID = "user-2672";

/** THE FOUNDER'S ROW, as `getMessageDerivedContacts` emits it. */
const emptyMessageRecord = {
  id: "msg_unknown",
  user_id: USER_ID,
  display_name: "unknown",
  name: "unknown",
  email: null,
  phone: "unknown",
  company: null,
  source: "messages",
  is_imported: 0,
  is_message_derived: 1,
  last_communication_at: "2026-08-09T12:00:00Z",
  communication_count: 3,
} as unknown as Contact;

/** CONTROL 2 — no name, but a real number. Same population, must stay importable. */
const namelessButReachable = {
  ...(emptyMessageRecord as unknown as Record<string, unknown>),
  id: "msg_reachable",
  display_name: null,
  name: null,
  phone: "+16175550147",
} as unknown as Contact;

/** An ordinary saved contact, so "everything was blocked" cannot pass. */
const ordinarySaved = {
  id: "c-marisol",
  user_id: USER_ID,
  display_name: "Marisol Vantrees",
  name: "Marisol Vantrees",
  email: "marisol@example.com",
  phone: "+16175550101",
  source: "contacts_app",
  is_imported: 1,
  created_at: "2026-08-01T09:12:00Z",
  updated_at: "2026-08-01T09:12:00Z",
} as unknown as Contact;

function installBackend(contacts: Contact[]) {
  jest
    .mocked(window.api.contacts.getAll)
    .mockResolvedValue({ success: true, contacts });
  jest
    .mocked(window.api.contacts.getAvailable)
    .mockResolvedValue({ success: true, contacts: [] });
  jest
    .mocked(window.api.contacts.checkCanDelete)
    .mockResolvedValue({ success: true, transactions: [] });
  jest
    .mocked(window.api.contacts.import)
    .mockResolvedValue({ success: true, contacts: [ordinarySaved] });
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

/**
 * PUT THE SCREEN IN THE STATE THE FOUNDER'S WAS IN.
 *
 * `defaultSourceSelection()` turns the ENTIRE Inferred group OFF
 * (`contactFilterModel.ts:258-261`), and message-derived rows are exactly what
 * that group holds — so on a default filter the record this item is about is
 * not on screen at all, and every assertion below would pass against a build
 * with no fix in it.
 *
 * He found the row, so his persisted selection has Inferred on. This writes
 * that selection to the key `ContactSearchList` reads
 * (`contactModal.filterModel.v1`) rather than reaching past the filter, so the
 * list still runs its real filtering path.
 */
function selectEverySource(): void {
  localStorage.setItem(
    "contactModal.filterModel.v1",
    JSON.stringify({
      sources: [...ALL_SOURCE_LEAF_IDS],
      roles: [...defaultRoleSelection()],
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  selectEverySource();
  installMatchMedia(false);
});

afterEach(() => {
  localStorage.clear();
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe("BACKLOG-2672 — Clients & Contacts", () => {
  /** FOUNDER RULE 1: the row is not hidden, not collapsed, not filtered out. */
  it("still LISTS the record with nothing on it", async () => {
    installBackend([emptyMessageRecord, namelessButReachable, ordinarySaved]);
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);

    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        ["c-marisol", "msg_reachable", "msg_unknown"].sort(),
      ),
    );
  });

  /**
   * The row is still INVESTIGABLE — the click that opens its card must keep
   * working. This is the whole reason option 2 was chosen over suppression, and
   * it is the case a blanket "block every interaction" guard breaks.
   */
  it("opens the record's card when the row is clicked", async () => {
    installBackend([emptyMessageRecord]);
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual(["msg_unknown"]));

    await userEvent.click(rowFor("msg_unknown"));

    expect(await screen.findByTestId("contact-preview-name")).toBeInTheDocument();
  });

  /**
   * FOUNDER RULES 2 AND 3, plus control 3.
   *
   * `getByRole(… { name })` reads the ACCESSIBLE name, so this fails if the
   * reason is only a `title`, only a tooltip, or only a `data-testid`. The
   * founder's rule: *"the reason names the missing thing, not the rule"* —
   * "This record cannot be imported" would tell him nothing the grey button did
   * not.
   */
  it("refuses the import, with the reason ON the control", async () => {
    installBackend([emptyMessageRecord]);
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual(["msg_unknown"]));
    await userEvent.click(rowFor("msg_unknown"));
    await screen.findByTestId("contact-preview-name");

    const blocked = screen.getByRole("button", {
      name: /no name, phone, or email — nothing to import/i,
    });
    expect(blocked).toHaveAttribute("aria-disabled", "true");

    // The live Import button is GONE — not merely greyed beside a refusal.
    expect(screen.queryByTestId("contact-preview-import")).not.toBeInTheDocument();
  });

  /** `aria-disabled`, not `disabled`: still focusable, so still announced. */
  it("keeps the refused control reachable by keyboard", async () => {
    installBackend([emptyMessageRecord]);
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual(["msg_unknown"]));
    await userEvent.click(rowFor("msg_unknown"));
    await screen.findByTestId("contact-preview-name");

    const blocked = screen.getByRole("button", { name: /nothing to import/i });
    expect(blocked).not.toBeDisabled();
    blocked.focus();
    expect(blocked).toHaveFocus();
  });

  /** And pressing it writes nothing. */
  it("pressing the refused control calls no import", async () => {
    installBackend([emptyMessageRecord]);
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual(["msg_unknown"]));
    await userEvent.click(rowFor("msg_unknown"));
    await screen.findByTestId("contact-preview-name");

    fireEvent.click(screen.getByRole("button", { name: /nothing to import/i }));

    expect(window.api.contacts.import).not.toHaveBeenCalled();
  });

  /**
   * CONTROL 2 — THE BOUNDARY THIS FIX MUST NOT CROSS.
   *
   * No name, but a phone. 23 such records were parsed at the founder's last app
   * start. Its card keeps a real, pressable Import.
   */
  it("a record with NO NAME but WITH a phone is still importable", async () => {
    installBackend([namelessButReachable]);
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual(["msg_reachable"]));
    await userEvent.click(rowFor("msg_reachable"));

    const live = await screen.findByTestId("contact-preview-import");
    expect(live).toBeEnabled();
    expect(live).toHaveTextContent("Import");
    expect(
      screen.queryByTestId("contact-preview-import-blocked"),
    ).not.toBeInTheDocument();

    /*
      AND IT LEADS SOMEWHERE. `handlePreviewImport` (`Contacts.tsx:951-957`) has
      its own completeness check — a record with no name is routed to the
      contact FORM so the user can supply one, rather than imported blind. That
      is pre-existing behaviour and this change does not touch it; asserting it
      here is what makes "the control is live" mean something, since a button
      that renders and does nothing would satisfy the checks above.

      It also shows why that check could not close BACKLOG-2672 on its own:
      `hasName` is plain truthiness, so the founder's record — whose name is the
      STRING "unknown" — passes it and reaches `contacts:import`.
    */
    fireEvent.click(live);
    // `ContactFormModal` opened over the pane. Its heading reads "Edit Contact"
    // because `selectedContact` is set, though it saves down the CREATE leg —
    // see the note at `Contacts.tsx:958-968`.
    await waitFor(() =>
      expect(screen.getAllByText("Edit Contact").length).toBeGreaterThan(0),
    );
    expect(window.api.contacts.import).not.toHaveBeenCalled();
  });

  /** An ordinary saved contact never sees an Import button at all. */
  it("an ordinary saved contact is untouched", async () => {
    installBackend([ordinarySaved]);
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual(["c-marisol"]));
    await userEvent.click(rowFor("c-marisol"));
    await screen.findByTestId("contact-preview-name");

    expect(screen.queryByTestId("contact-preview-import")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("contact-preview-import-blocked"),
    ).not.toBeInTheDocument();
  });
});
