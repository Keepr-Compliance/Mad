/**
 * BACKLOG-2556 / BACKLOG-2496 — the Android promote must CLAIM the record it
 * promoted, in the crosswalk, keyed exactly as `external_contacts` spells it.
 *
 * ===========================================================================
 * WHY THIS TEST EXISTS BEFORE ANY DELETION
 * ===========================================================================
 * BACKLOG-2496 is explicit: the content-matching fallbacks in
 * `contacts:get-available` "are load-bearing until every path writes the
 * origin. Deleting them early makes every contact created by a skipping path
 * look un-imported — the duplicate reappears for a different reason."
 *
 * The type-level half of 2496 landed and holds: `origin` is a REQUIRED argument
 * of contact creation, and `writeContactOriginInTransaction` writes a synthetic
 * origin row for every contact. But the precondition the DELETION needs is
 * narrower and stronger than "every contact has an origin":
 *
 *     Every path that creates a contact FROM an external record must CLAIM that
 *     record in the crosswalk — because after the deletion, the crosswalk key
 *     `(source_type, source_record_id)` is the ONLY thing left that can suppress
 *     the record.
 *
 * A `{ kind: "derived" }` origin writes the SYNTHETIC key `origin:<contactId>`
 * (`contactOriginLink.ts`), which matches no external record, by design.
 *
 * `promoteToMainContacts` auto-creates a contact for every Android record and
 * passed `{ kind: "derived" }`, on the stated grounds that it "holds no external
 * record id to point at". It does hold one: `storeContacts` — the SAME method,
 * one call frame up — writes those records to `external_contacts` under
 * `android-<deviceId>-<contact.id>`, and `android_sync` is a member of
 * `EXTERNAL_SOURCE_TYPES` with its own branch in `contacts:get-available`.
 *
 * So without this fix, deleting the content fallbacks would show every
 * Android-promoted contact TWICE — once as the saved contact, once as its
 * unclaimed record. Today that is masked by `phoneClaimedByImported`, which is
 * one of the fallbacks being deleted.
 *
 * ===========================================================================
 * THE ASSERTION THAT MATTERS MOST IS THE ONE ABOUT SPELLING
 * ===========================================================================
 * `promotedIdentitiesMatchStoredRecordIds` compares the claim against the id
 * that ACTUALLY went into `external_contacts` in the same call — not against a
 * string literal restating the format. A second spelling of one id is the
 * `contacts_app`/`macos` trap that `contactOriginLink.ts` is written to prevent,
 * and a literal in a test cannot catch it because the literal is the second
 * spelling. Both call sites now go through one shared helper; this is what
 * keeps them there.
 */

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
    // No existing contact by phone, so every contact reaches the create path.
    findContactByNormalizedPhone: jest.fn(() => null),
    createContactsBatch: jest.fn(() => ["new-1", "new-2"]),
  },
}));

import localSyncService from "../localSyncService";
import * as externalContactDb from "../db/externalContactDbService";
import databaseService from "../databaseService";
import type { SyncContact } from "../../types/localSync";
import type { ContactOrigin } from "../db/contactOriginLink";

const syncSpy = externalContactDb.syncContactsBySource as jest.Mock;
const createBatchSpy = databaseService.createContactsBatch as unknown as jest.Mock;

type StoreContacts = (
  userId: string,
  deviceId: string,
  contacts: SyncContact[],
  isFullSync?: boolean,
) => number;

const storeContacts = (
  localSyncService as unknown as { storeContacts: StoreContacts }
).storeContacts.bind(localSyncService);

const USER = "user-1";
const DEVICE = "device-1";

// 555-0100..555-0199 is the range reserved for fictional use; the numbers are
// arbitrary here (the phone lookup is mocked) but must not look like real ones.
const contacts: SyncContact[] = [
  { id: "c1", displayName: "Alice", phones: [{ number: "+14085550110" }], emails: [] },
  { id: "c2", displayName: "Bob", phones: [{ number: "+14085550111" }], emails: [] },
];

type CreatedContact = { display_name: string; source: string; origin: ContactOrigin };

/** The contacts the promote handed to the batch create, in input order. */
function promotedContacts(): CreatedContact[] {
  expect(createBatchSpy).toHaveBeenCalledTimes(1);
  return createBatchSpy.mock.calls[0][0] as CreatedContact[];
}

/** The external_record_ids the SAME call wrote into `external_contacts`. */
function storedRecordIds(): string[] {
  expect(syncSpy).toHaveBeenCalledTimes(1);
  const stored = syncSpy.mock.calls[0][2] as Array<{ external_record_id: string }>;
  return stored.map((r) => r.external_record_id);
}

beforeEach(() => jest.clearAllMocks());

describe("promoteToMainContacts claims the record it promoted (BACKLOG-2556)", () => {
  it("passes a sourceRecords origin, not a derived one", () => {
    storeContacts(USER, DEVICE, contacts, true);

    for (const created of promotedContacts()) {
      expect(created.origin.kind).toBe("sourceRecords");
    }
  });

  it("claims (android_sync, <the id actually stored>) for every promoted contact", () => {
    storeContacts(USER, DEVICE, contacts, true);

    const claimed = promotedContacts().map((c) => {
      const origin = c.origin;
      if (origin.kind !== "sourceRecords") throw new Error("expected a sourceRecords origin");
      // Exactly one identity per promoted contact: one record, one claim.
      expect(origin.identities).toHaveLength(1);
      return origin.identities[0];
    });

    expect(claimed.map((i) => i.sourceType)).toEqual(["android_sync", "android_sync"]);

    // THE SPELLING ASSERTION. Compared against what the same call actually
    // wrote to `external_contacts`, never against a literal restating the
    // format — a literal is itself a second spelling and cannot catch a drift.
    expect(claimed.map((i) => i.sourceRecordId)).toEqual(storedRecordIds());
  });

  it("the claimed key is the deviceId-scoped one the crosswalk will look up", () => {
    storeContacts(USER, DEVICE, contacts, true);

    // Belt and braces on top of the identity comparison above: if BOTH sites
    // drifted together, the comparison would still pass and this would not.
    // Kept deliberately: the two assertions fail for different reasons.
    expect(storedRecordIds()).toEqual(["android-device-1-c1", "android-device-1-c2"]);
  });

  it("a contact already present by phone is not promoted, and claims nothing", () => {
    (databaseService.findContactByNormalizedPhone as unknown as jest.Mock).mockReturnValueOnce({
      id: "existing-1",
    });

    storeContacts(USER, DEVICE, contacts, true);

    const promoted = promotedContacts();
    expect(promoted.map((c) => c.display_name)).toEqual(["Bob"]);
  });
});
