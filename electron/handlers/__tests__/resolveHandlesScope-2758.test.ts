/**
 * BACKLOG-2758 — THE IN-APP PATH MUST CARRY THE TRANSACTION SCOPE.
 *
 * ===========================================================================
 * THE DEFECT THIS FILE EXISTS TO KEEP DEAD
 * ===========================================================================
 * The transaction-scoping fix landed on the EXPORT path only. `folderExportService`
 * passed `{ userId, transactionId }` to the shared resolver; the IPC handler
 * behind `window.api.contacts.resolveHandles` passed NO scope at all — and could
 * not have, because the contract had no parameter to put a transaction id in.
 *
 * With no scope, `scope?.transactionId ?? null` is null, no row is ever marked
 * `is_transaction_linked`, and `namesForHandle`'s
 * `const scoped = linked.length > 0 ? linked : matches` falls through to ALL
 * matches. So a number held by two saved contacts kept rendering as "A or B" on
 * the Texts tab AFTER one of the two was unlinked from the deal, while the
 * export named only the remaining party. Two surfaces, one thread, two answers,
 * and unlinking could not change the in-app one because nothing on that path
 * knew what "linked" meant.
 *
 * The FOUNDER found this by unlinking a duplicate contact and comparing the two.
 *
 * ===========================================================================
 * WHY THE ASSERTIONS ARE ABOUT THE SCOPE OBJECT AND NOT ABOUT NAMES
 * ===========================================================================
 * This file owns ONE seam: the handler builds a scope and hands it to the shared
 * resolver. What the scope then MEANS — which names survive it — is a property of
 * the resolver over a real database, and is pinned separately in
 * `electron/services/__tests__/inAppHandleScope-2758.test.ts`, which runs the
 * real driver. Neither file is sufficient alone: this one would stay green if
 * the scope stopped doing anything, and that one would stay green if the handler
 * stopped sending it. The control notes below say which mutation reds which.
 *
 * ===========================================================================
 * CONTROLS — MEASURED. Run with `--bail=0`; jest.config.js sets `bail: 1`, so any
 * count taken without it is a FLOOR and cannot be compared.
 * ===========================================================================
 *   C1  THE DEFECT ITSELF — in electron/handlers/contactHandlers.ts, revert the
 *       call to the pre-fix `resolveHandles(handles, validatedUserId ?? undefined)`.
 *       -> MEASURED: see the PR body. Reds this file's scope legs.
 *
 *   C2  THE WIRE OVERRIDES THE VALIDATED USER — in the same call, forward the
 *       wire scope verbatim (`...scope`) so a renderer-supplied `userId` reaches
 *       `resolvePhoneNames`, which resolves it as `scope?.userId ?? userId`.
 *       -> Reds the "cannot widen the hard filter" leg.
 *
 * RUNNER: npx jest --bail=0 electron/handlers/__tests__/resolveHandlesScope-2758.test.ts
 */

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
jest.mock("../../services/contactsService", () => ({ __esModule: true, getContactNames: jest.fn() }));
const mockResolveHandles = jest.fn();
jest.mock("../../services/contactResolutionService", () => ({
  __esModule: true,
  resolveHandles: (...a: unknown[]) => mockResolveHandles(...a),
}));
jest.mock("../../services/auditService", () => ({ __esModule: true, default: { log: jest.fn() } }));
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../services/db/externalContactDbService", () => ({ __esModule: true }));
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


jest.mock("../../services/contactManualLink", () => ({
  __esModule: true,
  findLinkableSourceRecords: jest.fn(() => []),
  linkSourceRecordsToContact: jest.fn(() => [{ ok: true, linkId: "link-1" }]),
}));

const mockGetValidUserId = jest.fn();
jest.mock("../../utils/userIdHelper", () => ({
  __esModule: true,
  getValidUserId: (...a: unknown[]) => mockGetValidUserId(...a),
  getValidUserIdSync: jest.fn(),
}));


import { registerContactHandlers } from "../contactHandlers";

const USER_ID = "22222222-2222-4222-8222-222222222222"; // pii-allow-uuid: invented, not from any live row
/** A DIFFERENT user, named by the renderer to try to widen the hard filter. */
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333"; // pii-allow-uuid: invented, not from any live row
const TX_ID = "44444444-4444-4444-8444-444444444444"; // pii-allow-uuid: invented, not from any live row
const SHARED_PHONE = "+15035550152";

type ResolveResponse = { success: boolean; names: Record<string, string>; error?: string };

async function invokeResolve(...args: unknown[]): Promise<ResolveResponse> {
  const handler = handlers.get("contacts:resolve-handles");
  if (!handler) throw new Error("contacts:resolve-handles was never registered");
  return (await handler({}, ...args)) as ResolveResponse;
}

/** The scope object the handler handed the shared resolver on the last call. */
function scopeSentToResolver(): { userId?: unknown; transactionId?: unknown } {
  expect(mockResolveHandles).toHaveBeenCalledTimes(1);
  return mockResolveHandles.mock.calls[0][2] as { userId?: unknown; transactionId?: unknown };
}

describe("BACKLOG-2758 — contacts:resolve-handles carries a transaction scope", () => {
  beforeAll(() => {
    registerContactHandlers({} as never);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetValidUserId.mockResolvedValue(USER_ID);
    mockResolveHandles.mockResolvedValue({ names: {}, matches: {} });
  });

  it("forwards the transaction id the renderer supplied", async () => {
    // The Texts tab / removed-threads tuple. Before this fix the third argument
    // did not exist and this expectation could not be written.
    await invokeResolve([SHARED_PHONE], USER_ID, { transactionId: TX_ID });
    expect(scopeSentToResolver().transactionId).toBe(TX_ID);
  });

  it("sends an EXPLICIT null transaction when the caller omits the scope", async () => {
    // The attach-picker tuple. Asserted as `null` rather than "not TX_ID",
    // because `namesForHandle` treats absent-and-null identically and a leg
    // that only checked inequality would pass on a typo'd key.
    await invokeResolve([SHARED_PHONE], USER_ID);
    expect(scopeSentToResolver().transactionId).toBeNull();
  });

  it("still passes the transaction id when the handles list is a single handle", async () => {
    // Anti-vacuity: proves the legs above measure the scope and not some
    // batching path that only runs for multi-handle calls.
    await invokeResolve([SHARED_PHONE], USER_ID, { transactionId: TX_ID });
    expect(mockResolveHandles).toHaveBeenCalledWith(
      [SHARED_PHONE],
      USER_ID,
      { userId: USER_ID, transactionId: TX_ID },
    );
  });

  it("uses the VALIDATED user id, not the one the renderer typed", async () => {
    // getValidUserId is the gate; the handler must send its answer onward.
    mockGetValidUserId.mockResolvedValue(USER_ID);
    await invokeResolve([SHARED_PHONE], OTHER_USER_ID, { transactionId: TX_ID });
    expect(scopeSentToResolver().userId).toBe(USER_ID);
  });

  it("cannot be made to widen the hard filter by naming a user in the scope", async () => {
    // THE SEAM THIS PR OPENS. `resolvePhoneNames` reads `scope?.userId ?? userId`,
    // so a scope forwarded verbatim from the wire would let the renderer's
    // `scope.userId` OUTRANK the validated id and pull another user's contacts
    // into this user's names. The wire type has no `userId` field; this proves
    // the handler does not read one at runtime either, which is where it counts.
    await invokeResolve([SHARED_PHONE], USER_ID, {
      transactionId: TX_ID,
      userId: OTHER_USER_ID,
    });
    const scope = scopeSentToResolver();
    expect(scope.userId).toBe(USER_ID);
    expect(scope.transactionId).toBe(TX_ID);
  });

  it("resolves with no user at all when the id fails validation, and still scopes", async () => {
    // An unvalidatable user must not silently become "every user". Both fields
    // are asserted so a fix that dropped the scope on this branch would red.
    mockGetValidUserId.mockResolvedValue(null);
    await invokeResolve([SHARED_PHONE], "not-a-user", { transactionId: TX_ID });
    const scope = scopeSentToResolver();
    expect(scope.userId).toBeUndefined();
    expect(scope.transactionId).toBe(TX_ID);
  });

  it("still refuses a non-array handles argument", async () => {
    // The new parameter must not have widened what the channel accepts.
    const res = await invokeResolve("not-an-array", USER_ID, { transactionId: TX_ID });
    expect(res.success).toBe(false);
    expect(res.error).toBe("handles must be an array");
    expect(mockResolveHandles).not.toHaveBeenCalled();
  });
});
