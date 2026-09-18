/**
 * BACKLOG-3354 — A FAILED IMPORT ON THE CLIENTS & CONTACTS CARD IS SHOWN.
 *
 * Before this item a failed `contacts:import` cleared the card's importing
 * state and showed nothing: every catch on the path only logged. The screen now
 * raises the app's existing toast (`NotificationProvider`) from inside
 * `handleImportContact`'s `run`, and tells two shapes apart by what the main
 * process returns:
 *
 *   (a) nothing saved — `success: false` without `savedContactIds`, a rejected
 *       invoke, or `success: true` with no contact → one "Couldn't import …"
 *       toast.
 *   (b) saved, then a post-commit read failed — `success: false` WITH
 *       `savedContactIds` → refresh both lists; if a saved row is there, the
 *       card lands on it with no toast (only if the user is still on the card,
 *       BACKLOG-2527); otherwise one "… was saved, but couldn't be shown" toast.
 *
 * Every test is rendered INSIDE `NotificationProvider`, so "0 toasts" is a real
 * observation (the HARNESS test proves the query can see one). Each test names
 * the wrong implementation that turns it red; every one of those mutations was
 * run on the shipped code (pm_comments, BACKLOG-3354 implementation handoff).
 *
 * Fixtures follow `Contacts.importButtonState-2525.test.tsx` (the
 * `contacts:get-available` projection). Ids are invented plain strings: nothing
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

const TEXT_A = "Couldn't import Rosey Calderbank — nothing was saved.";
const TEXT_B =
  "Rosey Calderbank was saved, but couldn't be shown. Find them in your contacts list instead of importing again.";
const SHA = "7b4828906";

const USER_ID = "user-3354";
const EXTERNAL_ROW_ID = "shadow-row-rosey-3354";
const SAVED_CONTACT_ID = "saved-contact-rosey-3354";

const rosey = {
  id: EXTERNAL_ROW_ID,
  name: "Rosey Calderbank",
  phone: "+15550118",
  email: "rosey.calderbank@example.test",
  company: "Calderbank Group",
  source: "contacts_app",
  allPhones: ["+15550118"],
  allEmails: ["rosey.calderbank@example.test"],
  isFromDatabase: false,
  last_communication_at: "2026-08-01T09:12:00Z",
  externalRecordId: "AB-RECORD-7731",
  externalSourceType: "macos",
  externalUuid: "ab-uuid-rosey-3354",
} as unknown as Contact;

const oleg = {
  ...(rosey as unknown as Record<string, unknown>),
  id: "shadow-row-oleg-3354",
  name: "Oleg Vantry",
  phone: "+15550164",
  email: "oleg.vantry@example.test",
  allPhones: ["+15550164"],
  allEmails: ["oleg.vantry@example.test"],
  externalRecordId: "AB-RECORD-9902",
  externalUuid: "ab-uuid-oleg-3354",
} as unknown as Contact;

/** The contact the import saved. */
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

/**
 * A DIFFERENT saved contact, listed FIRST in the refreshed saved half. In the
 * real app that half holds every saved contact, so "the card shows a saved row"
 * is not "the card shows the saved PERSON". Without this row, a lookup of
 * `refreshed[0]` instead of the returned id passes every test (SR delta review,
 * condition C1).
 */
const decoySaved = {
  id: "saved-contact-dana-3354",
  user_id: USER_ID,
  name: "Dana Decoy",
  display_name: "Dana Decoy",
  email: "dana.decoy@example.test",
  phone: "+15550177",
  source: "contacts_app",
  is_imported: 1,
  created_at: "2026-07-01T09:12:00Z",
  updated_at: "2026-07-01T09:12:00Z",
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

/**
 * The saved half after the import: "empty" (nothing saved), "rosey" (the decoy,
 * then the saved person), or "fail" (the saved-half read fails, so
 * `refreshBothLists` commits neither half and returns no rows).
 */
type SavedAfter = "empty" | "rosey" | "fail";
function installBackend(savedAfter: SavedAfter = "empty") {
  let getAllCalls = 0;
  jest.mocked(window.api.contacts.getAll).mockImplementation(async () => {
    getAllCalls += 1;
    if (getAllCalls === 1) return { success: true, contacts: [decoySaved] };
    if (savedAfter === "empty") return { success: true, contacts: [decoySaved] };
    if (savedAfter === "fail") return { success: false, error: "database is locked" };
    return { success: true, contacts: [decoySaved, savedRosey] };
  });
  jest.mocked(window.api.contacts.getAvailable).mockResolvedValue({ success: true, contacts: [rosey, oleg] });
  jest.mocked(window.api.contacts.checkCanDelete).mockResolvedValue({ success: true, transactions: [] });
}

const toasts = () => screen.queryAllByTestId("notification-error");
const importCalls = () => jest.mocked(window.api.contacts.import).mock.calls.length;
const cardName = () => screen.getByTestId("contact-preview-name").textContent ?? "";
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });

async function openRow(name: string) {
  const row = await waitFor(() => {
    const r = screen.queryAllByTestId("contact-row").find((x) => x.textContent?.includes(name));
    if (!r) throw new Error(`no row ${name}`);
    return r;
  });
  await act(async () => {
    fireEvent.click(row);
  });
  await waitFor(() => expect(cardName()).toContain(name));
}

async function pressImport() {
  await act(async () => {
    fireEvent.click(screen.getByTestId("contact-preview-import"));
  });
}

async function renderAndOpenRosey() {
  render(
    <NotificationProvider>
      <Contacts userId={USER_ID} onClose={jest.fn()} />
    </NotificationProvider>,
  );
  await openRow("Rosey Calderbank");
}

async function failAndSettle() {
  await waitFor(() => expect(importCalls()).toBe(1));
  await waitFor(() => expect(screen.getByTestId("contact-preview-import")).toBeEnabled());
  await settle();
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

describe("BACKLOG-3354 Clients & Contacts card: a failed import is shown", () => {
  it("HARNESS: a toast raised through the provider is visible to these queries", async () => {
    // No production break. If this goes red, every "0 toasts" below is vacuous.
    function Raise() {
      const n = useContext(NotificationContext);
      useEffect(() => {
        n?.notify.error("harness toast");
      }, [n]);
      return null;
    }
    render(
      <NotificationProvider>
        <Raise />
      </NotificationProvider>,
    );
    expect(await screen.findByTestId("notification-error")).toHaveTextContent("harness toast");
  });

  it("C-a: nothing saved -> exactly one (a) toast, without the raw error", async () => {
    // Breaks caught: no toast at all (the pre-3354 code); one generic message
    // for both shapes; raw `result.error` in the text; "treat any failure as
    // saved"; a second toast in a surrounding catch; a toast only in
    // ContactSearchList's catch (not on this card's path).
    installBackend();
    jest.mocked(window.api.contacts.import).mockResolvedValue({ success: false, error: "database is locked" });
    await renderAndOpenRosey();
    await pressImport();
    await failAndSettle();
    expect(toasts()).toHaveLength(1);
    expect(within(toasts()[0]).getByText(TEXT_A)).toBeInTheDocument();
    expect(toasts()[0]).not.toHaveTextContent("database is locked");
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("C-a2: after (a), Import is enabled and a second press reaches contacts:import again", async () => {
    // Break caught: the `inFlightImports` entry removed only when the import
    // succeeds, while the importing state is still cleared. The button is
    // enabled, but the second press returns the cached rejection: no IPC call
    // and no toast, which is this item's defect again. ("Treat any failure as
    // saved" does NOT redden this test; C-a catches that one.)
    installBackend();
    jest.mocked(window.api.contacts.import).mockResolvedValue({ success: false, error: "database is locked" });
    await renderAndOpenRosey();
    await pressImport();
    await failAndSettle();
    expect(screen.getByTestId("contact-preview-import")).toBeEnabled();
    await pressImport();
    await waitFor(() => expect(importCalls()).toBe(2));
  });

  it("C-b-found: saved ids returned and the refresh has the row -> the card shows THAT person, no toast, one call", async () => {
    // Breaks caught: (b) always toasts and throws; (b) without the refresh;
    // picking the first refreshed row (`refreshed[0]`) instead of the row with
    // a returned id — the decoy is listed first, so the card would show "Dana
    // Decoy".
    installBackend("rosey");
    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: false, error: "disk I/O error", savedContactIds: [SAVED_CONTACT_ID] });
    await renderAndOpenRosey();
    await pressImport();
    await waitFor(() => expect(screen.queryByTestId("contact-preview-import")).toBeNull());
    await settle();
    expect(cardName()).toContain("Rosey Calderbank");
    expect(toasts()).toHaveLength(0);
    expect(importCalls()).toBe(1);
  });

  it("C-b-moved: the user opens another contact while (b) runs -> the card stays on that contact", async () => {
    // Break caught: `showPreviewContact(shown)` called inside `run`, which
    // bypasses `handlePreviewImport`'s BACKLOG-2527 id check. GREEN on the
    // pre-3354 code too (nothing switched the card then), so the pre-3354 run
    // proves nothing here; that mutation is this test's proof.
    installBackend("rosey");
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    jest.mocked(window.api.contacts.import).mockImplementation(async () => {
      await held;
      return { success: false, error: "disk I/O error", savedContactIds: [SAVED_CONTACT_ID] };
    });
    await renderAndOpenRosey();
    await pressImport();
    await openRow("Oleg Vantry");
    await act(async () => {
      release();
      await held;
    });
    await settle();
    await settle();
    expect(cardName()).toContain("Oleg Vantry");
    expect(toasts()).toHaveLength(0);
  });

  it("C-b-notfound: the saved-half refresh read fails -> exactly one (b) toast, and the card stays", async () => {
    // Breaks caught: (b) not-found without its toast; one generic message for
    // both shapes; a second toast in a surrounding catch.
    installBackend("fail");
    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: false, error: "disk I/O error", savedContactIds: [SAVED_CONTACT_ID] });
    await renderAndOpenRosey();
    await pressImport();
    await failAndSettle();
    expect(toasts()).toHaveLength(1);
    expect(within(toasts()[0]).getByText(TEXT_B)).toBeInTheDocument();
    expect(screen.getByTestId("contact-preview-import")).toBeInTheDocument();
  });

  it("C-r: a rejected invoke -> exactly one (a) toast", async () => {
    // Breaks caught: no toast on a rejected invoke; a second toast in a
    // surrounding catch.
    installBackend();
    jest
      .mocked(window.api.contacts.import)
      .mockRejectedValue(new Error("No handler registered for 'contacts:import'"));
    await renderAndOpenRosey();
    await pressImport();
    await failAndSettle();
    expect(toasts()).toHaveLength(1);
    expect(within(toasts()[0]).getByText(TEXT_A)).toBeInTheDocument();
  });

  it(`C-c INVENTED@${SHA}: success with no contact -> exactly one (a) toast`, async () => {
    // INVENTED fixture: no live producer. Only a legacy `is_imported = 0` row
    // deleted between list load and press returns `success: true, contacts: []`.
    // Break caught: the (a) toast raised only when `success === false`.
    installBackend();
    jest.mocked(window.api.contacts.import).mockResolvedValue({ success: true, contacts: [] });
    await renderAndOpenRosey();
    await pressImport();
    await failAndSettle();
    expect(toasts()).toHaveLength(1);
    expect(within(toasts()[0]).getByText(TEXT_A)).toBeInTheDocument();
  });

  it("C-s: a successful import -> no error toast", async () => {
    // Break caught: a toast raised on every completion (e.g. in `run`'s
    // `.finally`).
    installBackend("rosey");
    jest.mocked(window.api.contacts.import).mockResolvedValue({ success: true, contacts: [savedRosey] });
    await renderAndOpenRosey();
    await pressImport();
    await waitFor(() => expect(screen.queryByTestId("contact-preview-import")).toBeNull());
    await settle();
    expect(cardName()).toContain("Rosey Calderbank");
    expect(toasts()).toHaveLength(0);
  });
});
