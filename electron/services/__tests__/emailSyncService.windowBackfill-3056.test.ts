/**
 * @jest-environment node
 */
// ===========================================================================
// BACKLOG-3056 — widening the email history window must fetch the older mail
// ===========================================================================
//
// THE DEFECT, IN THE FOUNDER'S WORDS: he raised Email History from 3 to 6 to 12
// months, pressed Re-cache after each, and was told "Cached 0 new emails
// (1 checked)" every time. `cacheSinceDate` travelled back nine months in his
// dev log; `fetchSinceDate` never moved off the newest already-cached email.
//
// The clamp in `precacheEmails` only ever moves the fetch start FORWARD, so a
// window that widens BACKWARDS is silently ignored — and the run reports
// success. The fix fetches two ranges on one incremental run:
//
//     [cacheSinceDate .. oldestCached)   <- the newly-opened gap (backfill)
//     [latestCached   .. now]            <- the usual incremental
//
// ---------------------------------------------------------------------------
// WHY THE DATABASE IS REAL HERE
// ---------------------------------------------------------------------------
// Every claim is a claim about rows: "the older emails are now present", "the
// rows cached before are still linked to their transactions". A mocked
// `dbGet`/`dbRun` can only confirm that strings reached a spy, which cannot
// separate a working backfill from a broken one. So `dbConnection` points at a
// real in-memory database loaded from `electron/database/schema.sql` with
// FOREIGN KEYS ON — the cascade from `emails` to `communications` is exactly
// what the link-survival control is watching for. Only the network is mocked.
//
// ---------------------------------------------------------------------------
// FIXTURE PROVENANCE — TRANSCRIBED FROM THE REAL MAPPER, NOT INVENTED
// ---------------------------------------------------------------------------
// `outlookEmail()` below emits the shape `outlookFetchService._parseMessage`
// actually produces. It was captured by driving the REAL service — mocked axios
// in, `searchEmails()` out — on 2026-09-02 in this worktree, and the printed
// object pasted here field for field. The Graph message fed to it uses the
// documented `message` resource shape (learn.microsoft.com, Get message).
//
// Two details of that capture matter and would not have been guessed:
//   - `cc`/`bcc` come back as EMPTY STRINGS, not null, when the recipient
//     arrays are empty.
//   - `sentDate` is populated and is what `emails.sent_at` stores
//     (`toIsoStringOrNull(email.sentDate ?? email.date)`), so it — not `date` —
//     is what MIN(sent_at)/MAX(sent_at) see. A fixture omitting `sentDate`
//     would have silently moved every bound in this file by one minute.
// `contentHash` is computed with the real `computeEmailHash` rather than pasted,
// because a pasted hash would stop describing the message the moment a
// parameter changed.
//
// ---------------------------------------------------------------------------
// CONTROLS, AND THE MUTATION THAT MAKES EACH RED
// ---------------------------------------------------------------------------
//   1. reproduction        -> revert the backfill: no second range is requested
//   2. A ∪ B by id set     -> same
//   3. links survive       -> would go red if the fix ever deleted/rebuilt rows
//   4. must-not-fire       -> change the gap test from `<` to `<=` (equality) or
//                             drop it entirely (always backfills)
//   5. boundaries          -> as above, per case
//   6. force path unchanged-> restore a bounds read on the force path

import * as nodePath from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;

jest.mock("../db/core/dbConnection", () => ({
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
  getRawDatabase: () => db,
}));

const mockGetOAuthToken = jest.fn();
const mockUpsertAttachmentMeta = jest.fn();
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getOAuthToken: (...a: unknown[]) => mockGetOAuthToken(...a),
    upsertEmailAttachmentMetadata: (...a: unknown[]) => mockUpsertAttachmentMeta(...a),
  },
}));

const mockOutlookInit = jest.fn();
const mockOutlookSearch = jest.fn();
const mockOutlookSearchAll = jest.fn();
jest.mock("../outlookFetchService", () => ({
  __esModule: true,
  default: {
    initialize: (...a: unknown[]) => mockOutlookInit(...a),
    searchEmails: (...a: unknown[]) => mockOutlookSearch(...a),
    searchAllFolders: (...a: unknown[]) => mockOutlookSearchAll(...a),
    getAttachments: jest.fn().mockResolvedValue([]),
  },
}));

const mockGmailInit = jest.fn();
const mockGmailSearch = jest.fn();
const mockGmailSearchAll = jest.fn();
jest.mock("../gmailFetchService", () => ({
  __esModule: true,
  default: {
    initialize: (...a: unknown[]) => mockGmailInit(...a),
    searchEmails: (...a: unknown[]) => mockGmailSearch(...a),
    searchAllLabels: (...a: unknown[]) => mockGmailSearchAll(...a),
  },
}));

jest.mock("../networkResilience", () => ({
  retryOnNetwork: (fn: () => Promise<unknown>) => fn(),
  networkResilienceService: {},
}));

// The user's Email History setting, made MUTABLE. Every other precache suite
// pins this to a constant, which is precisely the state in which this defect is
// invisible: the bug only exists across a CHANGE of window.
let mockCacheSince = new Date("2026-06-01T00:00:00Z");
let mockCacheMonths = 3;
jest.mock("../../utils/preferenceHelper", () => ({
  getEmailCacheDurationMonths: jest.fn(() => Promise.resolve(mockCacheMonths)),
  computeEmailCacheSinceDate: jest.fn(() => mockCacheSince),
}));

const mockReprocess = jest.fn().mockResolvedValue({
  scanned: 0,
  rewritten: 0,
  unchanged: 0,
  batches: 0,
});
jest.mock("../emailDerivationReprocessService", () => ({
  reprocessEmailDerivations: (...a: unknown[]) => mockReprocess(...a),
}));

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import emailSyncService from "../emailSyncService";
import { computeEmailHash } from "../../utils/emailHash";

const SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3056";

const OUTLOOK_TOKEN = {
  id: "acct-outlook",
  access_token: "at",
  connected_email_address: "agent@example.com",
};
const GMAIL_TOKEN = {
  id: "acct-gmail",
  access_token: "at",
  connected_email_address: "agent@example.net",
};

/** Windows the founder actually stepped through, as dates. */
const WINDOW_3_MONTHS = new Date("2026-06-01T00:00:00Z");
const WINDOW_12_MONTHS = new Date("2025-09-01T00:00:00Z");

/**
 * The transcribed `ParsedEmail`. See FIXTURE PROVENANCE above.
 *
 * `sentAt` is the send time and therefore what `emails.sent_at` stores; `date`
 * (the receive time) is held one minute later, which is the relationship the
 * real capture exhibited.
 */
function outlookEmail(args: { externalId: string; sentAt: string; subject?: string }) {
  const subject = args.subject ?? `Counter-offer follow-up ${args.externalId}`;
  const from = "Dana Reyes <dana@example.com>";
  const sentDate = new Date(args.sentAt);
  const receivedDate = new Date(sentDate.getTime() + 60_000);
  const bodyPlain = "Paragraph one.\nParagraph two.";
  return {
    id: args.externalId,
    threadId: `AAQkAGI2THk9xQ==${args.externalId}`,
    subject,
    from,
    to: "agent@example.com",
    cc: "",
    bcc: "",
    date: receivedDate,
    sentDate,
    body:
      '<html>\r\n<head>\r\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8">\r\n' +
      "</head>\r\n<body>\r\n<p>Paragraph one.</p><p>Paragraph two.</p>\r\n</body>\r\n</html>\r\n",
    bodyPlain,
    snippet: "Paragraph one. Paragraph two.",
    hasAttachments: false,
    attachmentCount: 0,
    participants: [
      {
        email_address: "dana@example.com",
        display_name: "Dana Reyes",
        role: "from" as const,
        position: 0,
      },
      {
        email_address: "agent@example.com",
        display_name: "Agent",
        role: "to" as const,
        position: 0,
      },
    ],
    inferenceClassification: "focused",
    parentFolderId: "AQMkADYAAAIBDAAAAA==",
    messageIdHeader: `<${args.externalId}@example.com>`,
    inReplyTo: null,
    references: null,
    receivedAt: receivedDate,
    labels: [],
    bulkMailHeaders: null,
    contentHash: computeEmailHash({ subject, from, sentDate, bodyPlain }),
    ingestSource: "filter" as const,
  };
}

function loadSchema(database: DatabaseType): void {
  database.pragma("foreign_keys = OFF");
  database.exec(fs.readFileSync(SCHEMA, "utf8"));
  database.pragma("foreign_keys = ON");
}

function seedParents(): void {
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'microsoft', ?)`,
  ).run(USER, "agent@example.com", "oid-1");
  db.prepare(
    `INSERT INTO oauth_tokens (id, user_id, provider, purpose, connected_email_address)
     VALUES ('acct-outlook', ?, 'microsoft', 'mailbox', 'agent@example.com')`,
  ).run(USER);
  db.prepare(
    `INSERT INTO oauth_tokens (id, user_id, provider, purpose, connected_email_address)
     VALUES ('acct-gmail', ?, 'google', 'mailbox', 'agent@example.net')`,
  ).run(USER);
}

/** A row that was already cached before the run under test. */
function seedEmail(args: { id: string; externalId: string; sentAt: string }): void {
  db.prepare(
    `INSERT INTO emails
       (id, user_id, external_id, source, account_id, subject, body_plain, body_html,
        sender, recipients, sent_at, received_at, message_id_header, derived_version)
     VALUES (?, ?, ?, 'outlook', 'acct-outlook', ?, 'seeded', '<html>seeded</html>',
             'dana@example.com', 'agent@example.com', ?, ?, ?, 0)`,
  ).run(
    args.id,
    USER,
    args.externalId,
    `Seeded ${args.id}`,
    args.sentAt,
    args.sentAt,
    `<seed-${args.id}@example.com>`,
  );
}

const externalIdSet = (): string[] =>
  (
    db
      .prepare(`SELECT external_id FROM emails WHERE user_id = ? ORDER BY external_id`)
      .all(USER) as Array<{ external_id: string | null }>
  ).map((r) => r.external_id ?? "(null)");

const localIdByExternalId = (externalId: string): string | undefined =>
  (
    db
      .prepare(`SELECT id FROM emails WHERE user_id = ? AND external_id = ?`)
      .get(USER, externalId) as { id: string } | undefined
  )?.id;

/** Every `{after, before}` pair a provider round was asked for, in call order. */
interface RangeCall {
  after?: Date | null;
  before?: Date | null;
}
const rangesOf = (mock: jest.Mock): Array<{ after: string; before: string | null }> =>
  mock.mock.calls.map(([opts]) => {
    const { after, before } = opts as RangeCall;
    return {
      after: after ? after.toISOString() : "(none)",
      before: before ? before.toISOString() : null,
    };
  });

/** The rounds that carry an upper bound — i.e. the backfill rounds. */
const backfillRanges = (mock: jest.Mock) => rangesOf(mock).filter((r) => r.before !== null);

beforeEach(() => {
  jest.clearAllMocks();
  db = new Database(":memory:") as unknown as DatabaseType;
  loadSchema(db);
  seedParents();

  mockCacheSince = WINDOW_3_MONTHS;
  mockCacheMonths = 3;

  // Outlook only unless a test says otherwise, so the ranges under assertion
  // belong to one provider and cannot be confused with the other's.
  mockGetOAuthToken.mockImplementation(async (_u: string, provider: string) =>
    provider === "microsoft" ? OUTLOOK_TOKEN : null,
  );
  mockOutlookInit.mockResolvedValue(true);
  mockOutlookSearch.mockResolvedValue([]);
  mockOutlookSearchAll.mockResolvedValue([]);
  mockGmailInit.mockResolvedValue(false);
  mockGmailSearch.mockResolvedValue([]);
  mockGmailSearchAll.mockResolvedValue([]);
});

afterEach(() => {
  db.close();
});

// ===========================================================================
// CONTROL 4 — THE MUST-NOT-FIRE CASES. Written first, on purpose.
//
// A fix that simply always refetches from `cacheSinceDate` would satisfy every
// other control in this file and destroy the point of the clamp: an ordinary
// re-cache would re-download the whole window on every press. These two tests
// are what stop that, and they assert CALL COUNTS — "no older mail appeared" is
// also true of a run that fetched everything and deduplicated it away.
// ===========================================================================
describe("the window did not widen — nothing extra may be fetched", () => {
  it("a NARROWED window makes no extra provider call", async () => {
    // Cached: 2026-03-01 .. 2026-06-15. The user narrows to 2026-04-01, which is
    // LATER than the oldest cached row: there is no gap, only surplus.
    seedEmail({ id: "live-old", externalId: "ext-old", sentAt: "2026-03-01T09:00:00.000Z" });
    seedEmail({ id: "live-new", externalId: "ext-new", sentAt: "2026-06-15T09:00:00.000Z" });
    mockCacheSince = new Date("2026-04-01T00:00:00Z");
    mockCacheMonths = 6;

    await emailSyncService.precacheEmails(USER);

    expect(mockOutlookSearch).toHaveBeenCalledTimes(1);
    expect(mockOutlookSearchAll).toHaveBeenCalledTimes(1);
    expect(backfillRanges(mockOutlookSearch)).toEqual([]);
    expect(backfillRanges(mockOutlookSearchAll)).toEqual([]);
  });

  it("an UNCHANGED window makes no extra provider call", async () => {
    // The steady state of a mailbox with continuous history: the cache reaches
    // back PAST the configured floor, because the floor slides forward daily
    // while the oldest cached row stays where it is.
    seedEmail({ id: "live-old", externalId: "ext-old", sentAt: "2026-05-20T09:00:00.000Z" });
    seedEmail({ id: "live-new", externalId: "ext-new", sentAt: "2026-06-15T09:00:00.000Z" });
    // The window is exactly the one the cache was built under.
    mockCacheSince = WINDOW_3_MONTHS;

    await emailSyncService.precacheEmails(USER);

    expect(mockOutlookSearch).toHaveBeenCalledTimes(1);
    expect(mockOutlookSearchAll).toHaveBeenCalledTimes(1);
    expect(backfillRanges(mockOutlookSearch)).toEqual([]);
    // The incremental round still starts at the newest cached row — the clamp
    // this item does NOT remove.
    expect(rangesOf(mockOutlookSearch)[0]).toEqual({
      after: "2026-06-15T09:00:00.000Z",
      before: null,
    });
  });
});

// ===========================================================================
// CONTROL 1 — THE DEFECT ITSELF.
//
// Run against the unfixed service this is the founder's log: one range only,
// starting at the newest cached row, however far back the window is dragged.
// ===========================================================================
describe("widening the window opens a gap that must be fetched", () => {
  it("requests the newly-opened older range as well as the incremental one", async () => {
    seedEmail({ id: "live-1", externalId: "ext-A1", sentAt: "2026-06-15T09:00:00.000Z" });
    seedEmail({ id: "live-2", externalId: "ext-A2", sentAt: "2026-07-20T09:00:00.000Z" });
    mockCacheSince = WINDOW_12_MONTHS;
    mockCacheMonths = 12;

    await emailSyncService.precacheEmails(USER);

    // The incremental range is unchanged: still clamped to the newest row.
    expect(rangesOf(mockOutlookSearch)).toContainEqual({
      after: "2026-07-20T09:00:00.000Z",
      before: null,
    });
    // And the gap [configured floor .. oldest cached) is now asked for.
    expect(backfillRanges(mockOutlookSearch)).toEqual([
      { after: "2025-09-01T00:00:00.000Z", before: "2026-06-15T09:00:00.000Z" },
    ]);
    expect(backfillRanges(mockOutlookSearchAll)).toEqual([
      { after: "2025-09-01T00:00:00.000Z", before: "2026-06-15T09:00:00.000Z" },
    ]);
  });

  // =========================================================================
  // CONTROL 2 — THE EXACT ID SET, over two real cycles.
  //
  // Cycle 1 caches A under a 3-month window. The window widens to 12 months.
  // Cycle 2 must deliver exactly B — the older ids the first window excluded —
  // and keep A. Asserted as a SET, never a count: "more emails than before"
  // is equally true of a run that re-downloaded A under new local ids, which
  // would be the force-re-cache behaviour the founder rejected.
  // =========================================================================
  it("cycle 2 delivers exactly the older ids the first window excluded (A ∪ B)", async () => {
    const A = [
      outlookEmail({ externalId: "ext-A1", sentAt: "2026-06-15T09:00:00.000Z" }),
      outlookEmail({ externalId: "ext-A2", sentAt: "2026-07-20T09:00:00.000Z" }),
    ];
    const B = [
      outlookEmail({ externalId: "ext-B1", sentAt: "2025-11-05T09:00:00.000Z" }),
      outlookEmail({ externalId: "ext-B2", sentAt: "2026-01-20T09:00:00.000Z" }),
    ];

    // CYCLE 1 — 3-month window, empty cache.
    mockOutlookSearch.mockResolvedValue(A);
    await emailSyncService.precacheEmails(USER);
    expect(externalIdSet()).toEqual(["ext-A1", "ext-A2"]);
    const localIdsAfterCycle1 = {
      A1: localIdByExternalId("ext-A1"),
      A2: localIdByExternalId("ext-A2"),
    };

    // CYCLE 2 — the user widens Email History to 1 year and presses Re-cache.
    // The mailbox holds nothing new; only the older range has anything in it.
    mockCacheSince = WINDOW_12_MONTHS;
    mockCacheMonths = 12;
    mockOutlookSearch.mockReset();
    mockOutlookSearch.mockImplementation(({ before }: RangeCall) =>
      Promise.resolve(before ? B : []),
    );

    await emailSyncService.precacheEmails(USER);

    // B, named: ext-B1 (2025-11-05) and ext-B2 (2026-01-20) — both older than
    // the 3-month floor, both inside the 12-month one.
    expect(externalIdSet()).toEqual(["ext-A1", "ext-A2", "ext-B1", "ext-B2"]);
    // A was not re-downloaded under new local ids.
    expect(localIdByExternalId("ext-A1")).toBe(localIdsAfterCycle1.A1);
    expect(localIdByExternalId("ext-A2")).toBe(localIdsAfterCycle1.A2);
  });

  // =========================================================================
  // CONTROL 3 — LINKS SURVIVE.
  //
  // This is the whole reason backfill was chosen over "tell the user to press
  // Force re-cache": a force run deletes and re-inserts every row, and the
  // `communications` rows die with them by ON DELETE CASCADE. Foreign keys are
  // ON in this database, so that cascade is live — if the backfill ever went
  // near a delete, this goes red.
  // =========================================================================
  it("emails cached in cycle 1 are still linked to their transaction after cycle 2", async () => {
    mockOutlookSearch.mockResolvedValue([
      outlookEmail({ externalId: "ext-A1", sentAt: "2026-06-15T09:00:00.000Z" }),
    ]);
    await emailSyncService.precacheEmails(USER);
    const linkedEmailId = localIdByExternalId("ext-A1");
    expect(linkedEmailId).toBeDefined();

    db.prepare(
      `INSERT INTO transactions (id, user_id, property_address, transaction_type, status)
       VALUES ('txn-1', ?, '12 Example Street', 'purchase', 'active')`,
    ).run(USER);
    // `thread_id` is not decoration: the BACKLOG-1768 trigger
    // `communications_email_thread_required` ABORTS an email link that omits it
    // when the email carries one. Read back off the stored row rather than
    // restated, so the link is the shape the app's own writers produce.
    const linkedThreadId = (
      db.prepare(`SELECT thread_id FROM emails WHERE id = ?`).get(linkedEmailId) as {
        thread_id: string | null;
      }
    ).thread_id;
    db.prepare(
      `INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id, link_source)
       VALUES ('comm-1', ?, 'txn-1', ?, ?, 'auto')`,
    ).run(USER, linkedEmailId, linkedThreadId);

    mockCacheSince = WINDOW_12_MONTHS;
    mockCacheMonths = 12;
    mockOutlookSearch.mockReset();
    mockOutlookSearch.mockImplementation(({ before }: RangeCall) =>
      Promise.resolve(
        before ? [outlookEmail({ externalId: "ext-B1", sentAt: "2025-11-05T09:00:00.000Z" })] : [],
      ),
    );

    await emailSyncService.precacheEmails(USER);

    expect(externalIdSet()).toEqual(["ext-A1", "ext-B1"]);
    const link = db
      .prepare(`SELECT transaction_id, email_id FROM communications WHERE id = 'comm-1'`)
      .get() as { transaction_id: string; email_id: string } | undefined;
    // Identity, not existence: the link must still point at the SAME row.
    expect(link).toEqual({ transaction_id: "txn-1", email_id: linkedEmailId });
  });

  it("Gmail gets the same second range as Outlook", async () => {
    seedEmail({ id: "live-1", externalId: "ext-A1", sentAt: "2026-06-15T09:00:00.000Z" });
    mockGetOAuthToken.mockImplementation(async (_u: string, provider: string) =>
      provider === "microsoft" ? OUTLOOK_TOKEN : GMAIL_TOKEN,
    );
    mockGmailInit.mockResolvedValue(true);
    mockCacheSince = WINDOW_12_MONTHS;
    mockCacheMonths = 12;

    await emailSyncService.precacheEmails(USER);

    const expected = [
      { after: "2025-09-01T00:00:00.000Z", before: "2026-06-15T09:00:00.000Z" },
    ];
    expect(backfillRanges(mockGmailSearch)).toEqual(expected);
    expect(backfillRanges(mockGmailSearchAll)).toEqual(expected);
  });

  it("a cancel during the incremental rounds stops the backfill from starting", async () => {
    seedEmail({ id: "live-1", externalId: "ext-A1", sentAt: "2026-06-15T09:00:00.000Z" });
    mockCacheSince = WINDOW_12_MONTHS;
    mockCacheMonths = 12;
    mockOutlookSearchAll.mockImplementation(async () => {
      emailSyncService.requestPrecacheCancellation();
      return [];
    });

    const result = await emailSyncService.precacheEmails(USER);

    expect(result.cancelled).toBe(true);
    expect(backfillRanges(mockOutlookSearch)).toEqual([]);
    expect(backfillRanges(mockOutlookSearchAll)).toEqual([]);
  });
});

// ===========================================================================
// CONTROL 5 — THE BOUNDARIES, SWEPT.
// ===========================================================================
describe("boundaries of the gap decision", () => {
  it("no cached emails at all: one range, no backfill", async () => {
    mockCacheSince = WINDOW_12_MONTHS;
    mockCacheMonths = 12;

    await emailSyncService.precacheEmails(USER);

    expect(mockOutlookSearch).toHaveBeenCalledTimes(1);
    expect(rangesOf(mockOutlookSearch)).toEqual([
      { after: "2025-09-01T00:00:00.000Z", before: null },
    ]);
  });

  it("exactly one cached email: the backfill ends at that row", async () => {
    seedEmail({ id: "live-only", externalId: "ext-only", sentAt: "2026-06-15T09:00:00.000Z" });
    mockCacheSince = WINDOW_12_MONTHS;
    mockCacheMonths = 12;

    await emailSyncService.precacheEmails(USER);

    expect(backfillRanges(mockOutlookSearch)).toEqual([
      { after: "2025-09-01T00:00:00.000Z", before: "2026-06-15T09:00:00.000Z" },
    ]);
    // The same row is both bounds' source: newest for the clamp, oldest for the
    // backfill.
    expect(rangesOf(mockOutlookSearch)).toContainEqual({
      after: "2026-06-15T09:00:00.000Z",
      before: null,
    });
  });

  it("the configured floor EQUALS the oldest cached row: no backfill", async () => {
    seedEmail({ id: "live-old", externalId: "ext-old", sentAt: "2026-06-01T00:00:00.000Z" });
    seedEmail({ id: "live-new", externalId: "ext-new", sentAt: "2026-06-15T09:00:00.000Z" });
    mockCacheSince = new Date("2026-06-01T00:00:00.000Z");

    await emailSyncService.precacheEmails(USER);

    expect(mockOutlookSearch).toHaveBeenCalledTimes(1);
    expect(backfillRanges(mockOutlookSearch)).toEqual([]);
  });

  it("a widened window with nothing older in the mailbox reports success and changes nothing", async () => {
    seedEmail({ id: "live-1", externalId: "ext-A1", sentAt: "2026-06-15T09:00:00.000Z" });
    mockCacheSince = WINDOW_12_MONTHS;
    mockCacheMonths = 12;
    // Both ranges come back empty — the mailbox simply has no older mail.
    mockOutlookSearch.mockResolvedValue([]);

    const result = await emailSyncService.precacheEmails(USER);

    expect(backfillRanges(mockOutlookSearch)).toHaveLength(1);
    expect(externalIdSet()).toEqual(["ext-A1"]);
    expect(result.error).toBeUndefined();
    expect(result.stored).toBe(0);
  });
});

// ===========================================================================
// CONTROL 6 — THE FORCE PATH IS NOT TOUCHED.
//
// BACKLOG-2856's clamp bypass exists because stage-and-swap leaves live
// `emails` populated during the rebuild. A force run reads the whole window in
// ONE range and must not acquire a second one.
// ===========================================================================
describe("force re-cache is unchanged", () => {
  it("asks for the full window once, with no upper bound", async () => {
    seedEmail({ id: "live-1", externalId: "ext-A1", sentAt: "2026-06-15T09:00:00.000Z" });
    seedEmail({ id: "live-2", externalId: "ext-A2", sentAt: "2026-07-20T09:00:00.000Z" });
    mockCacheSince = WINDOW_12_MONTHS;
    mockCacheMonths = 12;

    await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(rangesOf(mockOutlookSearch)).toEqual([
      { after: "2025-09-01T00:00:00.000Z", before: null },
    ]);
    expect(rangesOf(mockOutlookSearchAll)).toEqual([
      { after: "2025-09-01T00:00:00.000Z", before: null },
    ]);
  });
});
