/**
 * @jest-environment node
 *
 * BACKLOG-2612 — THE EVIDENCE QUERIES COLLECT BY CONTACT, AND THE HANDLE
 * RESOLVERS ARE GLOBAL, LAST-WRITE-WINS, UNSCOPED.
 *
 * The item's most important correction (plan §1a, SR-confirmed): the export's
 * email sweep is driven by TWO queries, and the item body named only one.
 *
 *   1. `getContactEmailsForTransaction`
 *      (electron/services/db/contactDbService.ts) — the manual
 *      unlinked-email search filter (sole production call site:
 *      electron/services/emailSyncService.ts:1250).
 *   2. `getEmailsByContactId` as driven through `ensureTransactionEmailsSynced`
 *      (electron/services/transactionSyncTrigger.ts) — the EXPORT-TRIGGERED
 *      sweep: every export IPC handler awaits it before exporting. This is the
 *      query where a grouping leak changes what the audit COLLECTS, not merely
 *      how it describes a party.
 *
 * Both are pinned by EXACT EMAIL SET — a count would pass while collecting a
 * stranger's mail. Both queries are unfiltered by `is_primary` (every address
 * a contact holds is swept) and unfiltered by `contacts.removed_at` (a
 * tombstoned-but-attached party's mail keeps being collected — written policy,
 * electron/services/db/contactTombstoneSql.ts:32-37).
 *
 * Also pinned here: the handle→name resolvers the item body flags as the
 * second omitted site (electron/utils/exportUtils.ts). They resolve GLOBALLY —
 * unscoped by transaction, unscoped by user — and a shared handle has ONE
 * arbitrary winner (`result[key] = name` over an unordered result set).
 *
 * CONTROLS (mutations run manually, full paths, results on BACKLOG-2612):
 *   E1  getContactEmailsForTransaction: `JOIN contact_emails ce ON 1=1`
 *       (electron/services/db/contactDbService.ts) → RED on the exact set.
 *   E2  getEmailsByContactId: drop the WHERE
 *       (electron/services/db/contactDbService.ts) → RED on the exact set.
 *   E3  add `AND c.removed_at IS NULL`-style tombstone filter via
 *       `JOIN contacts c` to getContactEmailsForTransaction → RED on the
 *       tombstoned-collection test.
 *   E4  exportUtils.getContactNamesByEmails: add a `c.removed_at IS NULL`
 *       filter (electron/utils/exportUtils.ts) → RED on the tombstone
 *       resolution test.
 *
 * RUNNER:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     --bail=0 electron/services/db/__tests__/exportEvidenceQueries-2612.test.ts
 */

// The export-triggered sweep is observed at its provider boundary: the
// fetch layer is mocked, everything below it (transaction lookup, contact
// assignments, the evidence query itself) runs REAL against the fixture DB.
jest.mock("../../emailSyncService", () => ({
  __esModule: true,
  EMAIL_CACHE_FRESHNESS_MS: 5 * 60 * 1000,
  default: {
    syncTransactionEmails: jest.fn(async () => undefined),
  },
}));
jest.mock("../emailSyncStateService", () => ({
  __esModule: true,
  resolveMailboxAccountId: jest.fn((_userId: string, provider: string) =>
    provider === "google" ? "acct-2612-google" : null,
  ),
  getSyncState: jest.fn(() => null),
  updateCachedBounds: jest.fn(),
  recordSyncSuccess: jest.fn(),
  recordSyncFailure: jest.fn(),
}));
jest.mock("../../autoLinkService", () => ({
  __esModule: true,
  autoLinkCommunicationsForContact: jest.fn(async () => undefined),
}));

import {
  createExportFixture,
  type ExportFixture,
} from "../../folderExport/__tests__/helpers/exportCaptureFixture2612";
import {
  getContactEmailsForTransaction,
  getEmailsByContactId,
  deleteContact,
} from "../contactDbService";
import { unlinkContactFromTransaction } from "../transactionContactDbService";
import { getContactNamesByPhones, getContactNamesByEmails } from "../../../utils/exportUtils";
import {
  getContactNamesByPhoneDigits,
  getContactNamesByEmails as getAttachmentContactNamesByEmails,
  getContactNameByAppleIdPrefix,
} from "../attachmentDbService";
import { ensureTransactionEmailsSynced } from "../../transactionSyncTrigger";
import emailSyncService from "../../emailSyncService";

const USER_ID = "user-2612-ev";
const OTHER_USER_ID = "user-2612-other";
const TX = "tx-2612-ev";
const TX_OTHER = "tx-2612-ev-other";

const CHRIS = {
  id: "c-ev-chris",
  name: "Chris Alvarez",
  primaryEmail: "chris.alvarez@example.com",
  secondEmail: "Chris.A.Work@example.com", // mixed case on purpose: the sweep lowercases
  phone: "+15035550140",
};
const DANA = {
  id: "c-ev-dana",
  name: "Dana Alvarez",
  primaryEmail: "dana.alvarez@example.com",
  phone: "+15035550141",
};
const SHARED_EMAIL = "shared.alvarez@example.com";
const SHARED_PHONE = "+15035550142";
/** Attached to the OTHER transaction only. */
const PAT = { id: "c-ev-pat", name: "Pat Riverton", primaryEmail: "pat.riverton@example.com", phone: "+15035550143" };
/** Attached to TX, then taken OFF the deal (tc.removed_at) before assertions. */
const ROBIN = { id: "c-ev-robin", name: "Robin Marsh", primaryEmail: "robin.marsh@example.com" };
/** Belongs to a DIFFERENT user — the resolver-unscoped characterization. */
const SAM = { id: "c-ev-sam", name: "Sam Rivers", primaryEmail: "sam.rivers@example.com" };

let fx: ExportFixture;

beforeAll(async () => {
  fx = await createExportFixture();
  fx.seedUser(USER_ID, "owner-2612-ev@example.com", "Test User");
  fx.seedUser(OTHER_USER_ID, "other-2612-ev@example.com", "Test Contact");
  fx.seedTransaction({
    id: TX,
    userId: USER_ID,
    address: "114 Cypress Ave",
    startedAt: "2026-01-01 00:00:00",
    closedAt: "2026-03-01 00:00:00",
  });
  fx.seedTransaction({ id: TX_OTHER, userId: USER_ID, address: "77 Juniper Ct" });

  fx.seedContact({
    id: CHRIS.id,
    userId: USER_ID,
    displayName: CHRIS.name,
    emails: [
      { email: CHRIS.primaryEmail, isPrimary: true },
      { email: CHRIS.secondEmail }, // NON-primary: must still be swept
      { email: SHARED_EMAIL },
    ],
    phones: [{ phone: SHARED_PHONE, isPrimary: true }, { phone: CHRIS.phone }],
  });
  fx.seedContact({
    id: DANA.id,
    userId: USER_ID,
    displayName: DANA.name,
    emails: [{ email: DANA.primaryEmail, isPrimary: true }, { email: SHARED_EMAIL }],
    phones: [{ phone: SHARED_PHONE, isPrimary: true }, { phone: DANA.phone }],
  });
  fx.seedContact({
    id: PAT.id,
    userId: USER_ID,
    displayName: PAT.name,
    emails: [{ email: PAT.primaryEmail, isPrimary: true }],
    phones: [{ phone: PAT.phone, isPrimary: true }],
  });
  fx.seedContact({
    id: ROBIN.id,
    userId: USER_ID,
    displayName: ROBIN.name,
    emails: [{ email: ROBIN.primaryEmail, isPrimary: true }],
  });
  fx.seedContact({
    id: SAM.id,
    userId: OTHER_USER_ID,
    displayName: SAM.name,
    emails: [{ email: SAM.primaryEmail, isPrimary: true }],
  });

  fx.attachContact({ transactionId: TX, contactId: CHRIS.id, role: "buyer", isPrimary: true, createdAt: "2026-01-05 10:00:00" });
  fx.attachContact({ transactionId: TX, contactId: DANA.id, role: "buyer", createdAt: "2026-01-05 10:01:00" });
  fx.attachContact({ transactionId: TX, contactId: ROBIN.id, role: "inspector", createdAt: "2026-01-05 10:02:00" });
  fx.attachContact({ transactionId: TX_OTHER, contactId: PAT.id, role: "seller", createdAt: "2026-01-05 10:00:00" });

  // Take Robin OFF the deal through the production writer (tombstones the
  // junction row — tc.removed_at, "off this deal", distinct from the contact
  // tombstone exercised below).
  await unlinkContactFromTransaction(TX, ROBIN.id, "test");
}, 120_000);

afterAll(async () => {
  await fx.cleanup();
});

describe("BACKLOG-2612 — evidence queries collect by contact", () => {
  test("getContactEmailsForTransaction: the exact set is every address of every ATTACHED contact — non-primary included, shared deduped, off-deal and other-deal excluded", () => {
    const collected = getContactEmailsForTransaction(TX).sort();
    expect(collected).toEqual(
      [
        CHRIS.primaryEmail,
        CHRIS.secondEmail.toLowerCase(), // lowercased by the query
        SHARED_EMAIL, // held by both parties; SELECT DISTINCT collapses to one
        DANA.primaryEmail,
      ].sort(),
    );
    // Robin (taken off the deal) and Pat (a different deal) are OUT — by
    // exact-set equality above, not by a separate count.
  });

  test("getEmailsByContactId: exactly one contact's addresses, is_primary NOT filtered", () => {
    expect(getEmailsByContactId(CHRIS.id).sort()).toEqual(
      [CHRIS.primaryEmail, CHRIS.secondEmail, SHARED_EMAIL].sort(),
    );
    expect(getEmailsByContactId(DANA.id).sort()).toEqual([DANA.primaryEmail, SHARED_EMAIL].sort());
  });

  test("the EXPORT-TRIGGERED sweep hands the provider exactly the attached contacts' lowercased address union", async () => {
    const syncMock = emailSyncService.syncTransactionEmails as jest.Mock;
    syncMock.mockClear();

    const result = await ensureTransactionEmailsSynced({
      transactionId: TX,
      userId: USER_ID,
      reason: "export", // BYPASS_THROTTLE — the export path's reason
    });

    expect(result.ran).toBe(true);
    expect(syncMock).toHaveBeenCalled();
    const contactEmails = (syncMock.mock.calls[0][0] as { contactEmails: string[] }).contactEmails;
    expect([...contactEmails].sort()).toEqual(
      [
        CHRIS.primaryEmail,
        CHRIS.secondEmail.toLowerCase(),
        SHARED_EMAIL,
        DANA.primaryEmail,
      ].sort(),
    );
  });

  test("a TOMBSTONED-but-attached party's mail keeps being collected (written policy, not a bug)", async () => {
    // The real producer: deleteContact writes the contact tombstone and leaves
    // every transaction role untouched.
    await deleteContact(DANA.id, "user_deleted");

    expect(getContactEmailsForTransaction(TX).sort()).toEqual(
      [
        CHRIS.primaryEmail,
        CHRIS.secondEmail.toLowerCase(),
        SHARED_EMAIL,
        DANA.primaryEmail, // still swept — removal does not redact the audit
      ].sort(),
    );
    expect(getEmailsByContactId(DANA.id).sort()).toEqual([DANA.primaryEmail, SHARED_EMAIL].sort());
  });
});

describe("BACKLOG-2612 — handle resolvers: global, last-write-wins, unscoped", () => {
  // Dana is tombstoned HERE, not left to a test in the describe block above.
  //
  // Found by running control E4 (add `AND c.removed_at IS NULL` to
  // electron/utils/exportUtils.ts getContactNamesByEmails): the tombstone
  // assertion below stayed GREEN under `-t` filtering, because the only
  // producer of the tombstone lived in another describe block that the filter
  // skipped. The control was right and the fixture was wrong — the test was
  // passing on a LIVE contact, proving nothing about tombstones. deleteContact
  // is `WHERE id = ? AND removed_at IS NULL`, so calling it again is a no-op.
  beforeAll(async () => {
    await deleteContact(DANA.id, "user_deleted");
  });

  // =========================================================================
  // BACKLOG-2757 — THESE TWO LEGS FLIPPED. That flip IS the fix's evidence.
  //
  // They used to say "one of the two holders wins, and we will not assert which
  // because the code does not guarantee an order". That was an honest reading of
  // a coin flip. There is now an order, and a rule, so the winner-that-cannot-
  // be-named is replaced by an EXACT STRING that names both people.
  // =========================================================================

  test("a SHARED email resolves to ONE key naming BOTH holders, in declared order", () => {
    const map = getContactNamesByEmails([SHARED_EMAIL]);
    // EXACT key set (SR §9.1): a length check would pass with a wrong key.
    expect(Object.keys(map)).toEqual([SHARED_EMAIL]);
    // Two contacts hold this address. Neither is crowned; the label says so.
    // Order is (display_name, contact_id) — "Chris" before "Dana" by name, not
    // by which row SQLite happened to hand back.
    expect(map[SHARED_EMAIL]).toBe(`${CHRIS.name} or ${DANA.name}`);
  });

  test("a SHARED phone resolves to the same both-holders label under every key format", () => {
    const map = getContactNamesByPhones([SHARED_PHONE]);
    const values = [...new Set(Object.values(map))];
    // Still ONE label across every alias key — the aliases must not disagree.
    expect(values).toEqual([`${CHRIS.name} or ${DANA.name}`]);
  });

  test("BACKLOG-2757 determinism: the shared-handle label does NOT depend on row order", () => {
    // The defect was `result[key] = row.display_name` with no guard, over rows
    // SQLite returns in rowid (= insertion) order — so the second-inserted
    // contact won. Reversing what SQLite offers first must change nothing.
    //
    // Forced by asking for the SAME handle through both column formats and both
    // orderings of the input list: any surviving order-sensitivity in the JS
    // merge shows up as two different labels here.
    const forward = getContactNamesByPhones([SHARED_PHONE]);
    const reverse = getContactNamesByPhones([SHARED_PHONE, SHARED_PHONE]);
    expect([...new Set(Object.values(reverse))]).toEqual([
      ...new Set(Object.values(forward)),
    ]);
    expect(new Set(Object.keys(reverse))).toEqual(new Set(Object.keys(forward)));
  });

  test("BACKLOG-2757 boundary: ONE contact holding TWO handles is not ambiguous", () => {
    // Chris holds chris.alvarez@ and Chris.A.Work@. Two rows, ONE contact — the
    // rule keys on contact identity, not on row count, so neither address may
    // acquire an "or". The naive "more than one row means ambiguous" reading
    // would red here.
    const map = getContactNamesByEmails([CHRIS.primaryEmail, CHRIS.secondEmail.toLowerCase()]);
    expect(map[CHRIS.primaryEmail]).toBe(CHRIS.name);
    expect(map[CHRIS.secondEmail.toLowerCase()]).toBe(CHRIS.name);
  });

  test("resolution is GLOBAL: a contact attached to NO transaction (or another deal) still labels a handle", () => {
    // Pat is attached to TX_OTHER only — yet resolves identically for any
    // caller. Nothing in either resolver takes a transaction. Pinned: the
    // party-description surfaces resolve by handle across the whole contact
    // book, so which deal an export is for plays NO part in naming.
    const map = getContactNamesByEmails([PAT.primaryEmail]);
    expect(Object.keys(map)).toEqual([PAT.primaryEmail]);
    expect(map[PAT.primaryEmail]).toBe(PAT.name);
  });

  test("resolution is user-UNSCOPED: another user's contact labels a handle in this user's export", () => {
    // Sam belongs to OTHER_USER_ID. Neither exportUtils resolver takes a user
    // id at all. Single-local-user desktop app, so low practical impact —
    // pinned so a future multi-profile change surfaces here. (Finding
    // reported on BACKLOG-2612; behaviour NOT changed in this PR.)
    const map = getContactNamesByEmails([SAM.primaryEmail]);
    expect(map[SAM.primaryEmail]).toBe(SAM.name);
  });

  test("a TOMBSTONED contact still labels her handles (removal does not redact history)", () => {
    // Dana was tombstoned in the previous describe block (real deleteContact).
    // Policy: contactTombstoneSql.ts:32-37 — blanking historical names back to
    // raw numbers would destroy audit fidelity. Mutation E4 reds this.
    const map = getContactNamesByEmails([DANA.primaryEmail]);
    expect(Object.keys(map)).toEqual([DANA.primaryEmail]);
    expect(map[DANA.primaryEmail]).toBe(DANA.name);

    const phoneMap = getContactNamesByPhones([DANA.phone]);
    const values = [...new Set(Object.values(phoneMap))];
    expect(values).toEqual([DANA.name]);
  });

  test("the attachmentDbService stack (folder export's resolver) returns BOTH holders of a shared handle — the collapse happens at the map write, not in SQL", () => {
    // getContactNamesByPhoneDigits keys on contact_phones.phone_normalized
    // (production-written via toLookupKey). The SQL faithfully returns every
    // holder; contactResolutionService.resolvePhoneNames then writes them into
    // one map slot. Pinning the SQL's exact ID set here separates the two
    // layers: a person-style JOIN collapsing rows in SQL would go RED here
    // even while the map output looks unchanged.
    const rows = getContactNamesByPhoneDigits(["5035550142"]);
    expect(rows.map((r) => r.display_name).sort()).toEqual([CHRIS.name, DANA.name].sort());

    const emailRows = getAttachmentContactNamesByEmails([SHARED_EMAIL]);
    expect(emailRows.map((r) => r.display_name).sort()).toEqual([CHRIS.name, DANA.name].sort());
  });

  test("the Apple-ID prefix resolver (5th export-reachable resolver) matches by email local-part prefix, tombstone included", () => {
    // `WHERE LOWER(ce.email) LIKE ? || '@%' LIMIT 1`, NO ORDER BY — a prefix
    // names a party after an arbitrary contact whose email merely STARTS with
    // it. Single-holder prefixes are deterministic and pinned exactly; the
    // multiple-holder arbitrariness is reported as a finding on BACKLOG-2612.
    expect(getContactNameByAppleIdPrefix("chris.alvarez")).toEqual({
      contact_id: CHRIS.id,
      email: CHRIS.primaryEmail,
      display_name: CHRIS.name,
    });
    // Tombstoned Dana still resolves (same no-removed_at-filter policy as the
    // other four resolvers — mutation E4's family applies here too).
    expect(getContactNameByAppleIdPrefix("dana.alvarez")).toEqual({
      contact_id: DANA.id,
      email: DANA.primaryEmail,
      display_name: DANA.name,
    });
    // A prefix nobody holds resolves to nothing.
    expect(getContactNameByAppleIdPrefix("nobody.here")).toBeUndefined();
  });
});
