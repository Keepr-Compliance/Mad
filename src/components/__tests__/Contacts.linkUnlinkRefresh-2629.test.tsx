/**
 * MANUAL LINK AND UNLINK REFRESH THE CONTACTS LIST TOO (BACKLOG-2629).
 *
 * ===========================================================================
 * THE DEFECT, REPRODUCED BY THE FOUNDER ON 2026-08-10
 * ===========================================================================
 * He manually linked Petra Lindqvist to Bianca Okafor. The link succeeded and
 * appeared on Bianca's card — **and Petra was still listed as her own row**,
 * with a card reading "not imported".
 *
 * It is BACKLOG-2627's defect on two more paths. Both change which records
 * `contacts:get-available` should suppress — a manual link WRITES a
 * `contact_source_links` row, an unlink DELETES one — and both refreshed only
 * the SAVED half via `silentLoadContacts()`. `loadExternalContacts` holds a
 * once-per-mount guard (`useContactList.ts` — `externalContactsLoadedRef`), so
 * the address-book half was never asked again for the life of the mount.
 *
 * ===========================================================================
 * WHY THE FIX IS A REUSE AND NOT A FUNCTION
 * ===========================================================================
 * 2627 introduced `refreshBothLists()` — fetch both, commit both in ONE render
 * (BACKLOG-2526). These are its third and fourth callers. Its own docblock:
 * *"leaving a second, subtly different refresh exported is how the split commit
 * comes back."* No variant was added.
 *
 * ===========================================================================
 * WHY IT COST MORE THAN AN ANNOYANCE
 * ===========================================================================
 * A stale list cannot be told apart from a broken fix by looking at it, and the
 * same session read one as the other twice — once reporting a working fix as
 * failed, once nearly filing a bug that did not exist.
 *
 * ===========================================================================
 * EVERY ASSERTION IS AN ID SET, NEVER A COUNT
 * ===========================================================================
 * Link removes a row and unlink restores one — opposite directions, and a count
 * agrees with a build that moved the wrong row. Every assertion reads
 * `data-contact-id` off `ContactRow` and compares the SET.
 *
 * The mocked second `getAvailable` is the main process's behaviour transcribed,
 * not wished for: `contact_source_links` is what
 * `contacts:get-available` suppresses on, pinned by execution in
 * `electron/__tests__/contact-handlers.stopHidingRecords-2608.test.ts`
 * (CONTROL 2 — a linked record leaves the list; CONTROL 3 — a rejected one
 * stays). Linking writes that row, unlinking deletes it.
 */

import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Contacts from "../Contacts";
import type { Contact } from "../../../electron/types/models";
import type { ContactSourceProvenance } from "@/types/contactProvenance";

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

const USER_ID = "user-2629";

const BIANCA_ID = "b1a9c7e5-3d2f-4a6b-8c0d-1e2f3a4b5c6d";
const PETRA_ROW_ID = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";
const BYSTANDER_ROW_ID = "2c4e6a80-1b3d-4f5a-9e7c-8d0b1a2c3e4f";
const PETRA_RECORD_ID = "AB-RECORD-7781";
const PETRA_LINK_ID = "link-petra-1";
const ORIGIN_LINK_ID = "link-bianca-origin";

/** The saved contact the record is attached to. Present throughout. */
const savedBianca = {
  id: BIANCA_ID,
  user_id: USER_ID,
  name: "Bianca Okafor",
  display_name: "Bianca Okafor",
  email: "bianca@example.com",
  phone: "+15035550130",
  source: "manual",
  is_imported: 1,
  created_at: "2026-08-01T09:00:00Z",
  updated_at: "2026-08-01T09:00:00Z",
} as unknown as Contact;

/**
 * The address-book record he linked, exactly as `contacts:get-available` emits
 * it — identity fields included, which is what the link is written against.
 */
const petraRecord = {
  id: PETRA_ROW_ID,
  name: "Petra Lindqvist",
  display_name: "Petra Lindqvist",
  email: "petra@example.com",
  phone: "+15035550144",
  company: "Northshore Title",
  source: "contacts_app",
  allEmails: ["petra@example.com"],
  allPhones: ["+15035550144"],
  isFromDatabase: false,
  externalRecordId: PETRA_RECORD_ID,
  externalSourceType: "macos",
  externalUuid: "5e1c9a2b-77d4-4f60-b8a1-3d7e2f0c4a99",
} as unknown as Contact;

/**
 * A record nobody touched. It is in the list before and after every action,
 * which separates "the acted-on record moved" from "the address book was
 * cleared" — a refresh that emptied the external half would satisfy every link
 * assertion here and be far worse than the defect.
 */
const bystanderRecord = {
  ...(petraRecord as unknown as Record<string, unknown>),
  id: BYSTANDER_ROW_ID,
  name: "Marek Tull",
  display_name: "Marek Tull",
  email: "marek@example.com",
  allEmails: ["marek@example.com"],
  phone: "+15035550152",
  allPhones: ["+15035550152"],
  company: "Tull Surveying",
  externalRecordId: "AB-RECORD-9902",
} as unknown as Contact;

/**
 * Bianca's sources AFTER the link — two rows, because `ContactPreview` renders
 * no provenance panel below two, and the unlink button is suppressed on the
 * single record a contact was created from (BACKLOG-2510).
 */
/*
  TYPED AGAINST THE PRODUCER'S OWN INTERFACE, not cast into place. `sourceType`
  and `matchMethod` are unions, so a fixture that drifted off either fails
  `type-check:tests` rather than quietly describing a row `getSources` cannot
  emit — the 2026-08-04 failure shape.
*/
const sourcesWithPetra: ContactSourceProvenance[] = [
  {
    linkId: ORIGIN_LINK_ID,
    sourceType: "macos",
    sourceLabel: "Mac address book",
    sourceName: "Bianca Okafor",
    matchDescription: "Recognised by its own entry in your Mac address book",
    matchMethod: "source_id",
    sourceRecordPresent: true,
    matchedAt: "2026-08-01T09:00:00Z",
    lastSyncedAt: "2026-08-10T08:00:00Z",
  },
  {
    linkId: PETRA_LINK_ID,
    sourceType: "macos",
    sourceLabel: "Mac address book",
    sourceName: "Petra Lindqvist",
    matchDescription: "You confirmed this yourself",
    matchMethod: "manual",
    sourceRecordPresent: true,
    matchedAt: "2026-08-10T09:00:00Z",
    lastSyncedAt: "2026-08-10T08:00:00Z",
  },
];

/** Every row the list is rendering, as ids. IDENTITY, never a count. */
function renderedContactIds(): string[] {
  return screen
    .queryAllByTestId("contact-row")
    .map((row) => row.getAttribute("data-contact-id") ?? "")
    .sort();
}

/**
 * Wire both halves to behave the way the main process does.
 *
 * `linked` is the state the real writers key on — `contacts:link-source` writes
 * the crosswalk row and `contacts:unlink-source` deletes it, and
 * `contacts:get-available` suppresses on that table. Keyed on STATE rather than
 * on a call ordinal, for the reason BACKLOG-2627's suite records: an ordinal
 * mock encodes a call COUNT where the producer encodes a STATE, and breaks the
 * moment a second consumer reads the same channel.
 */
function installBackend(options: { startLinked: boolean }) {
  let linked = options.startLinked;

  jest
    .mocked(window.api.contacts.getAll)
    .mockResolvedValue({ success: true, contacts: [savedBianca] });

  jest.mocked(window.api.contacts.getAvailable).mockImplementation(async () => ({
    success: true,
    // Linked => Petra is suppressed, because a crosswalk row now stands for her.
    contacts: linked ? [bystanderRecord] : [petraRecord, bystanderRecord],
  }));

  jest.mocked(window.api.contacts.getSources).mockImplementation(async () => ({
    success: true,
    sources: linked ? sourcesWithPetra : [sourcesWithPetra[0]],
  }));

  jest.mocked(window.api.contacts.findLinkableSources).mockResolvedValue({
    success: true,
    records: [
      {
        sourceType: "macos",
        sourceRecordId: PETRA_RECORD_ID,
        name: "Petra Lindqvist",
        emails: ["petra@example.com"],
        phones: ["+15035550144"],
        company: "Northshore Title",
        sourceLabel: "Mac address book",
        priorRejection: false,
      },
    ],
  } as never);

  jest.mocked(window.api.contacts.linkSource).mockImplementation(async () => {
    linked = true;
    return {
      success: true,
      // `LinkSourceOutcome`, transcribed from `contactManualLink.ts:132` —
      // one outcome per input record, in the same order.
      outcomes: [{ ok: true, linkId: PETRA_LINK_ID }],
    } as never;
  });

  jest.mocked(window.api.contacts.unlinkSource).mockImplementation(async () => {
    linked = false;
    return { success: true } as never;
  });

  jest
    .mocked(window.api.contacts.getReviewQueueCount)
    .mockResolvedValue({ success: true, count: 0 });
  jest
    .mocked(window.api.contacts.getReviewQueue)
    .mockResolvedValue({ success: true, clusters: [] });
  jest
    .mocked(window.api.contacts.checkCanDelete)
    .mockResolvedValue({ success: true, transactions: [] });
}

/**
 * Open Bianca's card by clicking her row — the way the founder got there.
 *
 * She has no open questions in these fixtures, so the click opens the CARD
 * rather than the filtered duplicates screen (BACKLOG-2626). That is deliberate:
 * this suite is about the list behind the card, and routing through the queue
 * would be testing 2627's path again.
 */
async function openBiancasCard() {
  const row = screen
    .getAllByTestId("contact-row")
    .find((r) => r.getAttribute("data-contact-id") === BIANCA_ID) as HTMLElement;
  await userEvent.click(row);
  await screen.findByTestId("contact-preview-modal");
}

beforeEach(() => {
  jest.clearAllMocks();
  installMatchMedia(false);
});

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe("BACKLOG-2629 — manual link and unlink move the list too", () => {
  /**
   * CONTROL 7a — THE FOUNDER'S CASE, EXACTLY.
   *
   * He linked Petra to Bianca and Petra stayed listed as her own row. After the
   * fix she leaves the list the moment the link is written, with the card still
   * open behind — no navigation, no remount.
   *
   * OBSERVED RED: reverting `onLinked` to `silentLoadContacts()` leaves
   * `PETRA_ROW_ID` in the set — `contacts:get-available` is never asked a second
   * time (the once-per-mount guard), which is the defect verbatim.
   */
  it("takes the linked record off the list WITHOUT navigating away", async () => {
    installBackend({ startLinked: false });
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);

    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [BIANCA_ID, PETRA_ROW_ID, BYSTANDER_ROW_ID].sort(),
      ),
    );

    await openBiancasCard();
    await userEvent.click(screen.getByTestId("contact-preview-link"));
    const picker = await screen.findByTestId("link-source-search");

    /*
      SCOPED TO THE PICKER. Petra is on screen TWICE at this moment — as her own
      row in the list behind, and as a linkable record inside the picker — which
      is the defect stated as a DOM fact. An unscoped query would resolve to
      whichever came first and the test would be about the wrong element.
    */
    await userEvent.click(
      within(picker).getByText("Petra Lindqvist", {
        selector: '[data-testid="contact-row-name"]',
      }),
    );
    await userEvent.click(await screen.findByTestId("link-source-commit"));

    await waitFor(() => expect(window.api.contacts.linkSource).toHaveBeenCalled());

    // Petra is GONE and the bystander is not — the address book was refreshed,
    // not emptied. Bianca stays: a link attaches a record to an existing
    // contact, it does not create or remove one.
    await waitFor(() =>
      expect(renderedContactIds()).toEqual([BIANCA_ID, BYSTANDER_ROW_ID].sort()),
    );
    expect(renderedContactIds()).not.toContain(PETRA_ROW_ID);

    // Nothing unmounted the list to achieve it. This is the screen he was on.
    expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument();
  });

  /**
   * THE MECHANISM, STATED ON ITS OWN, because it is the only reason the
   * assertion above can pass.
   *
   * `loadExternalContacts` refuses to refetch for the life of the mount, so a
   * second `contacts:get-available` happens ONLY if the link path deliberately
   * went through `refreshBothLists`. Asserting the SAVED half was refreshed in
   * the same breath is what distinguishes `refreshBothLists` from a bare
   * `reloadExternalContacts` — 2526's split-commit defect, which this must not
   * reintroduce.
   */
  it("asks the ADDRESS BOOK again on link, together with the saved half", async () => {
    installBackend({ startLinked: false });
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(1));
    const savedReadsBefore = jest.mocked(window.api.contacts.getAll).mock.calls.length;

    await openBiancasCard();
    await userEvent.click(screen.getByTestId("contact-preview-link"));
    const picker = await screen.findByTestId("link-source-search");
    await userEvent.click(
      within(picker).getByText("Petra Lindqvist", {
        selector: '[data-testid="contact-row-name"]',
      }),
    );
    await userEvent.click(await screen.findByTestId("link-source-commit"));

    await waitFor(() => expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(2));
    expect(jest.mocked(window.api.contacts.getAll).mock.calls.length).toBeGreaterThan(
      savedReadsBefore,
    );
  });

  /**
   * CONTROL 7b — UNLINK, THE MIRROR IMAGE.
   *
   * Detaching a record deletes the crosswalk row that was suppressing it, so it
   * must come BACK as its own row — and it must come back without navigating,
   * for the same reason the link case must leave without navigating.
   *
   * OBSERVED RED: reverting `handleUnlinkSource` to `silentLoadContacts()` never
   * re-asks the address book, so `PETRA_ROW_ID` never returns to the set.
   */
  it("brings the unlinked record BACK to the list without navigating away", async () => {
    installBackend({ startLinked: true });
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);

    await waitFor(() =>
      expect(renderedContactIds()).toEqual([BIANCA_ID, BYSTANDER_ROW_ID].sort()),
    );

    await openBiancasCard();
    await userEvent.click(
      await screen.findByTestId(`contact-source-unlink-${PETRA_LINK_ID}`),
    );

    await waitFor(() => expect(window.api.contacts.unlinkSource).toHaveBeenCalled());

    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [BIANCA_ID, PETRA_ROW_ID, BYSTANDER_ROW_ID].sort(),
      ),
    );
    expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument();
  });

  /**
   * THE SAVED HALF IS STILL REFRESHED ON UNLINK, for the reason the original
   * code gave and which has NOT gone away: unlinking can take back the emails
   * and phones the link copied across, so a stale saved list keeps showing a
   * rejected person's address.
   *
   * `refreshBothLists` does both. This asserts the half that was already right
   * did not get lost while fixing the half that was wrong — the failure mode of
   * swapping one single-sided refresh for a different single-sided refresh.
   */
  it("refreshes the saved half on unlink as well, in the same call", async () => {
    installBackend({ startLinked: true });
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(1));
    const savedReadsBefore = jest.mocked(window.api.contacts.getAll).mock.calls.length;

    await openBiancasCard();
    await userEvent.click(
      await screen.findByTestId(`contact-source-unlink-${PETRA_LINK_ID}`),
    );

    await waitFor(() => expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(2));
    expect(jest.mocked(window.api.contacts.getAll).mock.calls.length).toBeGreaterThan(
      savedReadsBefore,
    );
  });
});
