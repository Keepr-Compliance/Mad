/**
 * =============================================================================
 * BACKLOG-2707 — the Import press must REACH the handler, not a second rule
 * =============================================================================
 * THE CONTROL THIS ITEM SHOULD HAVE HAD FROM THE START, and the reason it is
 * worth saying so in a test file: the fix for BACKLOG-2707 shipped with seven
 * mutation controls and a twelve-payload SR probe, all green, and the founder
 * still could not import a single one of his nameless Google contacts. Every
 * one of those controls drove the registered IPC handler. The defect was in the
 * renderer, upstream of it, so no suite on the tree could fail on it
 * (`a104375f`, 2026-09-07).
 *
 * The item is titled "the handler refuses what the button offers" — a
 * disagreement between two surfaces. **A control that drives only one of them
 * cannot fail on it, however many mutations it survives.** This one drives the
 * click.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT ASSERTS, AND WHY BOTH HALVES
 * ---------------------------------------------------------------------------
 * For every record: the button state AND the outcome of pressing it. Either
 * alone is the defect — an enabled button that does nothing was exactly what
 * the founder saw, and a disabled button nobody pressed would satisfy an
 * outcome-only test.
 *
 * THE `import` MOCK RETURNS THE HANDLER'S REAL SHAPE, transcribed by driving
 * `contacts:import` with a nameless record against a real database in
 * `electron/__tests__/contact-handlers.namelessImport-2707.test.ts`:
 *
 *   { id, user_id, display_name: "", company: null, title: null,
 *     source: "contacts_app", is_imported: 1, last_inbound_at: null,
 *     last_outbound_at: null, removed_at: null, removed_reason: null }
 *
 * `display_name: ""` is the point. After the import the card re-renders on this
 * object (`showPreviewContact(imported)`), so a mock returning a named-looking
 * contact would prove nothing about the render the user actually gets.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Contacts from "../Contacts";
import type { Contact } from "../../../electron/types/models";
import { COMPANY_ONLY_IMPORT_REASON } from "../../utils/importableRecord";

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

const USER_ID = "550e8400-e29b-41d4-a716-446655440000"; // pii-allow-uuid: RFC 4122 example value, not from any live row

/** Invented. Kept off any line that also carries a number, per the PII guard. */
const NAMED_CONTROL = "Rosalind Quill";

/**
 * The five records, shaped as `contacts:get-available` emits them. Four of the
 * five producers of `external_contacts.name` write `null` for a nameless card
 * (android_sync, Outlook, Google Contacts, and iPhone's null case), so `null`
 * is the fixture rather than `""`.
 */
const RECORDS: Array<{
  key: string;
  label: string;
  record: Record<string, unknown>;
  importable: boolean;
}> = [
  {
    key: "phone-only",
    label: "+15550100",
    importable: true,
    record: { id: "gc-1", name: null, phone: "+15550100", email: null, company: null,
      allPhones: ["+15550100"], allEmails: [] },
  },
  {
    key: "email-only",
    label: "noname.test@example.com",
    importable: true,
    record: { id: "gc-2", name: null, phone: null, email: "noname.test@example.com",
      company: null, allPhones: [], allEmails: ["noname.test@example.com"] },
  },
  {
    // The one record the founder's ruling `a41a805b` keeps OUT of the import.
    key: "company-only",
    label: "Vantrees Realty Test",
    importable: false,
    record: { id: "gc-3", name: null, phone: null, email: null,
      company: "Vantrees Realty Test", allPhones: [], allEmails: [] },
  },
  {
    /**
     * SR's record D. Without it this control cannot fail on the SECOND clause of
     * the deleted block — `(!hasEmail && !hasPhone)` — which diverted a record
     * that has a perfectly good name.
     */
    key: "named-no-contact",
    label: "Gus Example",
    importable: true,
    record: { id: "gc-4", name: "Gus Example", phone: null, email: null, company: null,
      allPhones: [], allEmails: [] },
  },
  {
    key: "named-control",
    label: NAMED_CONTROL,
    importable: true,
    record: {
      id: "gc-5",
      name: NAMED_CONTROL,
      phone: "+14155550142",
      email: null,
      company: null,
      allPhones: ["+14155550142"],
      allEmails: [],
    },
  },
];

function availableRecord(r: Record<string, unknown>): Contact {
  return {
    ...r,
    source: "google_contacts",
    isFromDatabase: false,
    externalSourceType: "google_contacts",
    externalRecordId: `GC-RECORD-${r.id}`,
    last_communication_at: null,
  } as unknown as Contact;
}

/** Transcribed from the real handler — see the header. */
const importedNameless = {
  id: "379ccc4e-aac2-4c4c-8b41-203d1b918a3e", // pii-allow-uuid: from a local test database, not a live row
  user_id: USER_ID,
  display_name: "",
  company: null,
  title: null,
  source: "contacts_app",
  is_imported: 1,
  last_inbound_at: null,
  last_outbound_at: null,
  removed_at: null,
  removed_reason: null,
} as unknown as Contact;

function install(record: Record<string, unknown>) {
  jest.mocked(window.api.contacts.getAll).mockResolvedValue({ success: true, contacts: [] });
  jest
    .mocked(window.api.contacts.getAvailable)
    .mockResolvedValue({ success: true, contacts: [availableRecord(record)] });
  jest
    .mocked(window.api.contacts.import)
    .mockResolvedValue({ success: true, contacts: [importedNameless] });
  jest
    .mocked(window.api.contacts.checkCanDelete)
    .mockResolvedValue({ success: true, transactions: [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  (window as unknown as { matchMedia: unknown }).matchMedia = jest.fn().mockReturnValue({
    matches: false, media: "", addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => true,
  });
});

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

async function openCard(label: string) {
  render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getAllByText(label).length).toBeGreaterThan(0));
  await userEvent.click(screen.getAllByText(label)[0]);
  await screen.findByTestId("contact-preview-name");
}

describe("the Import press reaches contacts:import (BACKLOG-2707)", () => {
  it.each(RECORDS.filter((r) => r.importable).map((r) => [r.key, r]))(
    "%s — enabled button, and pressing it imports",
    async (_key, spec: any) => {
      install(spec.record);
      await openCard(spec.label);

      const button = await screen.findByTestId("contact-preview-import");
      // The shared predicate says importable, so the control must be live.
      expect(button).toBeEnabled();
      expect(
        screen.queryByTestId("contact-preview-import-blocked"),
      ).not.toBeInTheDocument();

      await userEvent.click(button);

      // THE ASSERTION THE FOUNDER'S RUN WOULD HAVE FAILED.
      await waitFor(() => expect(window.api.contacts.import).toHaveBeenCalled());
      const [, records] = jest.mocked(window.api.contacts.import).mock.calls[0];
      expect(records).toHaveLength(1);
      expect((records[0] as any).id).toBe(spec.record.id);

      // The form must NOT open. This is also how "no banner for the name case"
      // is satisfied structurally rather than by discipline — there is no form
      // to put an affordance on.
      expect(screen.queryByRole("button", { name: /update contact/i })).not.toBeInTheDocument();
    },
  );

  /**
   * The card re-renders on the handler's RETURN, whose `display_name` is `""`.
   * A card that crashed or went blank on that would be the BACKLOG-2461 defect
   * arriving by a new route, and an assertion on the mock call alone would miss
   * it entirely.
   */
  it("the card survives re-rendering on a contact whose display_name is empty", async () => {
    install(RECORDS[0].record);
    await openCard(RECORDS[0].label);

    await userEvent.click(await screen.findByTestId("contact-preview-import"));
    await waitFor(() => expect(window.api.contacts.import).toHaveBeenCalled());

    await waitFor(() =>
      expect(screen.getByTestId("contacts-detail-pane")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("contact-preview-name")).toBeInTheDocument();
  });

  /**
   * The founder's ruling `a41a805b` in the form he will see it: a company-only
   * record is refused BEFORE the click, with a reason that reads true beside the
   * label its own row renders — which is the company name.
   */
  it("company-only — disabled before the click, with a reason true of its row", async () => {
    const spec = RECORDS.find((r) => r.key === "company-only")!;
    install(spec.record);
    await openCard(spec.label);

    const blocked = await screen.findByTestId("contact-preview-import-blocked");
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(blocked).toHaveTextContent(COMPANY_ONLY_IMPORT_REASON);

    // The row is labelled with the company, so "nothing to import" would be
    // false to the person reading it. That contradiction is the defect this
    // item is named after, one layer down.
    expect(screen.getAllByText(spec.label).length).toBeGreaterThan(0);
    expect(blocked).not.toHaveTextContent(/nothing to import/i);

    await userEvent.click(blocked);
    expect(window.api.contacts.import).not.toHaveBeenCalled();
  });
});
