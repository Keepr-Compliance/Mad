/**
 * BACKLOG-3214 + BACKLOG-3233 — AN ABSENT ADDRESS BOOK IS NOT A DENIAL.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE EXISTS
 * ---------------------------------------------------------------------------
 * The contacts permission probe read `.../AddressBook/Sources` while the reader
 * walks `.../AddressBook`. `Sources/` only exists once a NETWORK ACCOUNT has
 * been added, so a Mac whose contacts are all "On My Mac" had its address book
 * read perfectly and was still told a permission was missing.
 *
 * That was never only a banner. `checkAllPermissions` turns the probe's verdict
 * into `allGranted`, which reaches `useAutoRefresh.ts:303` —
 * `isMacOS && hasPermissions && importSource === 'macos-native'` — so the false
 * reading SWITCHED OFF macOS message sync on a Mac with nothing wrong with it.
 * C1c is the control for that value; C1b is the control for the banner.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE
 * ---------------------------------------------------------------------------
 * The probe, the reader's directory discovery, the health-check handler and the
 * temp HOME directories are all REAL — these tests build a filesystem and let
 * `checkContactsPermission` fail against it for real. Only `connectionStatusService`,
 * `databaseService` and `logService` are mocked, and `os.platform` is forced to
 * darwin so the macOS-only branches run on any CI box.
 *
 * Where a test needs a contacts-LOADING failure it cannot produce from the
 * filesystem (a corrupt store, a throwing check), it spies on
 * `checkContactsLoading` — and says so at the call site.
 *
 * ---------------------------------------------------------------------------
 * WHICH CONTROL CATCHES WHICH WRONG FIX — measured, not asserted
 * ---------------------------------------------------------------------------
 * Every row below was produced by applying the wrong fix and running this suite
 * plus all 19 existing suites that touch this code.
 *
 *   W4  probe `DEFAULT_CONTACTS_DB` (the .abcddb FILE) instead of the directory
 *       -> C2a, and `permissionService.probeReaderParity-3214.test.ts` (2 rows).
 *          NOTHING in the pre-existing repo catches it.
 *   W5  `storeAbsent = !permissions.allGranted` instead of keying on the code
 *       -> C8, and the pre-existing
 *          `diagnosticHandlers.messagesAbsentPassthrough-3213.test.ts`.
 *   W6  reuse FDA_DOWNSTREAM_ISSUE_TYPES for the absent set
 *       -> C9 ONLY. Before C9 existed this wrong fix passed 20 suites and 299
 *          tests. It silences a real error — the contacts check THROWING — and
 *          every check in the repo stayed green.
 *
 * C6, C7, C8 and C9 are not bug controls. They are the controls a WRONG FIX
 * breaks, and they must stay green through every revision of this work.
 */
import { ipcMain } from "electron";
import fs from "fs";
import os from "os";
import path from "path";

jest.mock("os", () => {
  const actual = jest.requireActual("os");
  return { ...actual, platform: () => "darwin" };
});
jest.mock("../../services/connectionStatusService", () => ({
  __esModule: true,
  default: { checkAllConnections: jest.fn().mockResolvedValue({ google: undefined, microsoft: undefined }) },
}));
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: { getDatabase: jest.fn(), isInitialized: jest.fn(() => false) },
}));
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  registerDiagnosticHandlers,
  isDownstreamOfContactsStoreAbsent,
  isDownstreamOfFdaDenial,
} from "../diagnosticHandlers";
import permissionService from "../../services/permissionService";

const AB = "Library/Application Support/AddressBook";
const realHome = process.env.HOME;
let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kp3214c-")); });
afterAll(() => { process.env.HOME = realHome; });

function useHome(name: string, build: (h: string) => void): string {
  const h = path.join(tmp, name);
  fs.mkdirSync(path.join(h, "Library/Messages"), { recursive: true });
  fs.writeFileSync(path.join(h, "Library/Messages/chat.db"), "x");
  build(h);
  process.env.HOME = h;
  permissionService.clearCache();
  return h;
}

function handler() {
  (ipcMain.handle as unknown as jest.Mock).mockClear();
  registerDiagnosticHandlers();
  const call = (ipcMain.handle as unknown as jest.Mock).mock.calls.find(
    (c: unknown[]) => c[0] === "system:health-check",
  );
  if (!call) throw new Error("not registered");
  return call[1] as (e: unknown, u: string | null, p: string | null) => Promise<any>;
}
const ids = (res: any) => (res.issues as any[]).map((i) => i.errorCode ?? i.type);

describe("C1 — STATE A: AddressBook/ with a store, no Sources/ (BACKLOG-3214)", () => {
  beforeEach(() => {
    useHome("A", (h) => {
      fs.mkdirSync(path.join(h, AB), { recursive: true });
      fs.writeFileSync(path.join(h, AB, "AddressBook-v22.abcddb"), "x");
    });
  });

  it("C1a: the probe does not claim the store is missing when the reader can see it", async () => {
    const r = await permissionService.checkContactsPermission();
    expect(r.hasPermission).toBe(true);
    expect(r.errorCode).toBeUndefined();
  });

  it("C1b: the health banner shows NO row on a Mac whose contacts load fine", async () => {
    const res = await handler()({}, null, null);
    expect(ids(res)).toEqual([]);
  });

  it("C1c: the onboarding permission gate is not tripped (allGranted stays true)", async () => {
    const all = await permissionService.checkAllPermissions();
    expect(all.allGranted).toBe(true);
  });
});

describe("C2 — STATE A2 mirror: Sources/<uuid>/store only, no top-level store", () => {
  it("C2a: still zero rows — the probe must target the DIRECTORY, not the default file", async () => {
    useHome("A2", (h) => {
      const s = path.join(h, AB, "Sources", "account-one");
      fs.mkdirSync(s, { recursive: true });
      fs.writeFileSync(path.join(s, "AddressBook-v22.abcddb"), "x");
    });
    const res = await handler()({}, null, null);
    expect(ids(res)).toEqual([]);
  });
});

describe("C5 — STATE B: no AddressBook/ at all (BACKLOG-3233)", () => {
  beforeEach(() => { useHome("B", () => {}); });

  it("C5a: exactly ONE contacts row", async () => {
    const res = await handler()({}, null, null);
    const contactsRows = ids(res).filter((i: string) => String(i).startsWith("CONTACTS"));
    expect(contactsRows).toEqual(["CONTACTS_STORE_NOT_FOUND"]);
  });

  it("C5b: its copy names no permission", async () => {
    const res = await handler()({}, null, null);
    const row = (res.issues as any[]).find((i) => i.errorCode === "CONTACTS_STORE_NOT_FOUND");
    expect(row).toBeDefined();
    const visible = [row.title, row.userMessage, row.message, row.action].filter(Boolean).join(" | ");
    expect(visible).not.toMatch(/Full Disk Access/);
  });

  it("C5c: it carries no action, so the dead button is gone (BACKLOG-2392)", async () => {
    const res = await handler()({}, null, null);
    const row = (res.issues as any[]).find((i) => i.errorCode === "CONTACTS_STORE_NOT_FOUND");
    expect(row).not.toHaveProperty("action");
    expect(row).not.toHaveProperty("actionHandler");
  });

  it("C5d: CONTACTS_LOADING_FAILED is suppressed — the absent row already said it", async () => {
    const res = await handler()({}, null, null);
    expect(ids(res)).not.toContain("CONTACTS_LOADING_FAILED");
  });
});

describe("C6/C7/C8 — the controls a wrong fix would break (must stay GREEN throughout)", () => {
  it("C6: no denial, no absent store, books present but unreadable -> CONTACTS_LOADING_FAILED SURVIVES", async () => {
    // STATE C shape: the directory exists AND a store exists, so neither the
    // probe nor the absent-suppression may fire. Forced unreadable.
    useHome("C6", (h) => {
      fs.mkdirSync(path.join(h, AB, "Sources"), { recursive: true });
      fs.writeFileSync(path.join(h, AB, "AddressBook-v22.abcddb"), "x");
    });
    const spy = jest.spyOn(permissionService, "checkContactsLoading").mockResolvedValue({
      canLoadContacts: false, contactCount: 0, coverage: "none",
      booksFound: 3, booksRead: 0, booksFailed: 3,
      error: {
        type: "CONTACTS_LOADING_FAILED", title: "Cannot Load Contacts",
        message: "Could not load contacts from Contacts app",
        details: "No contacts could be loaded from any database",
        action: "Grant Full Disk Access in System Settings > Privacy & Security > Full Disk Access",
        actionHandler: "open-system-settings", severity: "error",
      },
    } as any);
    const res = await handler()({}, null, null);
    expect(ids(res)).toContain("CONTACTS_LOADING_FAILED");
    spy.mockRestore();
  });

  it("C7: a real denial still collapses to ONE Full Disk Access row", async () => {
    useHome("C7", (h) => {
      fs.mkdirSync(path.join(h, AB, "Sources"), { recursive: true });
    });
    const spyP = jest.spyOn(permissionService, "checkAllPermissions").mockResolvedValue({
      allGranted: false, permissions: {},
      errors: [
        { hasPermission: false, errorCode: "FULL_DISK_ACCESS_DENIED", error: "EPERM",
          userMessage: "Full Disk Access permission is required to read iMessages.",
          action: "Please grant Full Disk Access in System Settings > Privacy & Security > Full Disk Access" },
        { hasPermission: false, errorCode: "CONTACTS_ACCESS_DENIED", error: "EPERM",
          userMessage: "Contacts permission is required to match phone numbers to names.",
          action: "Full Disk Access in System Settings > Privacy & Security > Full Disk Access will grant access to Contacts" },
      ],
    } as any);
    const spyL = jest.spyOn(permissionService, "checkContactsLoading").mockResolvedValue({
      canLoadContacts: false, contactCount: 0,
      error: { type: "CONTACTS_LOADING_FAILED", title: "Cannot Load Contacts", message: "m",
        details: "d", action: "a", actionHandler: "open-system-settings", severity: "error" },
    } as any);
    const res = await handler()({}, null, null);
    expect(res.issues).toHaveLength(1);
    expect(ids(res)).toEqual(["FULL_DISK_ACCESS_DENIED"]);
    spyP.mockRestore(); spyL.mockRestore();
  });

  it("C8: MESSAGES_STORE_NOT_FOUND + unreadable contacts -> CONTACTS_LOADING_FAILED SURVIVES", async () => {
    // Catches a fix that suppresses on !allGranted instead of on the code.
    const h = path.join(tmp, "C8");
    fs.mkdirSync(path.join(h, AB, "Sources"), { recursive: true });
    fs.writeFileSync(path.join(h, AB, "AddressBook-v22.abcddb"), "x");
    process.env.HOME = h;               // no chat.db -> MESSAGES_STORE_NOT_FOUND
    permissionService.clearCache();
    const spy = jest.spyOn(permissionService, "checkContactsLoading").mockResolvedValue({
      canLoadContacts: false, contactCount: 0, coverage: "none",
      booksFound: 3, booksRead: 0, booksFailed: 3,
      error: {
        type: "CONTACTS_LOADING_FAILED", title: "Cannot Load Contacts",
        message: "Could not load contacts from Contacts app", details: "d",
        action: "Grant Full Disk Access in System Settings > Privacy & Security > Full Disk Access",
        actionHandler: "open-system-settings", severity: "error",
      },
    } as any);
    const res = await handler()({}, null, null);
    expect(ids(res)).toContain("MESSAGES_STORE_NOT_FOUND");
    expect(ids(res)).toContain("CONTACTS_LOADING_FAILED");
    spy.mockRestore();
  });

  // THE CONTROL THAT NOTHING ELSE IN THE REPO PROVIDES.
  //
  // `diagnosticHandlers.ts` states in prose that the absent downstream set is
  // NARROWER than the Full Disk Access one: an absent store explains "we read
  // zero books", it does NOT explain the check itself THROWING. Reusing the FDA
  // set is a one-token edit that reads like tidying:
  //
  //     const STORE_ABSENT_DOWNSTREAM_ISSUE_TYPES = FDA_DOWNSTREAM_ISSUE_TYPES;
  //
  // Applied, that passed 20 suites and 299 tests — every control in this file
  // and every pre-existing guard — while silencing a genuine error. The only
  // CONTACTS_CHECK_FAILED coverage that existed was
  // `oneRowPerCause-3237.test.ts` -> "suppresses CONTACTS_CHECK_FAILED under a
  // DENIAL", which is the other path entirely.
  it("C9: store absent + the check itself THREW -> CONTACTS_CHECK_FAILED SURVIVES", async () => {
    useHome("C9", () => {});
    const spy = jest.spyOn(permissionService, "checkContactsLoading").mockResolvedValue({
      canLoadContacts: false, contactCount: 0,
      error: { type: "CONTACTS_CHECK_FAILED", title: "Contacts Check Failed",
        message: "Could not verify contacts access", details: "boom",
        action: "Try restarting Keepr", actionHandler: "open-system-settings", severity: "error" },
    } as any);
    const res = await handler()({}, null, null);
    expect(ids(res)).toContain("CONTACTS_STORE_NOT_FOUND");
    expect(ids(res)).toContain("CONTACTS_CHECK_FAILED");
    spy.mockRestore();
  });
});

/**
 * C9b — THE SAME CLAIM AS C9, ASSERTED ONE LAYER DOWN.
 *
 * C9 catches the reuse-the-denial-set wrong fix by observing what the HANDLER
 * emits. That is one machine: temp HOME, spies, the registered channel. If it
 * were the only control, the asymmetry this whole design turns on would be held
 * by a single test running a single apparatus.
 *
 * These two assertions hold it structurally instead — no HOME, no mocks, no
 * handler, no fixture. They read the predicates directly, so they fail on the
 * SET CONTENTS where C9 fails on observed output. A change that breaks the
 * asymmetry cannot satisfy both by accident.
 *
 * They also state the asymmetry as an EXECUTABLE claim. Before this it lived in
 * prose in three comments and in one test — one careless edit from being prose
 * alone, which is the state the wrong fix exploited:
 *
 *     const STORE_ABSENT_DOWNSTREAM_ISSUE_TYPES = FDA_DOWNSTREAM_ISSUE_TYPES;
 *
 * Measured: red on that edit, green on correct code.
 *
 * WHY THE SETS DIFFER, in one line — a Full Disk Access denial explains both a
 * read that returned nothing AND a check that threw, because the denial is why
 * either happened. An absent address book explains only the first: there is no
 * reason a missing directory should make the check ITSELF throw, so a throw
 * under an absent store is a second, unexplained fault and must still be shown.
 */
describe("C9b — the absent downstream set must stay NARROWER than the denial set", () => {
  it("an absent store explains a failed READ but never the check THROWING", () => {
    expect(isDownstreamOfContactsStoreAbsent({ type: "CONTACTS_LOADING_FAILED" })).toBe(true);
    expect(isDownstreamOfContactsStoreAbsent({ type: "CONTACTS_CHECK_FAILED" })).toBe(false);
  });

  it("the DENIAL set does include the throw — that asymmetry is the whole point", () => {
    expect(isDownstreamOfFdaDenial({ type: "CONTACTS_LOADING_FAILED" })).toBe(true);
    expect(isDownstreamOfFdaDenial({ type: "CONTACTS_CHECK_FAILED" })).toBe(true);
  });
});
