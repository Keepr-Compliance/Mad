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
  default: {
    getClient: () => ({ auth: { getUser: jest.fn() } }),
    // BACKLOG-2986: `storeContacts` now reads `androidContacts` before it
    // promotes, via the REAL `preferenceHelper`. Stated explicitly rather than
    // left to the helper's catch: without this key the read would throw, the
    // helper would fail open to `true`, and every case below would be green by
    // accident instead of by design. `localSyncService.writeGate-2986.test.ts`
    // is where the gate itself is swept.
    getPreferences: jest.fn().mockResolvedValue({
      phone_type: "android",
      contactSources: { direct: { androidContacts: true } },
    }),
  },
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
  // BACKLOG-2401: the partial path must re-stamp the whole source after its
  // upsert, or the identity crosswalk's reassignment guard goes silently dead
  // for android_sync between full snapshots.
  markSourceRecordsCurrent: jest.fn(() => 2),
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
const markCurrentSpy =
  externalContactDb.markSourceRecordsCurrent as jest.Mock;

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
  it("FULL sync (isFullSync=true) reconciles via syncContactsBySource (upsert + stale-delete)", async () => {
    await storeContacts(USER, DEVICE, contacts, true);

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy.mock.calls[0][1]).toBe("android_sync");
    // The upsert-only path must NOT run on a full sync.
    expect(upsertSpy).not.toHaveBeenCalled();
    // BACKLOG-2401: nor the re-stamp. A full snapshot upserts everything the
    // source returned and then prunes, so every surviving row already carries
    // the batch stamp — re-stamping here would be redundant, and would also
    // re-stamp rows the prune is about to delete.
    expect(markCurrentSpy).not.toHaveBeenCalled();
  });

  it("legacy phone (isFullSync absent) is treated as FULL — preserves stale-delete", async () => {
    await storeContacts(USER, DEVICE, contacts);

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("PARTIAL diff (isFullSync=false) upserts ONLY — never triggers stale-delete", async () => {
    await storeContacts(USER, DEVICE, contacts, false);

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][1]).toBe("android_sync");
    expect(updateLastMsgSpy).toHaveBeenCalledTimes(1);
    // The reconcile-with-stale-delete path must NOT run for a diff.
    expect(syncSpy).not.toHaveBeenCalled();

    // BACKLOG-2401: skipping the stale-delete asserts "rows I did not mention
    // are still present". That assertion has to be WRITTEN DOWN, because a diff
    // leaves unchanged rows carrying an older `synced_at` and the crosswalk
    // reads that column to decide whether a competing source record is a live
    // claim. Without this call the reassignment guard is structurally disabled
    // for android_sync between full snapshots — and it fails toward a SILENT
    // WRONG LINK, not toward over-flagging.
    expect(markCurrentSpy).toHaveBeenCalledTimes(1);
    expect(markCurrentSpy.mock.calls[0][0]).toBe(USER);
    expect(markCurrentSpy.mock.calls[0][1]).toBe("android_sync");
  });

  it("PARTIAL upsert receives the deviceId-keyed external record ids", async () => {
    await storeContacts(USER, DEVICE, contacts, false);

    const upserted = upsertSpy.mock.calls[0][2] as Array<{
      external_record_id: string;
    }>;
    expect(upserted.map((c) => c.external_record_id)).toEqual([
      "android-device-1-c1",
      "android-device-1-c2",
    ]);
  });
});
