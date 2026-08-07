/**
 * BACKLOG-2493 — `contacts:get-edit-data` returns the contact's LIVE source set,
 * and OMITS the field rather than sending `[]`.
 *
 * WHY THE OMISSION IS THE PROPERTY UNDER TEST, NOT AN IMPLEMENTATION DETAIL
 *
 * `source_types` carries a three-state meaning that `undefined` and `[]` do not
 * share (see the `source_types` contract on the `Contact` interface):
 *
 *   - a non-empty array  -> these are the contact's live sources
 *   - ABSENT             -> we know of no source records; fall back to the
 *                           `contacts.source` scalar
 *   - `[]`               -> this contact HAS no sources — which no producer is
 *                           allowed to say, because it hides the contact from
 *                           every source filter leaf
 *
 * `getLiveSourcesForContact` returns `[]` for a contact with no links AND for a
 * database whose crosswalk table does not exist yet. Passing that straight
 * through would make this handler the first write path in the codebase to emit
 * `[]`. Nothing would break today: every current consumer tests `.length`
 * (`mapToSourcePillSources`) or handles `[]` deliberately (`contactFilterModel`).
 * It would surface the first time some consumer tests `=== undefined`.
 *
 * That is precisely why absorption is not enough to assert. A test that only
 * checked "the pill still falls back" would pass whether the handler sent `[]`
 * or omitted the field — the fallback absorbs both. So this file asserts the
 * omission directly, with `in` / `Object.keys`, which is the only check that can
 * tell the two apart. `toBeUndefined()` would NOT: it passes for a key that is
 * present with an undefined value.
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

import { registerContactHandlers } from "../contactHandlers";

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";

type EditDataResponse = {
  success: boolean;
  emails?: { id: string; email: string; is_primary: boolean }[];
  phones?: { id: string; phone: string; is_primary: boolean }[];
  source_types?: string[];
  error?: string;
};

async function invokeGetEditData(contactId: string): Promise<EditDataResponse> {
  const handler = handlers.get("contacts:get-edit-data");
  if (!handler) throw new Error("contacts:get-edit-data was never registered");
  return (await handler({}, contactId)) as EditDataResponse;
}

describe("contacts:get-edit-data — live source set (BACKLOG-2493)", () => {
  beforeAll(() => {
    registerContactHandlers({} as never);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // RFC 2606 / NANP only.
    mockGetContactEmailEntries.mockReturnValue([
      { id: "e1", email: "p.dorian@example.com", is_primary: true },
    ]);
    mockGetContactPhoneEntries.mockReturnValue([
      { id: "p1", phone: "+15550101001", is_primary: true },
    ]);
  });

  it("returns the live source set when the contact has links", async () => {
    // Transcribed from the producer: raw `contact_source_links.source_type`
    // values 'macos' and 'outlook' map through `toPersistedContactSource` to
    // exactly ["contacts_app","outlook"], sorted — recorded by executing the
    // mapper, see the header of ContactPreview.sourcePills-2493.test.tsx.
    mockGetLiveSourcesForContact.mockReturnValue(["contacts_app", "outlook"]);

    const result = await invokeGetEditData(CONTACT_ID);

    expect(result.success).toBe(true);
    expect(result.source_types).toEqual(["contacts_app", "outlook"]);
    expect(mockGetLiveSourcesForContact).toHaveBeenCalledWith(CONTACT_ID);
  });

  it("OMITS source_types entirely when the contact has no links — never []", async () => {
    mockGetLiveSourcesForContact.mockReturnValue([]);

    const result = await invokeGetEditData(CONTACT_ID);

    expect(result.success).toBe(true);
    // `in` and `Object.keys` are the assertions that distinguish "absent" from
    // "present and empty". `expect(result.source_types).toBeUndefined()` would
    // pass for BOTH, and `[]` is the value this field must never carry.
    expect("source_types" in result).toBe(false);
    expect(Object.keys(result)).not.toContain("source_types");
    expect(result.source_types).not.toEqual([]);
    // The rest of the response is unaffected by the omission.
    expect(result.emails).toHaveLength(1);
    expect(result.phones).toHaveLength(1);
  });

  it("OMITS source_types when the crosswalk table does not exist yet", async () => {
    // `getLiveSourcesForContact` returns [] for a pre-v57 database exactly as it
    // does for a contact with no links (`crosswalkExists()` guard), so the same
    // rule has to cover it — a migrating database must not be told that every
    // contact has no sources.
    mockGetLiveSourcesForContact.mockReturnValue([]);

    const result = await invokeGetEditData(CONTACT_ID);

    expect("source_types" in result).toBe(false);
  });
});
