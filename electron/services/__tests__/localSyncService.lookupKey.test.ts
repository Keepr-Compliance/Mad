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
import databaseService from "../databaseService";
import { toLookupKey, toMatchingKey } from "../../utils/phoneNormalization";
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

/**
 * BACKLOG-2630 / SR blocker B1 — THE ANDROID PROMOTION DEDUP KEY MUST BE THE
 * KEY THE COLUMN HOLDS.
 *
 * `promoteToMainContacts` asks `findContactByNormalizedPhone` whether an Android
 * contact already exists before promoting it. That query compares
 * `contact_phones.phone_normalized`, which migration v64 re-keyed to the
 * libphonenumber form. The producer used to hand-roll the OLD key
 * (`digits.slice(-10)`), so post-v64 it asked for "4155550188" while the column
 * held "14155550188" — every lookup returns null, nothing looks like a
 * duplicate, and per the BACKLOG-2556 note in that file a re-pairing
 * re-promotes the ENTIRE Android address book as duplicate contacts.
 *
 * WHY NO EXISTING TEST CAUGHT IT: every phone fixture in reach used area code
 * 555, which is not assignable, so libphonenumber rejects it and `toLookupKey`
 * falls back to the pre-2630 digits. In that corpus the two key spaces coincide
 * and a hand-rolled caller looks correct. The numbers below are area code 415
 * with 555-01xx line numbers — parseable by the library AND inside the reserved
 * fictional range.
 *
 * This asserts the ARGUMENT the real producer emits, so it cannot drift from the
 * producer the way a transcription of its rule would.
 */
describe("promoteToMainContacts — the dedup probe uses the shared key (BACKLOG-2630 B1)", () => {
  const findSpy = databaseService.findContactByNormalizedPhone as jest.Mock;

  const PROMOTABLE: SyncContact[] = [
    { id: "301", displayName: "Ada Lovelace", phones: [{ number: "+14155550188" }], emails: [] },
    { id: "302", displayName: "Grace Hopper", phones: [{ number: "(415) 555-0177" }], emails: [] },
  ];

  it("probes with the key the re-keyed column holds, not a hand-rolled last-ten", () => {
    storeContacts(USER, DEVICE, PROMOTABLE, true);

    const probed = findSpy.mock.calls.map((c) => c[1] as string);

    // Identity, not "contains": the exact set the producer emitted.
    expect(new Set(probed)).toEqual(
      new Set([toLookupKey("+14155550188"), toLookupKey("(415) 555-0177")]),
    );
    // And stated as literals too, so a change to BOTH sides at once still reds.
    expect(new Set(probed)).toEqual(new Set(["14155550188", "14155550177"]));
  });

  it("the fixture can distinguish the bug: the old rule emits a different key", () => {
    // Without this, the assertion above would pass under a corpus where the two
    // key spaces coincide — which is precisely how B1 survived review.
    const oldRule = (phone: string): string => {
      const digits = phone.replace(/\D/g, "");
      return digits.length >= 10 ? digits.slice(-10) : digits;
    };
    expect(oldRule("+14155550188")).toBe("4155550188");
    expect(toLookupKey("+14155550188")).toBe("14155550188");
    expect(oldRule("+14155550188")).not.toBe(toLookupKey("+14155550188"));
  });

  it("still skips a below-floor number rather than probing with it", () => {
    // The site carried its own `< 7` floor. Routing through `toMatchingKey`
    // keeps that behaviour in the shared helper instead of a second hand-rolled
    // copy of it — a below-floor value emits no key and is never probed.
    storeContacts(USER, DEVICE, [
      { id: "303", displayName: "Short Code", phones: [{ number: "40219" }], emails: [] },
    ], true);

    expect(toMatchingKey("40219")).toBe("");
    expect(findSpy.mock.calls.map((c) => c[1] as string)).not.toContain("40219");
  });
});

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
