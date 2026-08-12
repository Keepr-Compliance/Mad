/**
 * BACKLOG-2407 — the Android lookup key reaches storage, and the KEY DOES NOT
 * CHANGE.
 *
 * Two separate properties, and the second is the one most likely to be broken by
 * a well-meaning future edit:
 *
 *  1. `lookupKey` is carried into `source_identity`, so the identifier Android
 *     designates as sync-stable is captured rather than discarded on the line
 *     that builds the record id.
 *  2. `external_record_id` remains EXACTLY `android-{deviceId}-{contact.id}`.
 *     This task captures; it does not re-key. Silently switching the key to the
 *     lookup key would orphan every existing android_sync row — a changed id
 *     inserts a new row and the stale sweep deletes the old one, with no re-key
 *     path anywhere in the codebase.
 *
 * ⚠️ Capturing the lookup key does NOT make android contacts survive a device
 * swap, because `deviceId` is a desktop-minted per-pairing UUID. That decision
 * is recorded in full where the key is built (localSyncService.ts) and is
 * deliberately not addressed here.
 *
 * ASSERTION STYLE: exact record-id SETS and exact per-contact values.
 */

// Keep localSyncService importable under jest without touching the network/DB.
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getClient: () => ({ auth: { getUser: jest.fn() } }) },
}));

jest.mock("../db/externalContactDbService", () => ({
  __esModule: true,
  syncContactsBySource: jest.fn(() => ({ inserted: 2, updated: 0, deleted: 0, total: 2 })),
  upsertExternalContacts: jest.fn(() => 2),
  markSourceRecordsCurrent: jest.fn(() => 2),
  updateLastMessageAtFromLookupTable: jest.fn(() => 0),
  getCount: jest.fn(() => 2),
}));

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    findContactByNormalizedPhone: jest.fn(() => null),
    createContactsBatch: jest.fn(() => []),
  },
}));

import localSyncService from "../localSyncService";
import * as externalContactDb from "../db/externalContactDbService";
import type { SyncContact } from "../../types/localSync";

const syncSpy = externalContactDb.syncContactsBySource as jest.Mock;
const upsertSpy = externalContactDb.upsertExternalContacts as jest.Mock;

type StoreContacts = (
  userId: string,
  deviceId: string,
  contacts: SyncContact[],
  isFullSync?: boolean
) => number;
const storeContacts = (
  localSyncService as unknown as { storeContacts: StoreContacts }
).storeContacts.bind(localSyncService);

const USER = "user-2407";
const DEVICE = "device-abc";

const CONTACTS: SyncContact[] = [
  {
    id: "101",
    lookupKey: "0r1-4A3B2C",
    displayName: "Ada Lovelace",
    phones: [{ number: "+15555550104" }],
    emails: [],
  },
  {
    id: "102",
    lookupKey: "0r2-9F8E7D",
    displayName: "Grace Hopper",
    phones: [{ number: "+15555550107" }],
    emails: [],
  },
  {
    // No structured-name row on the device, so no lookup key exists for it.
    id: "201",
    displayName: "Org Only LLC",
    phones: [{ number: "+15555550108" }],
    emails: [],
  },
];

/** The ExternalContactInput[] handed to whichever storage path ran. */
function writtenBatch(): externalContactDb.ExternalContactInput[] {
  const call = syncSpy.mock.calls[0] ?? upsertSpy.mock.calls[0];
  return call[2] as externalContactDb.ExternalContactInput[];
}

beforeEach(() => jest.clearAllMocks());

describe("storeContacts — lookupKey capture (BACKLOG-2407)", () => {
  it("carries each contact's own lookupKey into source_identity", () => {
    storeContacts(USER, DEVICE, CONTACTS, true);

    const batch = writtenBatch();
    expect(
      new Map(batch.map((c) => [c.external_record_id, c.source_identity?.lookupKey]))
    ).toEqual(
      new Map([
        [`android-${DEVICE}-101`, "0r1-4A3B2C"],
        [`android-${DEVICE}-102`, "0r2-9F8E7D"],
        // Structurally absent, normalized to null so the serializer drops the
        // key rather than storing a present-but-null entry.
        [`android-${DEVICE}-201`, null],
      ])
    );
  });

  it("leaves external_record_id EXACTLY as it was — this is not a re-key", () => {
    storeContacts(USER, DEVICE, CONTACTS, true);

    // Asserted as the exact set. If a future change swapped the id component for
    // the lookup key, every existing android_sync row would orphan: a changed id
    // INSERTS a new row and the stale sweep removes the old one, and there is no
    // re-key path in the codebase.
    expect(new Set(writtenBatch().map((c) => c.external_record_id))).toEqual(
      new Set([
        `android-${DEVICE}-101`,
        `android-${DEVICE}-102`,
        `android-${DEVICE}-201`,
      ])
    );
  });

  it("captures on the incremental path too, not only on a full snapshot", () => {
    // A diff is the common case between full re-syncs; if capture only happened
    // on full snapshots, most contacts would go uncaptured for a day at a time.
    storeContacts(USER, DEVICE, CONTACTS, false);

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).not.toHaveBeenCalled();
    expect(
      new Map(writtenBatch().map((c) => [c.external_record_id, c.source_identity?.lookupKey]))
    ).toEqual(
      new Map([
        [`android-${DEVICE}-101`, "0r1-4A3B2C"],
        [`android-${DEVICE}-102`, "0r2-9F8E7D"],
        [`android-${DEVICE}-201`, null],
      ])
    );
  });

  it("accepts a legacy companion that sends no lookupKey at all", () => {
    // Wire compatibility: an already-installed companion does not send this
    // field, and the contacts payload has no per-field validation. Every such
    // contact must still sync, with the capture simply absent.
    const legacy: SyncContact[] = [
      { id: "101", displayName: "Ada Lovelace", phones: [{ number: "+15555550104" }], emails: [] },
    ];

    expect(() => storeContacts(USER, DEVICE, legacy, true)).not.toThrow();
    const batch = writtenBatch();
    expect(new Set(batch.map((c) => c.external_record_id))).toEqual(
      new Set([`android-${DEVICE}-101`])
    );
    expect(batch[0].source_identity?.lookupKey).toBeNull();
  });

  it("keeps a different deviceId in the key — the scoping is unchanged", () => {
    // Pins the behaviour the recorded deviceId decision describes: the same
    // contact re-keys under a new pairing. Documented as the known defect, and
    // asserted here so a later fix is a deliberate change to a failing test
    // rather than an accident.
    storeContacts(USER, "device-xyz", [CONTACTS[0]], true);

    expect(new Set(writtenBatch().map((c) => c.external_record_id))).toEqual(
      new Set(["android-device-xyz-101"])
    );
  });
});
