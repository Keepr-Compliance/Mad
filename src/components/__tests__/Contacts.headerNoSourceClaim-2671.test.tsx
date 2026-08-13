/**
 * THE CONTACTS HEADER MAKES NO CLAIM ABOUT SOURCES — BACKLOG-2671
 *
 * ===========================================================================
 * WHAT THIS REPLACES, AND WHY THE REPLACEMENT IS NOT A RETREAT
 * ===========================================================================
 * This file takes over from `Contacts.sourceBreakdown-2662.test.tsx`, which is
 * DELETED along with the module it guarded. That suite asserted the header names
 * every source — `1175 contacts (1168 from Contacts App, 5 from Outlook, 2 from
 * From Texts)`. It shipped, it was correct, and the founder then ruled against
 * the shape: the sentence grows with each connected source, so it crowded the
 * "Review N possible duplicates" button beside it. The counts moved into the
 * source filter dropdown (`contactSourceCounts.ts`, and
 * `ContactSearchList.sourceCounts-2671.test.tsx`, which is where "the numbers
 * are true" is now proved).
 *
 * The guard that must survive that move is the ORIGINAL defect, and it is the
 * opposite of what 2662's suite asserted:
 *
 *     1175 contacts (1175 from Contacts App)
 *
 * — every record credited to one provider, the founder's five Outlook contacts
 * among them. His ruling is explicit that a header with NO source claim is fine
 * and a header with a WRONG one is not. So this suite asserts the absence of any
 * source claim at all, against fixtures whose sources differ. A parenthetical
 * cannot come back — right or wrong — without one of these going red.
 *
 * ===========================================================================
 * WHAT THE LAYOUT HALF CAN AND CANNOT PROVE. READ BEFORE TRUSTING IT.
 * ===========================================================================
 * jsdom has NO layout engine: every box is 0x0, `getBoundingClientRect` returns
 * zeros, media queries do not evaluate and Tailwind classes resolve to nothing.
 * So this file CANNOT prove the review button is unobscured at 375px. Same limit
 * `EditContactsModal.footerNotFloating-2639.test.tsx` documents for the same
 * class of defect one screen over.
 *
 * It proves the two structural properties that make the overlap impossible:
 *
 *   1. INVARIANCE — the header's text is byte-identical at 2, 3 and 4 sources.
 *      The growth vector is gone, so the count cannot displace the button no
 *      matter how many address books are connected. This is stronger than a
 *      measurement at three widths: it is the reason no width matters.
 *   2. WHO GIVES WAY — the review button is `flex-shrink-0 whitespace-nowrap`
 *      and the title block is `min-w-0`. Before, both children of the flex row
 *      were shrinkable and the row squeezed whichever it reached first. Now the
 *      action keeps its box and the title absorbs the loss.
 *
 * **A real-width sweep in a browser is NOT performed here and is owed at UAT.**
 */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
 * One row as `contacts:get-available` emits it — the `macos` -> `contacts_app`
 * fold already applied, matching `contactHandlers`. Transcribed from the shape
 * BACKLOG-2662's suite used against the same producer.
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

function externals(source: string, n: number): Contact[] {
  return Array.from({ length: n }, (_, i) => externalRow(i, source));
}

const headerText = (): string =>
  screen.getByTestId("contacts-header-count").textContent ?? "";

/**
 * Renders the screen with `n` DISTINCT address-book sources present, all of them
 * default-ON leaves so every row reaches the list under the default filter.
 * `reviewQueueCount` is stubbed above zero because the review button is hidden
 * at zero by design (BACKLOG-2410) and a layout assertion against an absent
 * element proves nothing.
 */
async function renderWithSources(sourceCounts: Array<[string, number]>): Promise<void> {
  const available = sourceCounts.flatMap(([source, n]) => externals(source, n));

  jest.mocked(window.api.contacts.getAll).mockResolvedValue({
    success: true,
    contacts: [],
  } as never);
  jest.mocked(window.api.contacts.getAvailable).mockResolvedValue({
    success: true,
    contacts: available,
  } as never);
  jest.mocked(window.api.contacts.getReviewQueueCount).mockResolvedValue({
    success: true,
    count: 12,
  } as never);

  render(<Contacts userId={mockUserId} onClose={jest.fn()} />);

  await waitFor(() => {
    expect(screen.getByTestId("review-duplicates-button")).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(headerText()).toMatch(/\d+ contacts/);
  });
}

/** The four default-ON address-book sources, in the order they get added. */
const SOURCES: Array<[string, number]> = [
  ["contacts_app", 6],
  ["outlook", 5],
  ["google_contacts", 3],
  ["iphone", 2],
];

const withNSources = (n: number): Array<[string, number]> => SOURCES.slice(0, n);
const totalOf = (spec: Array<[string, number]>): number =>
  spec.reduce((sum, [, n]) => sum + n, 0);

describe("BACKLOG-2671 — the header states a count and nothing about sources", () => {
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
   * THE REGRESSION GUARD. `1175 contacts (1175 from Contacts App)` is the
   * original defect; `1175 contacts (6 from Contacts App, 5 from Outlook)` is
   * the shape the founder ruled out of the header. The assertion is an EXACT
   * match on "<n> contacts", so both die here, and so does any third
   * parenthetical nobody has thought of yet.
   */
  it.each([2, 3, 4])(
    "says only '<n> contacts' with %i sources present — no parenthetical, right or wrong",
    async (n) => {
      const spec = withNSources(n);
      await renderWithSources(spec);

      expect(headerText().trim()).toBe(`${totalOf(spec)} contacts`);
      expect(headerText()).not.toMatch(/from/i);
      expect(headerText()).not.toContain("(");
    },
  );

  it("says nothing about sources when every record has ONE source — the state that hid the bug", async () => {
    await renderWithSources([["contacts_app", 7]]);

    // The old header's single-source string was ` (7 from Contacts App)`, which
    // read correctly and is exactly why the defect survived so long. It is gone
    // too: the ruling was about the header, not about whether the sentence
    // happened to be true.
    expect(headerText().trim()).toBe("7 contacts");
  });

  /**
   * INVARIANCE — property 1. The header text is the SAME at 2, 3 and 4 sources
   * once the row count is held constant, so it cannot grow into the button.
   *
   * Held constant by construction: each spec below totals nine rows across a
   * different number of sources. If a breakdown ever returns, these three
   * strings diverge and this goes red — which is the layout regression, caught
   * without a layout engine.
   */
  it("renders an identical header at 2, 3 and 4 sources when the total is the same", async () => {
    const specs: Array<Array<[string, number]>> = [
      [["contacts_app", 6], ["outlook", 3]],
      [["contacts_app", 4], ["outlook", 3], ["google_contacts", 2]],
      [["contacts_app", 3], ["outlook", 3], ["google_contacts", 2], ["iphone", 1]],
    ];

    const texts: string[] = [];
    for (const spec of specs) {
      await renderWithSources(spec);
      texts.push(headerText().trim());
      cleanup();
    }

    expect(texts).toEqual(["9 contacts", "9 contacts", "9 contacts"]);
  });
});

describe("BACKLOG-2671 — which control gives way when the header runs out of room", () => {
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
   * STRUCTURE, NOT PIXELS — property 2, and the limit is stated in the docblock
   * above. Before BACKLOG-2671 both children of the header's flex row were
   * shrinkable, so the row resolved an overflow by squeezing whichever it
   * reached first; that is how a growing count line came to displace the review
   * action. These two classes decide the outcome instead of leaving it to
   * whichever child the layout reached first.
   */
  it.each([2, 3, 4])(
    "with %i sources, the review button cannot be shrunk or wrapped and the title block absorbs the loss",
    async (n) => {
      await renderWithSources(withNSources(n));

      const button = screen.getByTestId("review-duplicates-button");
      expect(button.className).toContain("flex-shrink-0");
      expect(button.className).toContain("whitespace-nowrap");

      const titleBlock = screen.getByTestId("contacts-header-title-block");
      expect(titleBlock.className).toContain("min-w-0");
    },
  );

  it("keeps the button and the count in the same flex row, so neither can overlay the other", async () => {
    await renderWithSources(withNSources(3));

    const button = screen.getByTestId("review-duplicates-button");
    const titleBlock = screen.getByTestId("contacts-header-title-block");

    // Same parent: both participate in ONE layout. A control that overlays
    // another is one that left the flow — the BACKLOG-2639 shape, where a
    // `fixed` copy painted over a save button.
    expect(button.parentElement).toBe(titleBlock.parentElement);
    expect(button.className).not.toContain("fixed");
    expect(button.className).not.toContain("absolute");
  });

  it("still shows the narrow-width short label, so the button is small when room is scarce", async () => {
    await renderWithSources(withNSources(4));

    const button = screen.getByTestId("review-duplicates-button");
    // Two labels, one per breakpoint (`hidden sm:inline` / `sm:hidden`). jsdom
    // cannot evaluate which is visible; what it CAN prove is that the short one
    // still exists, which is the thing that keeps the button narrow at 375px.
    expect(button.textContent).toContain("Review 12 possible duplicates");
    expect(button.textContent).toContain("Review 12");
  });
});
