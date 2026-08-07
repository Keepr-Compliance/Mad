/**
 * BACKLOG-2512: the five fetched-but-discarded per-message fields.
 *
 * `in_reply_to`, `references_header`, `received_at`, `content_hash` and `labels`
 * were hard-coded to literal `null` at the emails INSERT even though both fetch
 * services had (or could cheaply obtain) the values. They are per-message facts:
 * nothing the app retains can reconstruct them, so recovering them later means
 * re-reading every mailbox for every user.
 *
 * These tests drive the canonical write path (`storeParsedEmailsForAccount` →
 * `fetchStoreAndDedup`) against a fake prepared-statement DB that records every
 * `run(...)` argument array, so the INSERT parameters are asserted positionally.
 *
 * The DB layer is mocked so no native modules run.
 *
 * Fixture provenance: the `StoreableEmail` values below are transcribed from the
 * real producer shapes. The `_wireCheck` assignability assertions in
 * gmailFetchService.test.ts / outlookFetchService.test.ts are what keep these
 * property NAMES tied to what `_parseMessage` actually emits — a producer-side
 * rename fails `tsc` rather than leaving both suites green.
 */

const mockDbAll = jest.fn();
const mockDbGet = jest.fn();
const mockGetRawDatabase = jest.fn();
jest.mock("../db/core/dbConnection", () => ({
  dbAll: (...a: unknown[]) => mockDbAll(...a),
  dbGet: (...a: unknown[]) => mockDbGet(...a),
  getRawDatabase: (...a: unknown[]) => mockGetRawDatabase(...a),
}));

const mockGetOAuthToken = jest.fn();
const mockUpsertEmailAttachmentMetadata = jest.fn();
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getOAuthToken: (...a: unknown[]) => mockGetOAuthToken(...a),
    upsertEmailAttachmentMetadata: (...a: unknown[]) =>
      mockUpsertEmailAttachmentMetadata(...a),
  },
}));

import {
  storeParsedEmailsForAccount,
  type StoreableEmail,
} from "../emailSyncService";

/**
 * Positional indices into the `INSERT INTO emails (...)` parameter list.
 * Transcribed from the column list in emailSyncService.ts (`INSERT INTO emails`).
 * Asserting by index is what makes a dropped/rewired column fail loudly.
 */
const COL = {
  ID: 0,
  EXTERNAL_ID: 2,
  THREAD_ID: 13,
  IN_REPLY_TO: 14,
  REFERENCES_HEADER: 15,
  SENT_AT: 16,
  RECEIVED_AT: 17,
  // BACKLOG-2571: inserted directly after `received_at`, so every index below
  // shifted by one. That shift is why this map is asserted positionally — a
  // column added in the middle of the list rewires every bind after it, and
  // nine tests in this file went red at once rather than silently binding the
  // wrong values.
  SENT_AT_SOURCE: 18,
  MESSAGE_ID_HEADER: 21,
  CONTENT_HASH: 22,
  LABELS: 23,
  // BACKLOG-2513: appended directly after `labels`.
  BULK_MAIL_HEADERS: 24,
} as const;

/** The emails INSERT binds exactly this many parameters. */
const INSERT_ARITY = 27;

/** A fake prepared-statement DB whose INSERTs always succeed and are recorded. */
function makeFakeDb() {
  const insertRuns: unknown[][] = [];
  const stmt = (sink: unknown[][]) => ({
    run: (...args: unknown[]) => sink.push(args),
  });
  const db = {
    prepare: jest.fn((sql: string) => {
      if (sql.includes("UPDATE emails SET external_id")) return stmt([]);
      if (sql.includes("INSERT INTO emails")) return stmt(insertRuns);
      return stmt([]); // participants
    }),
    transaction: (fn: () => void) => () => fn(),
  };
  return { db, insertRuns };
}

/**
 * Gmail-shaped StoreableEmail.
 *
 * Transcribed from `gmailFetchService._parseMessage`:
 *  - `inReplyTo` / `references` ← `getHeader("In-Reply-To")` / `getHeader("References")`,
 *    which return the raw RFC 5322 header value (angle-bracketed Message-IDs,
 *    space-separated for References).
 *  - `receivedAt` ← `sentDate`, i.e. `new Date(parseInt(message.internalDate))`.
 *  - `contentHash` ← `computeEmailHash(...)`, a 64-char lowercase hex SHA-256.
 *  - `labels` ← `message.labelIds`, Gmail's system/user label id strings.
 *
 * Addresses use RFC 2606 reserved domains only.
 */
function mkGmailEmail(overrides: Partial<StoreableEmail> = {}): StoreableEmail {
  return {
    id: "g1",
    threadId: "t-g1",
    from: "agent@example.com",
    to: "me@example.com",
    cc: null,
    bcc: null,
    messageIdHeader: "<CAF-child-001@mail.example.com>",
    subject: "RE: Closing docs",
    body: "Confirming the closing date.",
    bodyPlain: "Confirming the closing date.",
    date: new Date("2026-02-15T10:00:00.000Z"),
    hasAttachments: false,
    attachmentCount: 0,
    participants: [],
    ingestSource: "filter",
    inReplyTo: "<CAF-parent-000@mail.example.com>",
    references:
      "<CAF-root-000@mail.example.com> <CAF-parent-000@mail.example.com>",
    receivedAt: new Date("2026-02-15T10:00:00.000Z"),
    contentHash: "a".repeat(64),
    labels: ["INBOX", "IMPORTANT"],
    ...overrides,
  };
}

/**
 * Outlook-shaped StoreableEmail.
 *
 * Transcribed from `outlookFetchService._parseMessage`:
 *  - `inReplyTo` / `references` ← `getInternetHeader(message, "in-reply-to" | "references")`
 *    over Graph's `internetMessageHeaders` (raw RFC 5322 values, same shape as Gmail).
 *  - `receivedAt` ← `new Date(message.receivedDateTime)` (Graph ISO-8601 string).
 *  - `contentHash` ← `computeEmailHash(...)`, 64-char hex.
 *  - `labels` ← `message.categories`, Outlook's user-assigned category names.
 */
function mkOutlookEmail(overrides: Partial<StoreableEmail> = {}): StoreableEmail {
  return {
    id: "o1",
    threadId: "AAQkAGconversation-o1",
    from: "Broker Name <broker@example.net>",
    to: "me@example.com",
    cc: null,
    bcc: null,
    messageIdHeader: "<AM0P-child-001@example.net>",
    subject: "RE: Disclosure package",
    body: "Signed and returned.",
    bodyPlain: "Signed and returned.",
    date: new Date("2026-03-02T14:30:00.000Z"),
    hasAttachments: false,
    attachmentCount: 0,
    participants: [],
    ingestSource: "filter",
    inReplyTo: "<AM0P-parent-000@example.net>",
    references: "<AM0P-root-000@example.net> <AM0P-parent-000@example.net>",
    receivedAt: new Date("2026-03-02T14:30:00.000Z"),
    contentHash: "b".repeat(64),
    labels: ["Closing", "Urgent"],
    ...overrides,
  };
}

describe("BACKLOG-2512 sync retains the five previously-discarded fields", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetOAuthToken.mockResolvedValue({
      id: "acct-1",
      connected_email_address: "me@example.com",
    });
    mockDbAll.mockReturnValue([]); // nothing pre-existing → all inserts are new
  });

  it("Gmail: writes in_reply_to, references_header, received_at, content_hash and labels", async () => {
    const { db, insertRuns } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db);

    await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "gmail",
      emails: [mkGmailEmail()],
      getAttachmentsFn: jest.fn(),
    });

    // Count first: distinguishes "email was dropped" from "value was wrong".
    // Without this, a swallowed catch yields `undefined` at every index and the
    // value assertions below would go red by accident rather than by design.
    expect(insertRuns).toHaveLength(1);
    const row = insertRuns[0];
    expect(row).toHaveLength(INSERT_ARITY);

    expect(row[COL.EXTERNAL_ID]).toBe("g1");
    expect(row[COL.IN_REPLY_TO]).toBe("<CAF-parent-000@mail.example.com>");
    expect(row[COL.REFERENCES_HEADER]).toBe(
      "<CAF-root-000@mail.example.com> <CAF-parent-000@mail.example.com>",
    );
    expect(row[COL.RECEIVED_AT]).toBe("2026-02-15T10:00:00.000Z");
    expect(row[COL.CONTENT_HASH]).toBe("a".repeat(64));
    // labels is JSON per the schema contract ("JSON: Gmail labels, Outlook
    // categories") and `NewEmail.labels: string`.
    expect(row[COL.LABELS]).toBe(JSON.stringify(["INBOX", "IMPORTANT"]));

    // None of the five may be null when the provider supplied a value —
    // that regression is the entire point of this item.
    for (const col of [
      COL.IN_REPLY_TO,
      COL.REFERENCES_HEADER,
      COL.RECEIVED_AT,
      COL.CONTENT_HASH,
      COL.LABELS,
    ]) {
      expect(row[col]).not.toBeNull();
    }
  });

  it("Outlook: writes in_reply_to, references_header, received_at, content_hash and labels", async () => {
    const { db, insertRuns } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db);

    await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "outlook",
      emails: [mkOutlookEmail()],
      getAttachmentsFn: jest.fn().mockResolvedValue([]),
    });

    expect(insertRuns).toHaveLength(1);
    const row = insertRuns[0];
    expect(row).toHaveLength(INSERT_ARITY);

    expect(row[COL.EXTERNAL_ID]).toBe("o1");
    expect(row[COL.IN_REPLY_TO]).toBe("<AM0P-parent-000@example.net>");
    expect(row[COL.REFERENCES_HEADER]).toBe(
      "<AM0P-root-000@example.net> <AM0P-parent-000@example.net>",
    );
    expect(row[COL.RECEIVED_AT]).toBe("2026-03-02T14:30:00.000Z");
    expect(row[COL.CONTENT_HASH]).toBe("b".repeat(64));
    expect(row[COL.LABELS]).toBe(JSON.stringify(["Closing", "Urgent"]));

    for (const col of [
      COL.IN_REPLY_TO,
      COL.REFERENCES_HEADER,
      COL.RECEIVED_AT,
      COL.CONTENT_HASH,
      COL.LABELS,
    ]) {
      expect(row[col]).not.toBeNull();
    }
  });

  // ── Negative cases: a bad timestamp must not cost the user the whole email ──
  //
  // The per-email body is wrapped in `catch (emailError) { errors++; warn(...) }`.
  // A `RangeError: Invalid time value` from `new Date(bad).toISOString()` would be
  // swallowed there: the row is silently discarded and the sync still reports
  // success. `toIsoStringOrNull` is what prevents that.

  it("keeps the email when receivedAt is absent (received_at = null, row still inserted)", async () => {
    const { db, insertRuns } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db);

    await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "gmail",
      emails: [mkGmailEmail({ receivedAt: undefined })],
      getAttachmentsFn: jest.fn(),
    });

    // The email survives — this is the assertion that matters.
    expect(insertRuns).toHaveLength(1);
    const row = insertRuns[0];
    expect(row).toHaveLength(INSERT_ARITY);
    expect(row[COL.RECEIVED_AT]).toBeNull();
    // Only the one field is lost; the rest of the row is intact.
    expect(row[COL.EXTERNAL_ID]).toBe("g1");
    expect(row[COL.IN_REPLY_TO]).toBe("<CAF-parent-000@mail.example.com>");
  });

  it("keeps the email when receivedAt is unparseable (no RangeError swallowed into a dropped row)", async () => {
    const { db, insertRuns } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db);

    // An Invalid Date is exactly what `new Date("not-a-date")` yields when a
    // provider returns a malformed timestamp.
    const invalidDate = new Date("definitely-not-a-date");
    expect(Number.isNaN(invalidDate.getTime())).toBe(true); // fixture is genuinely invalid

    await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "outlook",
      emails: [mkOutlookEmail({ receivedAt: invalidDate })],
      getAttachmentsFn: jest.fn().mockResolvedValue([]),
    });

    expect(insertRuns).toHaveLength(1);
    const row = insertRuns[0];
    expect(row).toHaveLength(INSERT_ARITY);
    expect(row[COL.RECEIVED_AT]).toBeNull();
    expect(row[COL.EXTERNAL_ID]).toBe("o1");
    expect(row[COL.CONTENT_HASH]).toBe("b".repeat(64));
  });

  it("writes null (not the string 'undefined' or '[]') when the provider supplies no labels", async () => {
    const { db, insertRuns } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db);

    await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "outlook",
      emails: [mkOutlookEmail({ labels: [] })],
      getAttachmentsFn: jest.fn().mockResolvedValue([]),
    });

    expect(insertRuns).toHaveLength(1);
    // Empty array → NULL, so untagged mailboxes add no noise.
    expect(insertRuns[0][COL.LABELS]).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BACKLOG-2513: bulk_mail_headers reaches the INSERT
  //
  // Same species of defect as the five above: the providers had the values and
  // the writer discarded them. Asserted here at the INSERT boundary; the
  // producer suites assert that _parseMessage actually emits them.
  // ─────────────────────────────────────────────────────────────────────────

  it("Gmail: writes bulk_mail_headers as JSON with the declared key set", async () => {
    const { db, insertRuns } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db);

    const bulkMailHeaders = {
      list_unsubscribe: "<mailto:unsub@example.com>",
      precedence: "bulk",
      authentication_results: [
        "mx.example.com; dkim=pass header.i=@example.net",
        "mx2.example.com; spf=pass",
      ],
    };

    await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "gmail",
      emails: [mkGmailEmail({ bulkMailHeaders })],
      getAttachmentsFn: jest.fn(),
    });

    expect(insertRuns).toHaveLength(1);
    const row = insertRuns[0];
    expect(row).toHaveLength(INSERT_ARITY);
    expect(row[COL.BULK_MAIL_HEADERS]).toBe(JSON.stringify(bulkMailHeaders));

    // Round-trips, and the multi-hop array survives as an array — a JSON blob
    // that stringified the array into one string would still be "non-null".
    const parsed = JSON.parse(row[COL.BULK_MAIL_HEADERS] as string);
    expect(parsed.authentication_results).toEqual([
      "mx.example.com; dkim=pass header.i=@example.net",
      "mx2.example.com; spf=pass",
    ]);
    // The 2512 columns are undisturbed by the new one.
    expect(row[COL.LABELS]).toBe(JSON.stringify(["INBOX", "IMPORTANT"]));
    expect(row[COL.IN_REPLY_TO]).toBe("<CAF-parent-000@mail.example.com>");
  });

  it("Outlook: writes bulk_mail_headers as JSON", async () => {
    const { db, insertRuns } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db);

    const bulkMailHeaders = {
      list_unsubscribe: "<https://example.net/unsubscribe/abc>",
      auto_submitted: "auto-generated",
    };

    await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "outlook",
      emails: [mkOutlookEmail({ bulkMailHeaders })],
      getAttachmentsFn: jest.fn().mockResolvedValue([]),
    });

    expect(insertRuns).toHaveLength(1);
    const row = insertRuns[0];
    expect(row).toHaveLength(INSERT_ARITY);
    expect(row[COL.BULK_MAIL_HEADERS]).toBe(JSON.stringify(bulkMailHeaders));
    expect(row[COL.CONTENT_HASH]).toBe("b".repeat(64));
  });

  it("writes null when the message carried no bulk-mail headers (ordinary person-to-person mail)", async () => {
    const { db, insertRuns } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db);

    await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "gmail",
      emails: [mkGmailEmail({ bulkMailHeaders: null })],
      getAttachmentsFn: jest.fn(),
    });

    expect(insertRuns).toHaveLength(1);
    // NULL, not "{}" and not the string "null" — an ordinary email adds no noise.
    expect(insertRuns[0][COL.BULK_MAIL_HEADERS]).toBeNull();
  });

  it("writes null for an empty header object (not '{}')", async () => {
    const { db, insertRuns } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db);

    await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "outlook",
      emails: [mkOutlookEmail({ bulkMailHeaders: {} })],
      getAttachmentsFn: jest.fn().mockResolvedValue([]),
    });

    expect(insertRuns).toHaveLength(1);
    expect(insertRuns[0][COL.BULK_MAIL_HEADERS]).toBeNull();
  });
});

/**
 * BACKLOG-2571 — what actually lands in sent_at.
 *
 * The parser suites assert that each provider PRODUCES a distinct `sentDate`.
 * This one asserts the writer BINDS it, which is the half that decides what a
 * date-range query returns. The two are separable and both are needed: a parser
 * that emits the right value into a column nobody binds changes nothing.
 */
describe("BACKLOG-2571: sent_at binds the send time, received_at the receive time", () => {
  // Nine minutes apart, so no assertion below can pass by the two coinciding.
  const RECEIVE = new Date("2026-08-05T20:22:41.000Z");
  const SEND = new Date("2026-08-05T20:13:41.000Z");

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetOAuthToken.mockResolvedValue({
      id: "acct-1",
      connected_email_address: "me@example.com",
    });
    mockDbAll.mockReturnValue([]); // nothing pre-existing → all inserts are new
  });

  it("binds sent_at from sentDate and received_at from receivedAt, with the source marker", async () => {
    const { db, insertRuns } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db as never);

    await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "gmail",
      emails: [
        mkGmailEmail({
          date: RECEIVE,
          sentDate: SEND,
          receivedAt: RECEIVE,
          sentAtSource: "sender",
        }),
      ],
      getAttachmentsFn: jest.fn().mockResolvedValue([]),
    });

    expect(insertRuns).toHaveLength(1);
    expect(insertRuns[0]).toHaveLength(INSERT_ARITY);
    expect(insertRuns[0][COL.SENT_AT]).toBe(SEND.toISOString());
    expect(insertRuns[0][COL.RECEIVED_AT]).toBe(RECEIVE.toISOString());
    expect(insertRuns[0][COL.SENT_AT_SOURCE]).toBe("sender");
    // The whole point: the two columns are no longer the same value.
    expect(insertRuns[0][COL.SENT_AT]).not.toBe(insertRuns[0][COL.RECEIVED_AT]);
  });

  it("records 'received' when the provider had no usable send time", async () => {
    const { db, insertRuns } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db as never);

    // Gmail with no usable Date: header — the parser substitutes the receive
    // time and says so. The substitution is legitimate; leaving it unlabelled
    // would not be.
    await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "gmail",
      emails: [
        mkGmailEmail({
          date: RECEIVE,
          sentDate: RECEIVE,
          receivedAt: RECEIVE,
          sentAtSource: "received",
        }),
      ],
      getAttachmentsFn: jest.fn().mockResolvedValue([]),
    });

    expect(insertRuns[0][COL.SENT_AT]).toBe(RECEIVE.toISOString());
    expect(insertRuns[0][COL.SENT_AT_SOURCE]).toBe("received");
  });

  it("falls back to `date` and writes a NULL marker when a caller supplies no sentDate", async () => {
    const { db, insertRuns } = makeFakeDb();
    mockGetRawDatabase.mockReturnValue(db as never);

    // An un-migrated producer degrades to the OLD behaviour rather than writing
    // NULL into a column eleven consumers read. NULL in the marker then says
    // "unrecorded", which is the honest answer for such a row.
    const email = mkGmailEmail({ date: RECEIVE, receivedAt: RECEIVE });
    delete (email as { sentDate?: Date | null }).sentDate;
    delete (email as { sentAtSource?: string | null }).sentAtSource;

    await storeParsedEmailsForAccount({
      userId: "u-1",
      provider: "gmail",
      emails: [email],
      getAttachmentsFn: jest.fn().mockResolvedValue([]),
    });

    expect(insertRuns[0][COL.SENT_AT]).toBe(RECEIVE.toISOString());
    expect(insertRuns[0][COL.SENT_AT_SOURCE]).toBeNull();
  });
});
