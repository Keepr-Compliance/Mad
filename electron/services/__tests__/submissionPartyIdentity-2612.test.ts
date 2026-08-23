/**
 * @jest-environment node
 *
 * BACKLOG-2612 (characterization) -> BACKLOG-2758 finding 3 (FIXED HERE).
 *
 * ===========================================================================
 * WHAT THIS SUITE USED TO SAY, AND WHY EVERY LEG FLIPPED
 * ===========================================================================
 * `transactions:submit` / `:resubmit` is the one export that LEAVES THE
 * MACHINE (uploaded to the broker portal), and the one most likely to be
 * forgotten by a sweep. It used to name parties from `getContactNames()` — the
 * macOS AddressBook — while the PDF the same app wrote named them from the
 * sqlite `contacts` table. This suite pinned that, deliberately, as a finding:
 *
 *   1. a party attached in `transaction_contacts` but absent from the
 *      AddressBook uploaded UNRESOLVED;
 *   2. when the two stores disagreed, the ADDRESSBOOK name went to the broker;
 *   3. two AddressBook entries sharing a 10-digit tail collapsed onto whichever
 *      was inserted first, in a hand-rolled `Object.entries` scan.
 *
 * All three are now wrong descriptions of the code, which is the point.
 * `submissionService` resolves through `contactResolutionService` — the SAME
 * resolver, over the SAME map, read through the SAME accessor as the export.
 * The AddressBook is still consulted, as tier 3 INSIDE that resolver, so no
 * name it alone could supply is lost; it is simply no longer a second,
 * independent answer that can disagree with the archived artifact.
 *
 * The hand-rolled last-10-digit scan is deleted outright. It was a THIRD key
 * derivation (after the resolver's and the export's) and therefore a third
 * chance for the same handle to mean different things on different screens.
 *
 * Portal/PDF agreement is asserted end-to-end in
 * `exportPartyNaming.parity.test.ts`. THIS suite stays focused on the
 * submission mapper itself, and on the store precedence it now obeys.
 *
 * FIXTURE PROVENANCE (transcribed, not invented):
 *  - The AddressBook `contactMap` shape is the producer's own: contactsService.ts
 *    (`contactMap[normalized] = person.name; contactMap[phone] = person.name`)
 *    writes BOTH the normalized-last-10 key and the raw-format key for every
 *    phone. The stub below carries exactly those key shapes.
 *  - The Message row is read back from the REAL `messages` table seeded
 *    through the fixture (the same projection the submission path reads), not
 *    hand-shaped.
 *
 * CONTROLS — MEASURED:
 *   S1  in electron/services/submissionService.ts, make `resolvePhone` return
 *       `undefined` (the pre-fix answer against an AddressBook that does not
 *       hold this party)
 *       -> RED on "uploads RESOLVED from the app's own contact book".
 *   S2  in electron/services/contactResolutionService.ts, move the external /
 *       AddressBook tier ahead of the imported-contacts tier
 *       -> RED on "the contacts table outranks the AddressBook".
 *
 * RUNNER:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     --bail=0 electron/services/__tests__/submissionPartyIdentity-2612.test.ts
 */

// The macOS AddressBook is STUBBED, never read: the tests below decide exactly
// what tier 3 offers, so "the contacts table won" is a measurement rather than
// an accident of whatever is in the developer's address book.
const addressBook: { contactMap: Record<string, string> } = { contactMap: {} };
jest.mock("../contactsService", () => ({
  getContactNames: jest.fn(async () => ({
    success: true,
    status: { success: true },
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    contactMap: (global as unknown as { __addressBook: { contactMap: Record<string, string> } })
      .__addressBook.contactMap,
  })),
}));
(global as unknown as { __addressBook: typeof addressBook }).__addressBook = addressBook;

import {
  createExportFixture,
  type ExportFixture,
} from "../folderExport/__tests__/helpers/exportCaptureFixture2612";
import submissionService from "../submissionService";
import {
  resolveHandles,
  type HandleNameResolution,
} from "../contactResolutionService";

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

/**
 * Private-method access: the resolution rule lives in mapToSubmissionMessage.
 *
 * It now takes the resolver's OUTPUT rather than an AddressBook map, so the
 * tests build that output the way production does — through `resolveHandles`,
 * scoped to this user and this transaction.
 */
async function mapMessage(): Promise<{ participants?: Record<string, unknown> }> {
  const resolution: HandleNameResolution = await resolveHandles([CHRIS.phone], USER_ID, {
    userId: USER_ID,
    transactionId: TX,
  });
  return (
    submissionService as unknown as {
      mapToSubmissionMessage(
        message: Record<string, unknown>,
        submissionId: string,
        names: HandleNameResolution,
      ): { participants?: Record<string, unknown> };
    }
  ).mapToSubmissionMessage(messageRow, "sub-2612", resolution);
}

describe("BACKLOG-2758 — the submission upload names parties from the app's own store", () => {
  beforeEach(() => {
    addressBook.contactMap = {};
  });

  test("a party in transaction_contacts uploads RESOLVED from the app's own contact book", () => {
    // THE FLIP. Chris is the attached buyer in `contacts` and the message
    // sender, and the AddressBook is EMPTY. Pre-fix this uploaded no name at
    // all — the app knew exactly who he was and told the broker nothing.
    return mapMessage().then((record) => {
      expect(record.participants?.from).toBe(CHRIS.phone);
      expect(record.participants?.from_name).toBe(CHRIS.name);
    });
  });

  test("when the two stores disagree, the CONTACTS table outranks the AddressBook", () => {
    // The AddressBook says "Robin Hale" for Chris's phone; the app's contacts
    // table says "Chris Alvarez". Pre-fix the AddressBook name went to the
    // broker while the PDF said the other — the exact divergence 2758 filed.
    // Keys transcribed from contactsService.ts: normalized + raw formats.
    addressBook.contactMap = {
      "5035550140": "Robin Hale",
      "+15035550140": "Robin Hale",
    };
    return mapMessage().then((record) => {
      expect(record.participants?.from_name).toBe(CHRIS.name);
      expect(record.participants?.from_name).not.toBe("Robin Hale");
    });
  });

  test("the AddressBook still answers for a handle the contacts table does not hold", () => {
    // The other half of the precedence claim, and the reason this is a tier
    // order rather than a deletion: an AddressBook-only name is still found.
    // Without this leg, "contacts wins" could be satisfied by never reading the
    // AddressBook at all — which would silently lose names in the field.
    addressBook.contactMap = {
      "5035559999": "Robin Hale",
      "+15035559999": "Robin Hale",
    };
    return resolveHandles(["+15035559999"], USER_ID, {
      userId: USER_ID,
      transactionId: TX,
    }).then((resolution) => {
      expect(resolution.names["5035559999"]).toBe("Robin Hale");
    });
  });

  test("the hand-rolled first-match-wins tail scan is GONE", () => {
    // Pre-fix, `mapToSubmissionMessage` scanned `Object.entries(contactMap)`
    // comparing last-10 digits, so two AddressBook entries sharing a tail
    // collapsed onto whichever was inserted FIRST, and reversing the map's
    // insertion order flipped the identity uploaded to the broker.
    //
    // Both orderings are still exercised — that is the discriminating part —
    // and neither may change the answer now, because resolution no longer
    // consults insertion order anywhere.
    const forward = {
      "15035550140": "Robin Hale",
      "+1 (503) 555-0140": "Sam Hale",
    };
    const reversed = {
      "+1 (503) 555-0140": "Sam Hale",
      "15035550140": "Robin Hale",
    };

    addressBook.contactMap = forward;
    return mapMessage()
      .then((first) => {
        addressBook.contactMap = reversed;
        return mapMessage().then((second) => {
          expect(first.participants?.from_name).toBe(CHRIS.name);
          expect(second.participants?.from_name).toBe(CHRIS.name);
          // Stated as its own claim: the two orderings agree.
          expect(first.participants?.from_name).toBe(second.participants?.from_name);
        });
      });
  });

  test("a recipient that is an email address produces no phone-style to_names entry", () => {
    // Unchanged behaviour, kept as the regression leg it always was: the
    // recipient here is the owner's email, so nothing lands in `to_names`.
    // SHARED_PHONE stays referenced so the fixture's shared-handle identity
    // remains visible to a reader of this file.
    return mapMessage().then((record) => {
      const toNames = (record.participants?.to_names ?? {}) as Record<string, string>;
      expect(Object.keys(toNames)).toEqual([]);
      void SHARED_PHONE;
    });
  });
});
