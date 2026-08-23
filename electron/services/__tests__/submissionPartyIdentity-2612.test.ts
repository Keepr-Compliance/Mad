/**
 * @jest-environment node
 *
 * BACKLOG-2612 — THE SUBMISSION UPLOAD RESOLVES PARTY NAMES FROM A STORE THE
 * `contacts` TABLE HAS NO PART IN.
 *
 * `transactions:submit` / `:resubmit` is the one export that LEAVES THE
 * MACHINE (uploaded to the broker portal), and the one most likely to be
 * forgotten by a sweep. Measured (SR review §5f, re-verified at this tree):
 * `submissionService` never references `transaction_contacts` or the
 * `contacts` table for names — the participant names it uploads come from
 * `getContactNames()` (electron/services/contactsService.ts), i.e. the macOS
 * AddressBook, via `mapToSubmissionMessage`'s `contactMap`.
 *
 * Pinned here, by characterization (NOT fixed — findings on BACKLOG-2612):
 *
 *  1. A party attached to the transaction in `transaction_contacts` whose
 *     handle is NOT in the AddressBook map uploads UNRESOLVED. The app's own
 *     contact book plays no part: a name uploaded to the broker portal can
 *     differ from the name in the PDF the same app just wrote.
 *  2. Two AddressBook entries sharing a 10-digit tail resolve FIRST-MATCH-WINS
 *     (insertion order of the map) — a party collapse in the uploaded payload
 *     that exists today, no person layer involved.
 *
 * FIXTURE PROVENANCE (transcribed, not invented):
 *  - The `contactMap` shape is the producer's own: contactsService.ts
 *    (`contactMap[normalized] = person.name; contactMap[phone] = person.name`)
 *    writes BOTH the normalized-last-10 key and the raw-format key for every
 *    phone. The map below carries exactly those key shapes.
 *  - The Message row is read back from the REAL `messages` table seeded
 *    through the fixture (the same projection the submission path reads), not
 *    hand-shaped.
 *
 * CONTROL S1 (manual, result on BACKLOG-2612): in
 * electron/services/submissionService.ts `mapToSubmissionMessage`, consult the
 * sqlite contacts store before the contactMap (simulate by seeding the shared
 * handle into contactMap LAST instead of first → the asserted winner flips) →
 * RED on the first-match-wins assertion.
 *
 * RUNNER:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     --bail=0 electron/services/__tests__/submissionPartyIdentity-2612.test.ts
 */

import {
  createExportFixture,
  type ExportFixture,
} from "../folderExport/__tests__/helpers/exportCaptureFixture2612";
import submissionService from "../submissionService";

const USER_ID = "user-2612-sub";
const TX = "tx-2612-sub";

/** In the app's OWN contact table (attached to the deal) — but NOT in the AddressBook. */
const CHRIS = { id: "c-sub-chris", name: "Chris Alvarez", phone: "+15035550140" };
/** AddressBook-side people sharing one 10-digit tail (transcribed map shapes). */
const SHARED_PHONE = "+15035550142";

let fx: ExportFixture;
let messageRow: Record<string, unknown>;

beforeAll(async () => {
  fx = await createExportFixture();
  fx.seedUser(USER_ID, "owner-2612-sub@example.com", "Test User");
  fx.seedTransaction({ id: TX, userId: USER_ID, address: "114 Cypress Ave" });
  fx.seedContact({
    id: CHRIS.id,
    userId: USER_ID,
    displayName: CHRIS.name,
    phones: [{ phone: CHRIS.phone, isPrimary: true }],
  });
  fx.attachContact({ transactionId: TX, contactId: CHRIS.id, role: "buyer", isPrimary: true, createdAt: "2026-01-05 10:00:00" });
  fx.seedLinkedText({
    id: "msg-sub-1",
    userId: USER_ID,
    transactionId: TX,
    sender: CHRIS.phone,
    recipients: "owner-2612-sub@example.com",
    body: "Offer signed",
    sentAt: "2026-01-12 09:00:00",
    threadId: "thr-sub-1",
  });
  // The REAL stored row — the shape the submission path maps.
  messageRow = fx.db.prepare("SELECT * FROM messages WHERE id = ?").get("msg-sub-1") as Record<
    string,
    unknown
  >;
}, 120_000);

afterAll(async () => {
  await fx.cleanup();
});

/** Private-method access: the resolution rule lives in mapToSubmissionMessage. */
function mapMessage(contactMap: Record<string, string>): { participants?: Record<string, unknown> } {
  return (
    submissionService as unknown as {
      mapToSubmissionMessage(
        message: Record<string, unknown>,
        submissionId: string,
        contactMap: Record<string, string>,
      ): { participants?: Record<string, unknown> };
    }
  ).mapToSubmissionMessage(messageRow, "sub-2612", contactMap);
}

describe("BACKLOG-2612 — submission upload party identity (path 4)", () => {
  test("a party in transaction_contacts but not in the AddressBook map uploads UNRESOLVED — the contacts table plays no part", () => {
    // Chris IS the attached buyer in the app's own contact book, and his
    // handle is the message sender. With an empty AddressBook map, the upload
    // carries no name for him: proof the submission path never consults
    // `contacts`/`transaction_contacts` for party names.
    const record = mapMessage({});
    expect(record.participants?.from).toBe(CHRIS.phone);
    expect(record.participants?.from_name).toBeUndefined();
  });

  test("an AddressBook name labels the party even when the app's contact book names him differently", () => {
    // The AddressBook says "Robin Hale" for Chris's phone; the app's contacts
    // table says "Chris Alvarez". The uploaded payload carries the AddressBook
    // name — so the broker portal and the PDF the same app just wrote can
    // disagree about who a party is. Pinned as-is (finding, not fixed here).
    // Map keys transcribed from contactsService.ts: normalized + raw formats.
    const record = mapMessage({
      "5035550140": "Robin Hale",
      "+15035550140": "Robin Hale",
    });
    expect(record.participants?.from_name).toBe("Robin Hale");
  });

  test("two AddressBook entries sharing a 10-digit tail: FIRST match in map insertion order wins", () => {
    // Neither key equals the sender's raw format, so the resolver falls to its
    // last-10-digits scan over Object.entries — first match wins. JS object
    // string-key insertion order is deterministic, so the winner IS assertable
    // here (unlike the SQL resolvers, where row order carries no guarantee).
    const sharedTailMap = {
      "15035550140": "Robin Hale", // first inserted — wins
      "+1 (503) 555-0140": "Sam Hale", // same tail, different person
    };
    const record = mapMessage(sharedTailMap);
    expect(record.participants?.from_name).toBe("Robin Hale");

    // Reversed insertion order flips the uploaded identity — the collapse is
    // real and order-dependent, characterized from both directions.
    const reversed = {
      "+1 (503) 555-0140": "Sam Hale",
      "15035550140": "Robin Hale",
    };
    const flipped = mapMessage(reversed);
    expect(flipped.participants?.from_name).toBe("Sam Hale");
  });

  test("the shared-phone tail scan also collapses distinct handles onto one name in to_names", () => {
    // Same rule on the recipient side: any handle whose tail matches gets the
    // first-matching name. SHARED_PHONE differs from Chris's phone, so it
    // resolves only when a map entry shares ITS tail.
    const record = mapMessage({ "5035550142": "Robin Hale" });
    expect(record.participants?.from_name).toBeUndefined(); // Chris's tail ≠ shared tail
    const toNames = (record.participants?.to_names ?? {}) as Record<string, string>;
    expect(Object.keys(toNames)).toEqual([]); // recipient is the owner's email, not a phone
    void SHARED_PHONE;
  });
});
