/**
 * @jest-environment node
 *
 * BACKLOG-2644 — ONE SHAPE PER NUMBER ON THE COMPARE SCREEN.
 *
 * ---------------------------------------------------------------------------
 * THE REPORTED SCREEN
 * ---------------------------------------------------------------------------
 * Founder, 11 Aug, comparing two records of one person:
 *
 *     Phone                          Phone
 *       +15035550130                   +1 (503) 555-0130
 *
 * One number, two shapes, on the one screen whose job is comparison — and the
 * failure is asymmetric and permanent. A user who cannot see that two numbers
 * match answers *different people*; that verdict is final, so the matcher can
 * never propose the pair again. Punctuation becomes an irreversible answer.
 *
 * ---------------------------------------------------------------------------
 * WHAT EACH TEST HERE IS FOR, AND WHAT BREAKS IT
 * ---------------------------------------------------------------------------
 * Every control below names the mutation that turns it red. A control whose
 * break has never been run is an unrun control (PR-SOP §4.4), and the two that
 * discriminate between candidate fixes are C1b and C2 — reverting the fix does
 * NOT red C2, because a raw value and an unformatted value are the same string.
 *
 *   C1   `+1…` vs `+1 (…) …` render identically     break: drop the `display` arg from `mark`
 *   C1b  `+1…` vs bare ten digits render identically break: `displayPhone` -> bare `formatPhoneNumber`
 *   C2   `12345` / `VERIZON` survive unchanged       break: `displayPhone` -> `extractDigits`
 *   C3   1–9 digit runs are not mangled              break: `displayPhone` -> `toE164`
 *   C3b  a stated country code is not overwritten    break: drop the `+` guard from `displayPhone`
 *   C4   the match path still finds the message      break: starve one column's bundle
 *   C4b  the RENDERED value keeps both comparison
 *        keys (`toLookupKey` AND `toE164`)          break: `formatPhoneNumber("1" + digits.slice(1))`
 *   C5   the reason sentence agrees with the cells   break: unwrap `displayPhone` at `buildReason`
 *
 * ---------------------------------------------------------------------------
 * ONE MUTATION WAS RUN AND DID *NOT* GO RED. RECORDED, NOT HIDDEN.
 * ---------------------------------------------------------------------------
 * Formatting the `loadCommunications` MATCH BUNDLES — deliberately moving
 * display INTO the match path, the exact boundary violation this PR claims not
 * to commit — leaves all 102 tests green. That is not a gap in the suite; it is
 * a property of the match path, and it was measured rather than assumed:
 * `phonesMatch` normalises BOTH sides through `toE164`
 * (`messageMatchingService.ts:84`), so any formatting that preserves the digit
 * run is invisible to it.
 *
 * Two consequences worth stating. The display change cannot reach message
 * matching even if a later refactor moved it there — which is the strongest
 * form of "display-only" available here. And no test can be written to forbid
 * that refactor by behaviour alone, so the boundary itself is held by the
 * comment at the `phonesByBundle` line and by review, not by this file.
 *
 * What C4b DOES pin is the property that green result RESTS on: the rendered
 * value keeps both `toLookupKey` AND `toE164`. The refactor is invisible only
 * while that holds, so C4b reds before the boundary could ever matter — which
 * is as close as a test can get, and is why it asserts two keys rather than
 * the one it originally did (SR review, PR #2287).
 *
 * ---------------------------------------------------------------------------
 * FIXTURES
 * ---------------------------------------------------------------------------
 * RFC 2606 domains and NANP reserved-fictional numbers, 555 as the EXCHANGE and
 * never the area code (`scripts/ci/check-fixture-pii.mjs` rejects the other
 * spelling). The bare digit runs in C3 carry no area code at all by
 * construction — they are the shape the sweep is about.
 */

import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import { CONTACT_IDENTITY_SCHEMA } from "./helpers/contactIdentitySchema";
import { CONTACT_COMMUNICATION_SCHEMA } from "./helpers/contactCommunicationSchema";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

let mockDb: DatabaseType | null = null;

jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).all(...params),
  dbGet: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).get(...params),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...params);
    return { lastInsertRowid: r.lastInsertRowid as number, changes: r.changes };
  },
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { getContactCompareColumns } from "../contactCompare";
import { createLink } from "../db/contactSourceLinkDbService";
import { recordContactOrigin } from "../db/contactOriginLink";
import { toE164, toLookupKey } from "../../utils/phoneNormalization";

const USER = "user-2644";

/**
 * The contact side, written the way the app writes it.
 *
 * `getContactPhoneEntries` projects `phone_e164 AS phone`, so THE COLUMN READS
 * `phone_e164` AND NOTHING ELSE — `phone_display` is set here to a deliberately
 * DIFFERENT spelling in one test below, to prove which column the screen is
 * actually printing rather than assume it.
 */
function addContact(
  id: string,
  displayName: string,
  opts: { phones?: string[]; phoneDisplay?: string[]; emails?: string[] } = {},
): void {
  mockDb!
    .prepare(
      `INSERT INTO contacts (id, user_id, display_name, company, source, is_imported, removed_at)
       VALUES (?, ?, ?, NULL, 'contacts_app', 1, NULL)`,
    )
    .run(id, USER, displayName);
  (opts.emails ?? []).forEach((e, i) => {
    mockDb!
      .prepare(
        "INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES (?, ?, ?, ?, 'import')",
      )
      .run(`${id}-e${i}`, id, e, i === 0 ? 1 : 0);
  });
  (opts.phones ?? []).forEach((p, i) => {
    mockDb!
      .prepare(
        `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source)
         VALUES (?, ?, ?, ?, ?, ?, 'import')`,
      )
      .run(`${id}-p${i}`, id, p, opts.phoneDisplay?.[i] ?? p, toLookupKey(p), i === 0 ? 1 : 0);
  });
  const wrote = recordContactOrigin(USER, id, "contacts_app");
  expect(wrote).toBe(true);
}

/** The record side — the address book's own string, stored verbatim. */
function addExternal(recordId: string, name: string, opts: { phones?: string[] } = {}): void {
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, emails_json, company, external_record_id, source, synced_at)
       VALUES (?, ?, ?, ?, '[]', NULL, ?, 'outlook', datetime('now'))`,
    )
    .run(`ec-${recordId}`, USER, name, JSON.stringify(opts.phones ?? []), recordId);
}

function link(contactId: string, recordId: string): void {
  const out = createLink({
    userId: USER,
    contactId,
    sourceType: "outlook",
    sourceRecordId: recordId,
    matchMethod: "phone",
    assertMethod: true,
  });
  if (!out.id) throw new Error(`fixture link not created for ${recordId}`);
}

function addText(id: string, body: string, sentAt: string, participantsFlat: string): void {
  mockDb!
    .prepare(
      `INSERT INTO messages (id, user_id, channel, direction, body_text, participants_flat,
                             thread_id, sent_at, associated_message_type)
       VALUES (?, ?, 'imessage', 'inbound', ?, ?, ?, ?, NULL)`,
    )
    .run(id, USER, body, participantsFlat, `thread-${id}`, sentAt);
}

/**
 * One contact, one linked record, one number each — the reported screen.
 * Returns the two columns' phone cells, which is the whole subject here.
 */
async function comparePhones(
  id: string,
  contactPhones: string[],
  recordPhones: string[],
  opts: { phoneDisplay?: string[] } = {},
): Promise<{ value: string; matched: boolean }[][]> {
  addContact(id, "Robin Marsh", { phones: contactPhones, phoneDisplay: opts.phoneDisplay });
  addExternal(`out-${id}`, "Robin Marsh", { phones: recordPhones });
  link(id, `out-${id}`);
  const view = await getContactCompareColumns(USER, id);
  expect(view).not.toBeNull();
  // Identity, not count: WHICH two columns, in order. A view that lost the
  // record column would make every phone assertion below vacuously agree.
  expect(view!.columns.map((c) => c.kind)).toEqual(["contact", "source"]);
  return view!.columns.map((c) => c.phones);
}

beforeEach(() => {
  mockDb = new RealDatabase(":memory:");
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  mockDb.exec(CONTACT_COMMUNICATION_SCHEMA);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
// C1 / C1b — THE DEFECT
// ===========================================================================
describe("the same number renders as one shape, whichever store it came from", () => {
  /**
   * C1 — the founder's pair, transcribed: E.164 on the contact, the address
   * book's punctuated `+1` spelling on the record.
   *
   * CONTROL: drop the `display` argument from the `mark(c.phones, …)` call and
   * this reads `["+12065550130", "+1 (206) 555-0130"]`. RUN, red.
   */
  it("prints E.164 and a punctuated +1 spelling identically", async () => {
    const phones = await comparePhones("c1", ["+12065550130"], ["+1 (206) 555-0130"]);

    expect(phones).toEqual([
      [{ value: "+1 (206) 555-0130", matched: true }],
      [{ value: "+1 (206) 555-0130", matched: true }],
    ]);
  });

  /**
   * The reported values, transcribed rather than restated in this file's own
   * area code: `+15035550130` on the contact, `+1 (503) 555-0130` on the
   * record, exactly as they appeared on the founder's screen. Kept alongside
   * C1 so the suite contains the case as filed, not only its shape.
   */
  it("prints the founder's reported pair as one shape", async () => {
    const phones = await comparePhones("c1-reported", ["+15035550130"], ["+1 (503) 555-0130"]);

    expect(phones).toEqual([
      [{ value: "+1 (503) 555-0130", matched: true }],
      [{ value: "+1 (503) 555-0130", matched: true }],
    ]);
  });

  /**
   * C1b — THE CONTROL THAT DISCRIMINATES THE TWO CANDIDATE FIXES, and the
   * reason `displayPhone` exists at all rather than a bare `formatPhoneNumber`.
   *
   * A ten-digit spelling with no country code is the ordinary address-book
   * shape. `formatPhoneNumber` branches on DIGIT COUNT, so it renders the
   * eleven-digit E.164 twin as `+1 (206) 555-0142` and this one as
   * `(206) 555-0142` — one number, still two shapes, `matched` still true.
   *
   * CONTROL: replace `displayPhone` with bare `formatPhoneNumber` and the second
   * column reads `(206) 555-0142`. RUN, red. Nothing else in this suite reds on
   * that mutation, which is why this test is separate from C1.
   */
  it("prints a bare ten-digit record spelling in the same shape as the contact's E.164", async () => {
    const phones = await comparePhones("c1b", ["+12065550142"], ["(206) 555-0142"]);

    expect(phones).toEqual([
      [{ value: "+1 (206) 555-0142", matched: true }],
      [{ value: "+1 (206) 555-0142", matched: true }],
    ]);
  });

  /**
   * The same claim over every spelling one address book or another actually
   * writes, swept rather than sampled: all six are one number, so all six must
   * produce one string. A single hand-picked pair cannot catch a branch that
   * only fires on, say, the dotted spelling.
   */
  it.each([
    "+12065550155",
    "+1 (206) 555-0155",
    "+1-206-555-0155",
    "(206) 555-0155",
    "206.555.0155",
    "2065550155",
  ])("renders %s as the one shape the contact's E.164 renders as", async (spelling) => {
    const phones = await comparePhones(`sweep-${spelling.replace(/\W/g, "")}`, ["+12065550155"], [
      spelling,
    ]);

    expect(phones[1]).toEqual([{ value: "+1 (206) 555-0155", matched: true }]);
    expect(phones[1][0].value).toBe(phones[0][0].value);
  });

  /**
   * WHICH COLUMN THE CONTACT SIDE IS READ FROM, proven rather than assumed.
   *
   * `contact_phones` carries `phone_e164` AND `phone_display`, and this screen
   * reads the first (`getContactPhoneEntries` projects `phone_e164 AS phone`).
   * The fixture sets a deliberately different `phone_display`, so a reader that
   * switched columns would be caught here instead of silently changing what the
   * founder sees.
   */
  it("formats the contact's phone_e164, not its phone_display", async () => {
    const phones = await comparePhones("c1c", ["+12065550166"], ["+12065550166"], {
      phoneDisplay: ["MOBILE 206 555 0166 (home)"],
    });

    expect(phones[0]).toEqual([{ value: "+1 (206) 555-0166", matched: true }]);
  });
});

// ===========================================================================
// C2 — WHAT THE FORMATTER CANNOT PARSE MUST SURVIVE, NOT VANISH
// ===========================================================================
describe("values a phone formatter cannot parse are printed, not blanked", () => {
  /**
   * Both shapes exist in the founder's real address book and both previously
   * leaked through the linker's name guard, so neither is hypothetical.
   *
   * CONTROL: reverting the fix does NOT red this — an unformatted value and a
   * correctly-formatted one are the same string here, which is exactly why the
   * control has to be a different mutation. Replace `displayPhone` with
   * `extractDigits` and `VERIZON` renders as `""`, an empty bullet where a
   * value used to be. RUN, red.
   */
  it("leaves a short code and an alphanumeric sender exactly as stored", async () => {
    const phones = await comparePhones("c2", ["12345", "VERIZON"], ["VERIZON", "12345"]);

    expect(phones).toEqual([
      [
        { value: "12345", matched: true },
        { value: "VERIZON", matched: true },
      ],
      [
        { value: "VERIZON", matched: true },
        { value: "12345", matched: true },
      ],
    ]);
  });

  /** No column may print an empty bullet, whatever it was handed. */
  it("never renders a stored value as blank", async () => {
    const phones = await comparePhones(
      "c2b",
      ["VERIZON", "12345", "---"],
      ["MYCARRIER", "1", "+"],
    );

    phones.flat().forEach(({ value }) => expect(value.trim()).not.toBe(""));
  });
});

// ===========================================================================
// C3 — INTERNATIONAL NUMBERS STORED WITHOUT A COUNTRY CODE
// ===========================================================================
describe("numbers stored without a country code are not mangled", () => {
  /**
   * 61 of the founder's 1,264 phone values are under ten digits, mostly nine
   * (BACKLOG-2635 — NOT fixed here; this asserts only that it is not made
   * worse). The sweep runs every length 1..9 rather than sampling one, because
   * the wrapper selects on length and one input per branch cannot catch an
   * off-by-one at the boundary.
   *
   * ONE EXCEPTION IS STATED RATHER THAN HIDDEN: a seven-digit run gets
   * `formatPhoneNumber`'s existing local shape (`123-4567`). That is the app's
   * shipped behaviour on every other screen, unchanged by this PR.
   *
   * CONTROL: route `displayPhone` through `toE164` first and every one of these
   * gains an invented `+`. RUN, red.
   */
  const BARE_RUNS = [
    "1",
    "12",
    "123",
    "1234",
    "12345",
    "123456",
    "1234567",
    "12345678",
    "123456789",
  ];

  it("prints every 1–9 digit run unchanged, except the seven-digit local shape", async () => {
    const phones = await comparePhones("c3", BARE_RUNS, []);

    expect(phones[0].map((p) => p.value)).toEqual([
      "1",
      "12",
      "123",
      "1234",
      "12345",
      "123456",
      "123-4567", // the shipped seven-digit shape, stated not hidden
      "12345678",
      "123456789",
    ]);
  });

  it("invents no country code for any of them", async () => {
    const phones = await comparePhones("c3b", BARE_RUNS, []);

    expect(phones[0].filter((p) => p.value.includes("+"))).toEqual([]);
  });

  /**
   * THE CASE THE `+` GUARD EXISTS FOR — a value that STATES a country code and
   * happens to carry exactly ten digits.
   *
   * Without the guard, the ten-digit canonicalisation would print
   * `+1 (440) 555-0142`: a US country code invented over one the record
   * actually gave, which is the single thing a screen about identity must never
   * do. With it, the value keeps `formatPhoneNumber`'s existing treatment.
   *
   * THAT EXISTING TREATMENT IS ITSELF IMPERFECT AND IS NOT FIXED HERE: the
   * ten-digit branch drops the stated prefix. It is what every other screen in
   * the app prints today, it is owned by BACKLOG-2461 / BACKLOG-2635, and this
   * PR neither improves nor worsens it — asserted exactly so the difference
   * between "unchanged" and "fixed" is on the record.
   *
   * CONTROL: delete `&& !raw.trim().startsWith("+")` from `displayPhone` and
   * this reads `+1 (440) 555-0142`. RUN, red.
   */
  it("does not stamp +1 onto a ten-digit number that already carried a country code", async () => {
    const phones = await comparePhones("c3c", ["+4405550142"], []);

    expect(phones[0].map((p) => p.value)).toEqual(["(440) 555-0142"]);
    expect(phones[0].map((p) => p.value)).not.toContain("+1 (440) 555-0142");
  });

  /**
   * THE INVARIANT THE DISPLAY-ONLY CLAIM RESTS ON — READ OFF THE SCREEN, NOT
   * RE-DERIVED.
   *
   * SR review, PR #2287: the first version of this sweep re-implemented
   * `displayPhone` inline and compared THAT against the stored value, so it
   * asserted a property of this file. Measured: with `displayPhone` mutated in
   * the service (M10, `formatPhoneNumber("1" + digits.slice(1))`), seven other
   * tests went red and this sweep stayed GREEN. It is the same defect this
   * file's own header describes for M8, one screen over.
   *
   * `rendered` now comes out of `getContactCompareColumns`, so the invariant is
   * asserted about the SHIPPED path.
   *
   * TWO KEYS, NOT ONE, and the second is the point:
   *
   *   `toLookupKey` — what this screen's `match` tag, `dedupePhoneValues` and
   *   `sharedPhoneKeys` compare on.
   *   `toE164`      — what `phonesMatch` compares on, and therefore the exact
   *   property that makes the M8 result in the header TRUE. Formatting the
   *   match bundles is invisible to behaviour only for as long as this holds.
   *
   * The header says no test can forbid that refactor, and that is still true —
   * a refactor is not observable. This is the nearest thing available: it pins
   * the property the refactor's safety RESTS on, so if `displayPhone` ever
   * stops preserving either key, this reds before the boundary matters.
   *
   * `formatPhoneNumber`'s own half of the lookup-key invariant is
   * `phoneNormalization.formatPhoneNumber.lookupKeyInvariant-2620.test.ts`;
   * this covers the ten-digit canonicalisation the wrapper adds on top.
   */
  it.each([
    ...BARE_RUNS,
    "VERIZON",
    "+12065550142",
    "(206) 555-0142",
    "2065550142",
    "206.555.0142",
    "+4405550142",
    "+50664103686",
  ])("preserves both comparison keys of %s through the screen", async (raw) => {
    const phones = await comparePhones(`inv-${raw.replace(/\W/g, "") || "empty"}`, [raw], []);
    const rendered = phones[0][0].value.trim();

    expect([raw, toLookupKey(rendered), toE164(rendered)]).toEqual([
      raw,
      toLookupKey(raw),
      toE164(raw),
    ]);
  });
});

// ===========================================================================
// C4 — MATCHING RUNS ON THE STORED VALUE, NOT THE PRINTED ONE
// ===========================================================================
describe("matching is untouched — display is a leaf", () => {
  /**
   * The message match path is the one place a formatting change could leak into
   * behaviour: `loadCommunications` compares each column's phones against
   * `messages.participants_flat`. It must keep comparing STORED values.
   *
   * The fixture makes the two stores disagree on spelling and the message carry
   * a third, so each column reaches the message by a different string.
   *
   * CONTROL: `bundles.map((b, i) => (i === 1 ? [] : …))` — starve the source
   * column's bundle and this reads `[["msg-1"], []]`. RUN, red. That control
   * exists because the OBVIOUS one does not work: formatting the bundles leaves
   * this green (see the header), so the assertion had to be proved non-vacuous
   * a different way.
   *
   * Asserted as EXACT MESSAGE ID SETS — a count would pass while the wrong
   * column claimed the message.
   */
  it("still finds a text through both columns when the two stores spell the number differently", async () => {
    addContact("c4", "Robin Marsh", { phones: ["+12065550177"] });
    addExternal("out-c4", "Robin Marsh", { phones: ["(206) 555-0177"] });
    link("c4", "out-c4");
    addText("msg-1", "on my way", "2026-08-04T10:00:00Z", "2065550177");

    const view = await getContactCompareColumns(USER, "c4");

    expect(view!.columns.map((c) => c.recentCommunication.map((m) => m.id))).toEqual([
      ["msg-1"],
      ["msg-1"],
    ]);
  });

  /**
   * The number printed UNDER a communication is the third place this screen
   * prints a phone, and it is the same column's own number — so it must carry
   * the same shape as the Phone row two rows above it.
   *
   * CONTROL: revert `matchedIdentifier: displayPhone(hit)` to `hit` and the
   * second column reads `(206) 555-0177` beneath a Phone row reading
   * `+1 (206) 555-0177`. RUN, red.
   */
  it("prints the matched number under a text in the same shape as the Phone row", async () => {
    addContact("c4b", "Robin Marsh", { phones: ["+12065550177"] });
    addExternal("out-c4b", "Robin Marsh", { phones: ["(206) 555-0177"] });
    link("c4b", "out-c4b");
    addText("msg-2", "on my way", "2026-08-04T10:00:00Z", "2065550177");

    const view = await getContactCompareColumns(USER, "c4b");

    view!.columns.forEach((column) => {
      expect(column.recentCommunication.map((m) => m.matchedIdentifier)).toEqual([
        "+1 (206) 555-0177",
      ]);
      expect(column.phones.map((p) => p.value)).toEqual(["+1 (206) 555-0177"]);
    });
  });

  /**
   * An EMAIL's matched identifier is an address and stays exactly as the query
   * that found it returned it. Stated so a later reader does not "finish the
   * job" by routing it through a phone formatter.
   */
  it("leaves an email's matched identifier alone", async () => {
    addContact("c4c", "Robin Marsh", {
      phones: ["+12065550188"],
      emails: ["robin@example.com"],
    });
    addExternal("out-c4c", "Robin Marsh", { phones: ["+12065550188"] });
    link("c4c", "out-c4c");
    mockDb!
      .prepare(
        `INSERT INTO emails (id, user_id, source, direction, subject, sent_at)
         VALUES ('em-1', ?, 'outlook', 'inbound', 'Closing docs', '2026-08-04T09:00:00Z')`,
      )
      .run(USER);
    mockDb!
      .prepare(
        `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
         VALUES ('em-1', 'to', 0, 'em-1-h0', 'robin@example.com')`,
      )
      .run();

    const view = await getContactCompareColumns(USER, "c4c");

    expect(
      view!.columns[0].recentCommunication.map((m) => [m.id, m.matchedIdentifier]),
    ).toEqual([["em-1", "robin@example.com"]]);
  });
});

// ===========================================================================
// C5 — THE REASON SENTENCE NAMES THE VALUE IN THE SHAPE THE COLUMNS SHOW IT
// ===========================================================================
describe("the reason sentence prints the same shape the columns do", () => {
  /**
   * CONTROL: unwrap `displayPhone` at the `buildReason` call site and this
   * reads "…the phone number +12065550199", two rows above columns reading
   * "+1 (206) 555-0199". RUN, red.
   */
  it("names the shared number as the columns render it", async () => {
    addContact("c5", "Robin Marsh", { phones: ["+12065550199"] });
    addExternal("out-c5", "Robin Marsh", { phones: ["(206) 555-0199"] });
    link("c5", "out-c5");

    const view = await getContactCompareColumns(USER, "c5");

    expect(view!.reason).toBe(
      "Both records list the phone number +1 (206) 555-0199, and the names match.",
    );
    // And the sentence agrees with the cells it sits above — the property that
    // matters, asserted rather than left to two independent string literals.
    view!.columns.forEach((column) =>
      expect(view!.reason).toContain(column.phones[0].value),
    );
  });
});
