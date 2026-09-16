/**
 * =============================================================================
 * BACKLOG-3376 — THE CLIENTS & CONTACTS CARD SAYS WHAT IT SAVED THAT NO EMAIL
 * CAN COME FROM
 * =============================================================================
 * BACKLOG-3358 stopped an address the app cannot validate from blocking an
 * import, so the contact now saves with the value as the address book has it —
 * and nothing said so. An address with a space in it can never equal a
 * participant address, so mail from it will never link to a deal, and the user
 * had no way to find that out.
 *
 * The main process returns the addresses on the SUCCESS response
 * (`ContactResponse.unmatchableEmails`); this screen raises one `info` toast
 * naming them, inside the success branch and before the refresh is awaited.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS A NEW FILE AND WHY EVERY QUERY SAYS `notification-info`
 * -----------------------------------------------------------------------------
 * `NotificationToast` builds its testid from the notification TYPE, so an info
 * toast renders `notification-info`. BACKLOG-3354's suites query
 * `notification-error` only — they are honestly named ("no ERROR toast") and
 * simply cannot see this message. Measured twice, independently, before a line
 * of this was written: an unconditional `notify?.info(...)` in both success
 * branches left both 3354 suites at 15 passed / 15, and the same mutation with
 * the helper pointed at `notification-info` went red (plan `d28dea34` P2/P3; SR
 * review `8c66f8e5` S3/S4).
 *
 * So: a message shown on EVERY import was invisible to the entire existing
 * control set. Every query below names `notification-info`, and the HARNESS
 * test proves this file's own helper can see one — without it, every "0 toasts"
 * here would be vacuous.
 *
 * Fixtures follow `Contacts.importFailureToast-3354.test.tsx` (the
 * `contacts:get-available` projection). Ids are invented plain strings; nothing
 * on this path reads their shape. Wording is FOUNDER CONFIRMS AT END-OF-A TEST.
 */
import React, { useContext, useEffect } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import Contacts from "../Contacts";
import { NotificationProvider, NotificationContext } from "../../contexts/NotificationContext";
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

const SHA = "89cb1a1d9";

/** The founder's real shape, in fictional form: a space inside the address. */
const BAD_ONE = "rosey calderbank@example.com";
const BAD_TWO = ["Rosey@ Example.com", "noatsign.example.com"];

const TEXT_ONE =
  `Rosey Calderbank was imported, but "${BAD_ONE}" isn't a valid email address. ` +
  `Emails from it won't be linked to your transactions. ` +
  `Open Rosey Calderbank in your contacts and correct the address.`;
const TEXT_TWO =
  `Rosey Calderbank was imported, but 2 of their addresses aren't valid email addresses: ` +
  `"Rosey@ Example.com" and "noatsign.example.com". ` +
  `Emails from them won't be linked to your transactions. ` +
  `Open Rosey Calderbank in your contacts and correct them.`;
/** BACKLOG-3354's (b)-not-found message, which this one must never displace. */
const TEXT_3354_B =
  "Rosey Calderbank was saved, but couldn't be shown. Find them in your contacts list instead of importing again.";

const USER_ID = "user-3376";
const EXTERNAL_ROW_ID = "shadow-row-rosey-3376";
const SAVED_CONTACT_ID = "saved-contact-rosey-3376";

const rosey = {
  id: EXTERNAL_ROW_ID,
  name: "Rosey Calderbank",
  phone: "+15550118",
  email: BAD_ONE,
  company: "Calderbank Group",
  source: "contacts_app",
  allPhones: ["+15550118"],
  allEmails: [BAD_ONE, "rosey.calderbank@example.test"],
  isFromDatabase: false,
  last_communication_at: "2026-08-01T09:12:00Z",
  externalRecordId: "AB-RECORD-7731",
  externalSourceType: "macos",
  externalUuid: "ab-uuid-rosey-3376",
} as unknown as Contact;

const savedRosey = {
  id: SAVED_CONTACT_ID,
  user_id: USER_ID,
  name: "Rosey Calderbank",
  display_name: "Rosey Calderbank",
  email: "rosey.calderbank@example.test",
  phone: "+15550118",
  source: "contacts_app",
  is_imported: 1,
  created_at: "2026-08-01T09:12:00Z",
  updated_at: "2026-08-01T09:12:00Z",
} as unknown as Contact;

const decoySaved = {
  ...(savedRosey as unknown as Record<string, unknown>),
  id: "saved-contact-dana-3376",
  name: "Dana Decoy",
  display_name: "Dana Decoy",
  email: "dana.decoy@example.test",
} as unknown as Contact;

function installMatchMedia() {
  (window as unknown as { matchMedia: unknown }).matchMedia = jest.fn().mockReturnValue({
    matches: false,
    media: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => true,
  });
}

type SavedAfter = "rosey" | "fail";

/**
 * `hold` gates the SECOND `contacts:get-all` — the saved half of
 * `refreshBothLists`. C7 uses it to ask whether the message is on screen while
 * that refresh is still in flight.
 */
function installBackend(savedAfter: SavedAfter = "rosey", hold?: Promise<void>) {
  let getAllCalls = 0;
  jest.mocked(window.api.contacts.getAll).mockImplementation(async () => {
    getAllCalls += 1;
    if (getAllCalls === 1) return { success: true, contacts: [decoySaved] };
    if (hold) await hold;
    if (savedAfter === "fail") return { success: false, error: "database is locked" };
    return { success: true, contacts: [decoySaved, savedRosey] };
  });
  jest.mocked(window.api.contacts.getAvailable).mockResolvedValue({ success: true, contacts: [rosey] });
  jest.mocked(window.api.contacts.checkCanDelete).mockResolvedValue({ success: true, transactions: [] });
}

const infoToasts = () => screen.queryAllByTestId("notification-info");
const errorToasts = () => screen.queryAllByTestId("notification-error");
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });

async function renderAndOpenRosey() {
  render(
    <NotificationProvider>
      <Contacts userId={USER_ID} onClose={jest.fn()} />
    </NotificationProvider>,
  );
  const row = await waitFor(() => {
    const r = screen
      .queryAllByTestId("contact-row")
      .find((x) => x.textContent?.includes("Rosey Calderbank"));
    if (!r) throw new Error("no Rosey row");
    return r;
  });
  await act(async () => {
    fireEvent.click(row);
  });
  await waitFor(() =>
    expect(screen.getByTestId("contact-preview-name").textContent ?? "").toContain("Rosey"),
  );
}

async function pressImport() {
  await act(async () => {
    fireEvent.click(screen.getByTestId("contact-preview-import"));
  });
}

let alertSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  installMatchMedia();
  alertSpy = jest.spyOn(window, "alert").mockImplementation(() => {});
});

afterEach(() => {
  alertSpy.mockRestore();
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe("BACKLOG-3376 Clients & Contacts card: what was saved that no email can come from", () => {
  it("HARNESS: an INFO toast raised through the provider is visible to these queries", async () => {
    // No production break. If this goes red, every "0 info toasts" below is
    // vacuous — and this is the exact blind spot the item was built around:
    // BACKLOG-3354's helper queries `notification-error` and cannot see one.
    function Raise() {
      const n = useContext(NotificationContext);
      useEffect(() => {
        n?.notify.info("harness toast");
      }, [n]);
      return null;
    }
    render(
      <NotificationProvider>
        <Raise />
      </NotificationProvider>,
    );
    expect(await screen.findByTestId("notification-info")).toHaveTextContent("harness toast");
    expect(screen.queryAllByTestId("notification-error")).toHaveLength(0);
  });

  it("C1: one unmatchable address -> exactly one info toast naming it and the linking consequence", async () => {
    // Breaks caught: no message at all (the pre-3376 code); the address not
    // named; the linking sentence missing; an `error` toast instead of `info`
    // (the contact imported — it is not an error); two toasts for one import.
    installBackend("rosey");
    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: true, contacts: [savedRosey], unmatchableEmails: [BAD_ONE] });
    await renderAndOpenRosey();
    await pressImport();
    await waitFor(() => expect(infoToasts()).toHaveLength(1));
    await settle();
    expect(infoToasts()).toHaveLength(1);
    expect(within(infoToasts()[0]).getByText(TEXT_ONE)).toBeInTheDocument();
    // The address VERBATIM, in the address book's own casing — the user is
    // being sent to find this exact string on their card.
    expect(infoToasts()[0]).toHaveTextContent(BAD_ONE);
    expect(infoToasts()[0]).toHaveTextContent("won't be linked to your transactions");
    expect(errorToasts()).toHaveLength(0);
  });

  it("C6: this surface says IMPORTED", async () => {
    // Break caught: one shared string for both surfaces. The deal wizard ADDS a
    // contact; this screen IMPORTS one, and the two sentences must not be
    // collapsed into whichever verb was written first.
    installBackend("rosey");
    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: true, contacts: [savedRosey], unmatchableEmails: [BAD_ONE] });
    await renderAndOpenRosey();
    await pressImport();
    await waitFor(() => expect(infoToasts()).toHaveLength(1));
    expect(infoToasts()[0]).toHaveTextContent("Rosey Calderbank was imported, but");
    expect(infoToasts()[0]).not.toHaveTextContent("was added");
  });

  it("C10: two unmatchable addresses -> both named, in the source's own casing and order", async () => {
    // Breaks caught: only the first reported; a count instead of the values
    // ("2 of their addresses" with no list); the lowercased stored form; the
    // list joined without "and".
    installBackend("rosey");
    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: true, contacts: [savedRosey], unmatchableEmails: BAD_TWO });
    await renderAndOpenRosey();
    await pressImport();
    await waitFor(() => expect(infoToasts()).toHaveLength(1));
    expect(within(infoToasts()[0]).getByText(TEXT_TWO)).toBeInTheDocument();
    for (const address of BAD_TWO) expect(infoToasts()[0]).toHaveTextContent(address);
  });

  it("C2: a successful import with nothing unmatchable -> NO message", async () => {
    // Break caught: the message raised on every import — the one wrong
    // implementation the entire pre-existing control set could not see (plan
    // P2, SR S3). A contact whose addresses are all fine must stay silent.
    installBackend("rosey");
    jest.mocked(window.api.contacts.import).mockResolvedValue({ success: true, contacts: [savedRosey] });
    await renderAndOpenRosey();
    await pressImport();
    await waitFor(() => expect(screen.queryByTestId("contact-preview-import")).toBeNull());
    await settle();
    expect(infoToasts()).toHaveLength(0);
    expect(errorToasts()).toHaveLength(0);
  });

  it("C2-empty: an EMPTY array is silence, not an empty toast", async () => {
    // Break caught: the renderer checking only for the key's presence rather
    // than a non-empty array, raising a toast with nothing in it.
    installBackend("rosey");
    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: true, contacts: [savedRosey], unmatchableEmails: [] });
    await renderAndOpenRosey();
    await pressImport();
    await waitFor(() => expect(screen.queryByTestId("contact-preview-import")).toBeNull());
    await settle();
    expect(infoToasts()).toHaveLength(0);
  });

  it(`C3 INVENTED@${SHA}: a FAILED import shows 3354's message and NOT this one`, async () => {
    // INVENTED fixture: the shipped handler never produces it. `unmatchableEmails`
    // is spread on the SUCCESS return only, so a `success: false` response
    // carrying it cannot occur — which is exactly why it is used here. It pins
    // the RENDERER half of the guard on its own, independently of the handler
    // half (`contact-handlers.importUnmatchable-3376.test.ts` U6). Belt and
    // braces, deliberately: breaking either alone must be observable.
    //
    // Break caught: the message raised outside `if (result.success &&
    // importedContact)` — a user whose import FAILED would be told to go and
    // correct an address on a contact that was never saved.
    installBackend("fail");
    jest.mocked(window.api.contacts.import).mockResolvedValue({
      success: false,
      error: "disk I/O error",
      savedContactIds: [SAVED_CONTACT_ID],
      unmatchableEmails: [BAD_ONE],
    });
    await renderAndOpenRosey();
    await pressImport();
    await waitFor(() => expect(errorToasts()).toHaveLength(1));
    await settle();
    expect(within(errorToasts()[0]).getByText(TEXT_3354_B)).toBeInTheDocument();
    expect(infoToasts()).toHaveLength(0);
  });

  it("C7: the message is on screen BEFORE the two-list refresh resolves", async () => {
    // Break caught: the `notify?.info` moved below `await refreshBothLists()`.
    //
    // NOT a rejection test on this surface, and that correction was measured:
    // `refreshBothLists` is `Promise.all([fetchSavedContacts(),
    // fetchExternalContacts()])` and both of those RETURN NULL on failure
    // rather than throwing (the `saved !== null && external !== null` commit
    // gate in `useContactDirectory` is the proof). So "move it after the await"
    // is inert against a failed refresh here; ordering is what is observable.
    // The deal wizard's prop CAN reject, and its own C7 is the rejection test.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    installBackend("rosey", held);
    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: true, contacts: [savedRosey], unmatchableEmails: [BAD_ONE] });
    await renderAndOpenRosey();
    await pressImport();

    // The refresh is still in flight — its saved-half read is parked on `held`.
    await waitFor(() => expect(infoToasts()).toHaveLength(1));
    expect(within(infoToasts()[0]).getByText(TEXT_ONE)).toBeInTheDocument();
    expect(screen.getByTestId("contact-preview-import")).toBeInTheDocument();

    await act(async () => {
      release();
      await held;
    });
    await settle();
    expect(infoToasts()).toHaveLength(1);
  });
});
