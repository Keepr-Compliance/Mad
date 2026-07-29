/**
 * BACKLOG-2208 — desktop contact store: full snapshot vs incremental diff.
 *
 * The desktop's contact reconcile (syncContactsBySource for 'android_sync')
 * upserts the batch AND stale-DELETES any 'android_sync' contact missing from
 * it. That is only correct for a FULL snapshot. This proves the storeContacts
 * branch:
 *   - isFullSync=true  -> syncContactsBySource (upsert + stale-delete);
 *   - isFullSync absent -> treated as FULL (legacy phone that sends everything);
 *   - isFullSync=false -> upsert ONLY (never stale-delete), so unchanged
 *     contacts omitted from a diff are NOT deleted.
 */

// Keep localSyncService importable under jest without touching the network/DB.
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getClient: () => ({ auth: { getUser: jest.fn() } }) },
}));

jest.mock("../db/externalContactDbService", () => ({
  __esModule: true,
  syncContactsBySource: jest.fn(() => ({
    inserted: 2,
    updated: 0,
    deleted: 0,
    total: 2,
  })),
  upsertExternalContacts: jest.fn(() => 2),
  updateLastMessageAtFromLookupTable: jest.fn(() => 0),
  getCount: jest.fn(() => 2),
}));

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    // Return null so promoteToMainContacts finds no existing match and the
    // batch-create path is a harmless no-op ([] created) for this unit test.
    findContactByNormalizedPhone: jest.fn(() => null),
    createContactsBatch: jest.fn(() => []),
  },
}));

import localSyncService from "../localSyncService";
import * as externalContactDb from "../db/externalContactDbService";
import type { SyncContact } from "../../types/localSync";

const syncSpy = externalContactDb.syncContactsBySource as jest.Mock;
const upsertSpy = externalContactDb.upsertExternalContacts as jest.Mock;
const updateLastMsgSpy =
  externalContactDb.updateLastMessageAtFromLookupTable as jest.Mock;

/** Access the private storeContacts, bound to the singleton (uses `this`). */
type StoreContacts = (
  userId: string,
  deviceId: string,
  contacts: SyncContact[],
  isFullSync?: boolean
) => number;
const storeContacts = (
  localSyncService as unknown as { storeContacts: StoreContacts }
).storeContacts.bind(localSyncService);

const USER = "user-1";
const DEVICE = "device-1";
const contacts: SyncContact[] = [
  { id: "c1", displayName: "Alice", phones: [{ number: "+15550000001" }], emails: [] },
  { id: "c2", displayName: "Bob", phones: [{ number: "+15550000002" }], emails: [] },
];

beforeEach(() => jest.clearAllMocks());

describe("storeContacts — full vs partial (BACKLOG-2208)", () => {
  it("FULL sync (isFullSync=true) reconciles via syncContactsBySource (upsert + stale-delete)", () => {
    storeContacts(USER, DEVICE, contacts, true);

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy.mock.calls[0][1]).toBe("android_sync");
    // The upsert-only path must NOT run on a full sync.
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("legacy phone (isFullSync absent) is treated as FULL — preserves stale-delete", () => {
    storeContacts(USER, DEVICE, contacts);

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("PARTIAL diff (isFullSync=false) upserts ONLY — never triggers stale-delete", () => {
    storeContacts(USER, DEVICE, contacts, false);

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][1]).toBe("android_sync");
    expect(updateLastMsgSpy).toHaveBeenCalledTimes(1);
    // The reconcile-with-stale-delete path must NOT run for a diff.
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it("PARTIAL upsert receives the deviceId-keyed external record ids", () => {
    storeContacts(USER, DEVICE, contacts, false);

    const upserted = upsertSpy.mock.calls[0][2] as Array<{
      external_record_id: string;
    }>;
    expect(upserted.map((c) => c.external_record_id)).toEqual([
      "android-device-1-c1",
      "android-device-1-c2",
    ]);
  });
});
