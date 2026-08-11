/**
 * BACKLOG-2662 — the Clients & Contacts header names every source it counts.
 *
 * ===========================================================================
 * THE FOUNDER'S READING, AND WHY THE BEFORE/AFTER IS THE EVIDENCE
 * ===========================================================================
 * Gate 3, 11 Aug, on a clean re-import. The header read:
 *
 *     1173 contacts (1171 from Contacts App)
 *
 * The database at that moment held 1,166 `macos` records and 5 `outlook`
 * records. All five Outlook records were being credited to the Contacts App.
 *
 * Minutes EARLIER, before the Outlook sync, the same header read `1168 contacts
 * (1166 from Contacts App)` — tracking the macOS count exactly, while there was
 * nothing to mislabel. That pair is stronger than either reading alone, and it
 * is why this file has BOTH a two-source case (the bug) and a one-source case
 * (the regression guard). A fix that only satisfied the first could be a
 * rewrite of a string that was already right for the second.
 *
 * ===========================================================================
 * WHY THE COMPONENT AND NOT ONLY THE UTIL
 * ===========================================================================
 * `contactSourceBreakdown.test.ts` covers the partition. It does NOT go red if
 * someone restores `` (${externalContacts.length} from Contacts App)`` in
 * `Contacts.tsx`, because that revert never calls the util. The header string is
 * what the founder read, so the header string is what is asserted here — on the
 * real screen, through the real `useContactDirectory` hook, over the real IPC
 * channels.
 *
 * ===========================================================================
 * FIXTURE FIDELITY — TRANSCRIBED, NOT INVENTED
 * ===========================================================================
 * The `contacts:get-available` fixtures below are shaped as
 * `contactHandlers.ts` emits them (the `availableContacts.push({...})` for a
 * shadow-table row): `isFromDatabase: false`, and `source` ALREADY FOLDED through
 * `toPersistedContactSource`, which is why a macOS record arrives as
 * `contacts_app` and not `macos`. They deliberately do NOT carry
 * `is_message_derived` — `useContactDirectory.fetchExternalContacts` stamps
 * `is_message_derived: true` onto every row it receives, and this test mounts the
 * real hook, so writing it into the fixture would describe a payload the main
 * process never sends and would hide a partition keyed on that flag.
 *
 * Row COUNTS are scaled down (tens, not 1,173): `ContactSearchList` is not
 * virtualised, so a faithful fixture renders 1,173 rows into jsdom and the suite
 * does not finish. The founder's literal numbers and his exact header strings
 * are pinned in `src/utils/__tests__/contactSourceBreakdown.test.ts`, which runs
 * the same partition without a DOM. What is scaled is the size of the fixture;
 * the SHAPE — two external sources plus saved rows, total exceeding the external
 * count by exactly two — is his.
 *
 * ===========================================================================
 * THE TWO EXTRA RECORDS
 * ===========================================================================
 * 1173 against 1171 external records. The total is the RENDERED row count
 * (`assembleContacts(contacts, externalContacts)` — a concat that drops only
 * exactly-repeated ids since BACKLOG-2370 deleted the dedup stage), so the extra
 * rows come from the SAVED half, `contacts:get-all`.
 *
 * They cannot be message-derived pseudo-contacts under the default filter:
 * `defaultSourceSelection()` leaves the whole Inferred group OFF, and
 * `messages`/`sms`/`email`/`inferred` reach no other leaf, so those rows are
 * filtered out of `visibleCount` before it is reported. The two extras are
 * therefore rows in the local `contacts` table with a non-inferred source. The
 * `theTwoExtraRecords` case pins exactly that, including the negative half.
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

const mockUserId = "user-123";

/** Installs the wide-layout matchMedia jsdom does not provide. */
function installMatchMedia(): void {
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

/**
 * One row as `contacts:get-available` emits it for a shadow-table record.
 * `source` is the POST-fold value (`macos` -> `contacts_app`), matching the
 * handler.
 */
function externalRow(i: number, source: string): Contact {
  return {
    id: `ext-${source}-${i}`,
    name: `External ${source} ${i}`,
    phone: `555-01${String(i).padStart(2, "0")}`,
    email: `ext-${source}-${i}@example.com`,
    company: null,
    source,
    isFromDatabase: false,
    allPhones: [],
    allEmails: [],
    last_communication_at: null,
    externalRecordId: `rec-${source}-${i}`,
    externalSourceType: source === "contacts_app" ? "macos" : source,
    externalUuid: null,
  } as unknown as Contact;
}

/** One row as `contacts:get-all` emits it from the local `contacts` table. */
function savedRow(id: string, name: string, source: string): Contact {
  return {
    id,
    name,
    display_name: name,
    email: `${id}@example.com`,
    phone: null,
    source,
    is_message_derived: 0,
    is_imported: 1,
  } as unknown as Contact;
}

/** A message-derived pseudo-contact, as `messageDerivedAsContacts` synthesises it. */
function messageDerivedRow(id: string, name: string): Contact {
  return {
    id,
    name,
    display_name: name,
    email: null,
    phone: null,
    source: "messages",
    is_message_derived: 1,
  } as unknown as Contact;
}

function externals(source: string, n: number): Contact[] {
  return Array.from({ length: n }, (_, i) => externalRow(i, source));
}

function headerText(): string {
  return screen.getByTestId("contacts-header-count").textContent ?? "";
}

async function renderScreen(opts: {
  saved: Contact[];
  available: Contact[];
}): Promise<void> {
  jest.mocked(window.api.contacts.getAll).mockResolvedValue({
    success: true,
    contacts: opts.saved,
  } as never);
  jest.mocked(window.api.contacts.getAvailable).mockResolvedValue({
    success: true,
    contacts: opts.available,
  } as never);

  render(<Contacts userId={mockUserId} onClose={jest.fn()} />);
}

describe("BACKLOG-2662 — the header names each source with its own count", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    installMatchMedia();
    jest.mocked(window.api.contacts.checkCanDelete).mockResolvedValue({
      success: true,
      transactions: [],
    } as never);
  });

  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  /**
   * CONTROL 1 — THE BUG.
   *
   * Records from two sources. The header must name both.
   *
   * CONTROL RUN: restore the original line in `Contacts.tsx`
   *   {externalContacts.length > 0 && ` (${externalContacts.length} from Contacts App)`}
   * OBSERVED: this test fails —
   *   Expected " (8 from Contacts App, 3 from Outlook)"
   *   Received " (11 from Contacts App)"
   * which is the founder's defect reproduced in miniature: three Outlook records
   * absorbed into the Contacts App's name. The one-source case below stays green
   * under the same revert, which is what makes this pair evidence.
   */
  it("names both sources when records come from two [CONTROL]", async () => {
    await renderScreen({
      saved: [],
      available: [...externals("contacts_app", 8), ...externals("outlook", 3)],
    });

    await waitFor(() => {
      expect(headerText()).toBe("11 contacts (8 from Contacts App, 3 from Outlook)");
    });
  });

  /**
   * CONTROL 2 — THE REGRESSION GUARD, and the state that HID the bug.
   *
   * One source, nothing to mislabel. The string must be what the founder read
   * minutes before the Outlook sync, byte for byte. Asserted as the whole
   * `textContent` rather than `toContain`, so an extra segment, a changed
   * preposition or a stray space fails it.
   *
   * CONTROL RUN: with the pre-fix `Contacts.tsx` line restored this test PASSES
   * — deliberately. A regression guard that goes red on the revert is not
   * guarding the old behaviour, it is asserting the new one twice.
   */
  it("is unchanged from today when every record has one source", async () => {
    await renderScreen({ saved: [], available: externals("contacts_app", 12) });

    await waitFor(() => {
      expect(headerText()).toBe("12 contacts (12 from Contacts App)");
    });
  });

  /**
   * CONTROL 3 — THE ARITHMETIC.
   *
   * The per-source counts sum to the total shown, and the total equals the
   * fixture the mocked IPC channels returned — i.e. against the data, not
   * against another part of the UI. Parsed back out of the rendered string so
   * this reads the same characters the founder read.
   *
   * The pre-fix code fails this by construction: its parenthetical is the raw
   * `get-available` length and its total is the rendered row count, so the two
   * are only ever equal by accident.
   */
  it("the per-source counts sum to the total, and the total is the data", async () => {
    const saved = [savedRow("saved-1", "Madison Reeves", "manual")];
    const available = [...externals("contacts_app", 6), ...externals("outlook", 2)];

    await renderScreen({ saved, available });

    await waitFor(() => expect(headerText()).toMatch(/^9 contacts \(/));

    const text = headerText();
    const total = Number(/^(\d+) contacts/.exec(text)?.[1]);
    const parts = [...text.matchAll(/(\d+) from /g)].map((m) => Number(m[1]));

    expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    expect(total).toBe(saved.length + available.length);
    expect(total).toBe(9);
  });

  /**
   * CONTROL 4 — THE TWO-RECORD GAP, IDENTIFIED.
   *
   * The founder's shape, scaled: external records from two sources PLUS the two
   * saved rows that made 1173 out of 1171. The assertion names all three
   * populations and tolerates no remainder — there is no `toContain`, no
   * `expect.any`, and no arithmetic that would still pass with two rows
   * unaccounted for.
   *
   * The negative half is the point: a message-derived pseudo-contact is ALSO in
   * `contacts:get-all`, and it must NOT appear, because `defaultSourceSelection`
   * leaves the Inferred group off and `messages` reaches no other leaf. That is
   * what rules message-derived rows out as the founder's two extras — under his
   * default filters they could not have been counted in the 1173 at all.
   */
  it("accounts for the saved rows that made the total exceed the external count", async () => {
    await renderScreen({
      saved: [
        savedRow("saved-1", "Madison Reeves", "manual"),
        savedRow("saved-2", "Tad Brennan", "manual"),
        messageDerivedRow("derived-1", "Someone Who Texted"),
      ],
      available: [...externals("contacts_app", 9), ...externals("outlook", 5)],
    });

    await waitFor(() => {
      expect(headerText()).toBe(
        "16 contacts (9 from Contacts App, 5 from Outlook, 2 from Manual)",
      );
    });

    // Stated separately so the reason is legible in the failure: the
    // message-derived row is filtered out, not merged into another segment.
    expect(headerText()).not.toContain("From Texts");
  });

  /**
   * A DELIBERATE BEHAVIOUR CHANGE OUTSIDE THE REPORTED SYMPTOM — PINNED SO IT
   * READS AS A CHOICE AND NOT AS AN ACCIDENT.
   *
   * The old gate was `externalContacts.length > 0`, so a user with saved
   * contacts and no address book connected saw a bare `2 contacts`. The gate is
   * now "any rows at all", and that user sees `2 contacts (2 from Manual)`.
   *
   * Chosen for consistency: it is the same sentence the founder already reads
   * and accepted (`1166 contacts (1166 from Contacts App)`), and suppressing it
   * would mean special-casing which sources are worth naming — the exact class
   * of judgement that produced this bug, where one source was quietly decided to
   * stand for all of them.
   *
   * NO CONTROL REVERTS THIS. It is not a defect being fixed, it is a delta being
   * recorded. Without this test the change is indistinguishable, six months from
   * now, from someone having dropped the old gate by mistake.
   */
  it("names the source even when no address book is connected [DELIBERATE DELTA]", async () => {
    await renderScreen({
      saved: [
        savedRow("saved-1", "Madison Reeves", "manual"),
        savedRow("saved-2", "Tad Brennan", "manual"),
      ],
      available: [],
    });

    await waitFor(() => {
      expect(headerText()).toBe("2 contacts (2 from Manual)");
    });
  });

  /**
   * The one state that still says nothing: no contacts at all. Pinned beside the
   * case above so "no parenthetical" is not read as the general rule for an
   * empty address book.
   */
  it("says nothing about sources when there are no contacts at all", async () => {
    await renderScreen({ saved: [], available: [] });

    await waitFor(() => {
      expect(headerText()).toBe("0 contacts");
    });
  });

  /**
   * The header's total already honoured search and filters; its parenthetical
   * did not. Pinned because it is the second half of the same defect and the
   * cheapest way for it to come back.
   */
  it("the breakdown narrows with the list, not with the raw payload", async () => {
    await renderScreen({
      saved: [],
      available: [...externals("contacts_app", 4), ...externals("outlook", 2)],
    });

    await waitFor(() => {
      expect(headerText()).toBe("6 contacts (4 from Contacts App, 2 from Outlook)");
    });

    const search = screen.getByTestId("contact-search-input") as HTMLInputElement;
    await userEvent.type(search, "External outlook");

    await waitFor(() => {
      expect(headerText()).toBe("2 contacts (2 from Outlook)");
    });
  });
});
