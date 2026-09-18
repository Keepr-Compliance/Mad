/**
 * BACKLOG-3210 — AN EMPTY CONTACTS READ MUST NAME ITS OWN CAUSE.
 *
 * `contacts:syncExternal` answered every empty macOS read with one sentence:
 * "No contacts found in macOS Contacts". Without Full Disk Access the read
 * returns EMPTY rather than failing, so a user who had not granted the
 * permission was told her address book was empty. That is a believable wrong
 * answer, which is worse than a failure — nothing looks broken, so nobody
 * investigates. The founder hit exactly this.
 *
 * THE SWEEP IS THE TEST. A suite that only proved "denied produces the new
 * message" would be the same defect in a new place: a check that cannot
 * separate two states is what is being fixed here, so both states are driven,
 * and so is the third cause the separation exposes.
 *
 * FIXTURES ARE TRANSCRIBED, NOT INVENTED. Every `status` below comes from
 * `helpers/macOSReadStates-3210`, whose values are pinned against the SHIPPED
 * reader by `contactsService.deniedVsEmpty-3210.test.ts` running on real
 * `.abcddb` files. If the reader stops emitting one of these shapes, that suite
 * goes red and these tests cannot quietly go on asserting a state the code can
 * no longer produce.
 *
 * PRECEDENCE UNDER TEST: `booksRead > 0` is direct evidence a store opened, and
 * it must outrank the permission probe. The "genuinely empty" case therefore
 * asserts the probe is NEVER CALLED — not merely that its answer was ignored.
 */

import {
  NOTHING_DISCOVERED,
  READ_AND_EMPTY,
  FOUND_BUT_UNREADABLE,
  READ_WITH_CONTACTS,
  type MacOSReadShape,
} from "../../services/__tests__/helpers/macOSReadStates-3210";


const handlers = new Map<string, (...args: unknown[]) => unknown>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    on: jest.fn(),
  },
  BrowserWindow: class {},
  app: { getPath: jest.fn(() => "/tmp"), getVersion: jest.fn(() => "0.0.0-test") },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

const mockGetContactEmailEntries = jest.fn();
const mockGetContactPhoneEntries = jest.fn();
const mockGetLiveSourcesForContact = jest.fn();

jest.mock("../../services/db/contactDbService", () => ({
  __esModule: true,
  getContactEmailEntries: (...a: unknown[]) => mockGetContactEmailEntries(...a),
  getContactPhoneEntries: (...a: unknown[]) => mockGetContactPhoneEntries(...a),
}));

jest.mock("../../services/db/contactSourceSets", () => ({
  __esModule: true,
  getLiveSourcesForContact: (...a: unknown[]) => mockGetLiveSourcesForContact(...a),
}));

// Everything else the registrar pulls in at module load. None of it is exercised
// by `contacts:get-edit-data`; these exist so the module can be imported without
// opening a database or a provider connection.
jest.mock("../../services/databaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/failureLogService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/db/core/dbConnection", () => ({
  __esModule: true,
  dbTransaction: jest.fn(),
  dbAll: jest.fn(() => []),
  dbRun: jest.fn(),
  dbGet: jest.fn(),
}));
const mockGetContactNames = jest.fn();
jest.mock("../../services/contactsService", () => ({
  __esModule: true,
  getContactNames: (...a: unknown[]) => mockGetContactNames(...a),
}));

// The probe under test. Mocked because the real one reads the machine's own
// contacts store, which would make the result depend on whether the developer
// running the suite happens to hold Full Disk Access. Its errno behaviour is
// covered against a mocked `fs` in `permissionService.contactsErrno-3210`.
const mockCheckContactsPermission = jest.fn();
jest.mock("../../services/permissionService", () => ({
  __esModule: true,
  default: {
    checkContactsPermission: (...a: unknown[]) => mockCheckContactsPermission(...a),
  },
}));

const mockIsContactSourceEnabled = jest.fn();
jest.mock("../../utils/preferenceHelper", () => ({
  __esModule: true,
  isContactSourceEnabled: (...a: unknown[]) => mockIsContactSourceEnabled(...a),
}));
jest.mock("../../services/contactResolutionService", () => ({ __esModule: true, resolveHandles: jest.fn() }));
jest.mock("../../services/auditService", () => ({ __esModule: true, default: { log: jest.fn() } }));
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockFullSync = jest.fn();
jest.mock("../../services/db/externalContactDbService", () => ({
  __esModule: true,
  fullSync: (...a: unknown[]) => mockFullSync(...a),
  getCount: jest.fn(() => 0),
  isStale: jest.fn(() => false),
}));
jest.mock("../../services/contactIngestionFunnel", () => ({
  __esModule: true,
  recordPicker: jest.fn(),
  recordLinks: jest.fn(),
}));
jest.mock("../../services/contactLinkingScheduler", () => ({
  __esModule: true,
  cancelPendingContactLinking: jest.fn(),
  configureContactLinking: jest.fn(),
  requestContactLinking: jest.fn(),
  runContactLinkingNow: jest.fn(),
}));
jest.mock("../../services/db/contactSourceLinkDbService", () => ({
  __esModule: true,
  createLink: jest.fn(),
  findContactIdBySourceRecord: jest.fn(),
  getLinkedSourceKeys: jest.fn(() => new Set()),
  sourceKey: jest.fn(),
}));
jest.mock("../../services/db/contactSourceLinkSql", () => ({
  __esModule: true,
  CONTACT_SOURCE_RECORDS_SQL: "",
}));
jest.mock("../../services/contactSourceLinker", () => ({
  __esModule: true,
  linkExternalContactsForUser: jest.fn(),
}));
jest.mock("../../services/contactNameAutoLink", () => ({
  __esModule: true,
  runUniqueNameAutoLink: jest.fn(),
}));
jest.mock("../../services/contactLinkEvidence", () => ({
  __esModule: true,
  buildEvidence: jest.fn(),
  sourceLabel: jest.fn(),
}));
jest.mock("../../services/db/contactLinkReviewDbService", () => ({
  __esModule: true,
  proposeLink: jest.fn(),
  listVerdicts: jest.fn(() => []),
  getRejectedSourceKeys: jest.fn(() => new Set()),
}));
jest.mock("../../services/contactLinkReview", () => ({
  __esModule: true,
  countReviewQueue: jest.fn(() => 0),
  getReviewQueue: jest.fn(() => []),
  confirmProposal: jest.fn(),
  rejectProposal: jest.fn(),
}));
jest.mock("../../services/contactProvenance", () => ({
  __esModule: true,
  getContactProvenance: jest.fn(() => []),
  unlinkContactSource: jest.fn(),
}));
jest.mock("../../workers/contactWorkerPool", () => ({
  __esModule: true,
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));
jest.mock("../../services/contactSourceValues", () => ({
  __esModule: true,
  applyLinkedSourceValues: jest.fn(),
}));
jest.mock("../../services/db/contactOriginLink", () => ({
  __esModule: true,
  recordContactOrigin: jest.fn(),
}));
jest.mock("../../services/contactSyncService", () => ({
  __esModule: true,
  default: { registerProvider: jest.fn() },
}));
jest.mock("../../services/providers/outlookContactProvider", () => ({
  __esModule: true,
  OutlookContactProvider: class {},
}));
jest.mock("../../services/providers/googleContactProvider", () => ({
  __esModule: true,
  GoogleContactProvider: class {},
}));

const mockGetValidUserId = jest.fn();
jest.mock("../../utils/userIdHelper", () => ({
  __esModule: true,
  getValidUserId: (...a: unknown[]) => mockGetValidUserId(...a),
  getValidUserIdSync: jest.fn(),
}));

jest.mock("../../services/contactManualLink", () => ({
  __esModule: true,
  findLinkableSourceRecords: jest.fn(() => []),
  linkSourceRecordsToContact: jest.fn(),
}));

import { registerContactHandlers } from "../contactHandlers";

const USER_ID = "22222222-2222-4222-8222-222222222222"; // pii-allow-uuid: invented, not from any live row

type SyncResponse = {
  success: boolean;
  inserted?: number;
  total?: number;
  read?: { found: number; read: number; failed: number; coverage: string };
  error?: string;
  errorCode?: string;
};

/**
 * A full `LoadStatus` built from a transcribed shape. The extra fields carry no
 * claim — the reader always sets them and the classifier never reads them — but
 * omitting them would make the double a shape the reader cannot emit.
 */
function statusFrom(shape: MacOSReadShape): Record<string, unknown> {
  return {
    ...shape,
    failures: [],
    sources: [],
  };
}

/** The read result for a state that produced nobody. */
function emptyRead(shape: MacOSReadShape): Record<string, unknown> {
  return { contactMap: {}, phoneToContactInfo: {}, contacts: [], status: statusFrom(shape) };
}

async function invokeSync(): Promise<SyncResponse> {
  const handler = handlers.get("contacts:syncExternal");
  if (!handler) throw new Error("contacts:syncExternal was never registered");
  return (await handler({}, USER_ID)) as SyncResponse;
}

/** Full Disk Access is granted and the contacts store is readable. */
const PERMISSION_GRANTED = { hasPermission: true };
/** macOS TCC refused the read (EPERM). */
const PERMISSION_DENIED = {
  hasPermission: false,
  errorCode: "CONTACTS_ACCESS_DENIED",
  error: "EPERM: operation not permitted",
};

describe("BACKLOG-3210: contacts:syncExternal reports the real cause of an empty read", () => {
  beforeAll(() => {
    registerContactHandlers({} as never);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetValidUserId.mockResolvedValue(USER_ID);
    mockIsContactSourceEnabled.mockResolvedValue(true);
    mockFullSync.mockReturnValue({ inserted: 2, deleted: 0, total: 2 });
  });

  /**
   * STATE 1 — the founder's case. She has contacts; we were not allowed to read
   * them. The reader reports the same nothing it reports for a Mac with no
   * address book, so only the probe can tell them apart.
   */
  it("names the PERMISSION when the read was denied", async () => {
    mockGetContactNames.mockResolvedValue(emptyRead(NOTHING_DISCOVERED));
    mockCheckContactsPermission.mockResolvedValue(PERMISSION_DENIED);

    const res = await invokeSync();

    expect(mockGetContactNames).toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("CONTACTS_ACCESS_DENIED");
    // The sentence the user reads must name the permission, and must NOT claim
    // the address book is empty.
    expect(res.error).toContain("Full Disk Access");
    expect(res.error).not.toContain("No contacts found");
  });

  /**
   * STATE 2 — THE CONTROL THAT MATTERS. Full Disk Access is granted, an address
   * book opened cleanly, and it holds nobody. Emptiness is the true answer and
   * must survive the fix.
   *
   * The probe is asserted NEVER CALLED, not merely overruled: `booksRead > 0`
   * is direct evidence the read happened, and no later probe may be allowed to
   * contradict it.
   */
  it("still reports EMPTINESS when a readable address book holds nobody", async () => {
    mockGetContactNames.mockResolvedValue(emptyRead(READ_AND_EMPTY));
    // Deliberately armed to say DENIED. If the classifier consults it here, the
    // answer flips and this test goes red — which is the point.
    mockCheckContactsPermission.mockResolvedValue(PERMISSION_DENIED);

    const res = await invokeSync();

    expect(mockGetContactNames).toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("CONTACTS_EMPTY");
    expect(res.error).toBe("No contacts found in macOS Contacts");
    expect(mockCheckContactsPermission).not.toHaveBeenCalled();
  });

  /**
   * STATE 2b — nothing was discovered AND the store is readable. No address
   * book on this Mac at all. Same verdict as 2, reached the other way, and it
   * is the case that would break if the probe defaulted to "denied".
   */
  it("reports EMPTINESS when nothing was discovered and the store is readable", async () => {
    mockGetContactNames.mockResolvedValue(emptyRead(NOTHING_DISCOVERED));
    mockCheckContactsPermission.mockResolvedValue(PERMISSION_GRANTED);

    const res = await invokeSync();

    expect(mockCheckContactsPermission).toHaveBeenCalledTimes(1);
    expect(res.errorCode).toBe("CONTACTS_EMPTY");
    expect(res.error).toBe("No contacts found in macOS Contacts");
  });

  /**
   * STATE 3 — the success path, unchanged. A fix that reports causes correctly
   * and breaks the working case is not a fix.
   */
  it("leaves the success path alone when contacts are present", async () => {
    mockGetContactNames.mockResolvedValue({
      contactMap: {},
      phoneToContactInfo: { "+15555550124": { name: "Jane Doe", recordId: "P-0001:ABPerson" } },
      contacts: [
        { recordId: "P-0001:ABPerson", displayName: "Jane Doe", phones: ["+15555550124"], emails: [] },
        { recordId: "P-0002:ABPerson", displayName: "John Doe", phones: [], emails: ["john.doe@example.com"] },
      ],
      status: statusFrom(READ_WITH_CONTACTS),
    });
    mockCheckContactsPermission.mockResolvedValue(PERMISSION_GRANTED);

    const res = await invokeSync();

    expect(mockGetContactNames).toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.errorCode).toBeUndefined();
    expect(mockFullSync).toHaveBeenCalled();
    expect(mockCheckContactsPermission).not.toHaveBeenCalled();
  });

  /**
   * STATE 4 — stores are on disk, the directory listed (so TCC allowed the
   * tree), and not one store opened. Blaming Full Disk Access here would send
   * a user to grant a permission she already holds; calling it empty is the
   * bug this item exists to delete. It gets its own answer.
   */
  it("says the stores would not open when they exist and permission is held", async () => {
    mockGetContactNames.mockResolvedValue(emptyRead(FOUND_BUT_UNREADABLE));
    mockCheckContactsPermission.mockResolvedValue(PERMISSION_GRANTED);

    const res = await invokeSync();

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("CONTACTS_UNREADABLE");
    expect(res.error).not.toContain("Full Disk Access");
    expect(res.error).not.toContain("No contacts found");
  });

  /**
   * The coverage numbers BACKLOG-2404 added must still ride out on the failure
   * path. A caller that learns the cause but not the counts cannot tell
   * "found 2, opened 0" from "found nothing".
   */
  it("still returns the read coverage alongside the cause", async () => {
    mockGetContactNames.mockResolvedValue(emptyRead(FOUND_BUT_UNREADABLE));
    mockCheckContactsPermission.mockResolvedValue(PERMISSION_GRANTED);

    const res = await invokeSync();

    expect(res.read).toEqual({ found: 2, read: 0, failed: 2, coverage: "none" });
  });
});
