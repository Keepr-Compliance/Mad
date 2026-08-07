/**
 * BACKLOG-2426 / M1 — THE TWO REFUSALS OF `requireSourceRecordIdArg` MUST BE
 * TELLABLE APART.
 *
 * `external_contacts.external_record_id` is minted by the ADDRESS BOOK, not by
 * us: `outlookFetchService` stores the Microsoft Graph contact id verbatim. So
 * `requireUuidArg`'s 64-character cap would refuse a legitimate Outlook record
 * — the founder's exact case — and this handler uses a 512 bound instead.
 *
 * **512 is headroom over the longest identifier any supported source is known
 * to mint. It is a sanity bound on an opaque third-party token, NOT a measured
 * format.** The repo's Graph fixtures are truncated stubs (`AAMkAG123`), so
 * nothing here can establish the real length, and no number in this file claims
 * to have been observed in production.
 *
 * Which is exactly why the two conditions must not share a message. If the
 * bound is ever wrong the symptom is an Outlook record silently refusing to
 * link — the same bug class this feature exists to fix — and a single message
 * would leave the log unable to distinguish "too long" from "empty".
 *
 * CONTROL: recombine the two throws into the original single condition with one
 * message. OBSERVED: 2 failed / 1 passed of 3 — both refusals report the same
 * string, so neither test can name which condition fired. The third (a long,
 * legitimate provider id is accepted) stays green, which is the point: the
 * bound itself is unchanged and only its DIAGNOSABILITY regressed.
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
jest.mock("../../services/contactResolutionService", () => ({ __esModule: true, resolveHandles: jest.fn() }));
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
import { linkSourceRecordsToContact } from "../../services/contactManualLink";

const USER_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "11111111-1111-4111-8111-111111111111";

type LinkResponse = { success: boolean; outcome?: unknown; error?: string };

/**
  * BACKLOG-2591: the channel takes a LIST now. The guarantee under test is
  * unchanged — each member is validated with the same two checks — so this
  * wraps the single id rather than weakening the assertions.
  */
async function invokeLinkSource(sourceRecordId: unknown): Promise<LinkResponse> {
  const handler = handlers.get("contacts:link-source");
  if (!handler) throw new Error("contacts:link-source was never registered");
  return (await handler({}, USER_ID, CONTACT_ID, [
    { sourceType: "outlook", sourceRecordId },
  ])) as LinkResponse;
}

describe("requireSourceRecordIdArg — a refusal must name its own cause (M1)", () => {
  beforeAll(() => {
    registerContactHandlers({} as never);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetValidUserId.mockResolvedValue(USER_ID);
  });

  it("says EMPTY when the id is missing, and links nothing", async () => {
    const res = await invokeLinkSource("");
    expect(res.success).toBe(false);
    expect(res.error).toBe("Validation error: sourceRecordId is missing or empty");
    expect(linkSourceRecordsToContact).not.toHaveBeenCalled();
  });

  it("says TOO LONG when the id exceeds the bound, and links nothing", async () => {
    const res = await invokeLinkSource("A".repeat(513));
    expect(res.success).toBe(false);
    expect(res.error).toBe(
      "Validation error: sourceRecordId is longer than the 512-character limit",
    );
    expect(linkSourceRecordsToContact).not.toHaveBeenCalled();
  });

  /**
   * The bound must not refuse a plausible Graph id. 512 chars is well beyond
   * any known provider identifier; a 200-character token stands in for "long,
   * opaque, and legitimate" without asserting that Graph ids are 200 chars.
   */
  it("accepts a long opaque provider id and passes it through untouched", async () => {
    const graphish = "AAMkAG" + "a".repeat(194);
    const res = await invokeLinkSource(graphish);
    expect(res.success).toBe(true);
    expect(linkSourceRecordsToContact).toHaveBeenCalledWith(
      USER_ID,
      CONTACT_ID,
      [{ sourceType: "outlook", sourceRecordId: graphish }],
      { acknowledgedPriorRejections: [] },
    );
  });
});
