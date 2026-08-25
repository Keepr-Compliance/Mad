/**
 * @jest-environment node
 *
 * BACKLOG-2856 (founder live QA, 2026-08-25) — cancelling a re-cache STOPS WORK,
 * not just the swap.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT, AS HE MEASURED IT
 * ---------------------------------------------------------------------------
 *   20:32:43.586  Email force re-cache staging created
 *   20:32:44.961  Email pre-cache cancellation requested   <- he clicked here
 *   20:33:09.713  [OutlookFetch] Total messages found: 487
 *   20:33:13.295  Outlook pre-cache complete — inboxFetched 487, totalStored 487
 *   20:33:13.295  cancelled before the swap — the email store was never touched
 *
 * 28.3 seconds, and all 487 messages downloaded AND staged before being thrown
 * away. The safety guarantee held perfectly; the cancel bought nothing. A Cancel
 * that costs exactly as much as not cancelling is a button that lies.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MAIN ASSERTION IS A ROW COUNT IN STAGING, NOT `cancelled === true`
 * ---------------------------------------------------------------------------
 * `result.cancelled` was already true on the build he ran. Every existing cancel
 * control in `emailSyncService.precacheProgress-2856` passes on that build too,
 * because they assert what a cancel PREVENTS (the swap) and the swap was already
 * prevented. Nothing asserted what a cancel STOPS.
 *
 * So the control here is `0 < stagedAfterCancel < stagedByAFullRun`, read out of
 * the staging table itself in the terminal progress event — the last moment
 * before the `finally` drops it. Both bounds matter:
 *   - the upper bound is the defect: a cancel that stages everything stopped
 *     nothing;
 *   - the lower bound is the fixture's own control: a zero would mean the fetch
 *     threw and nothing was ever attempted, which would let a broken abort path
 *     masquerade as a working one.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FETCH MOCK IS ABORT-DRIVEN
 * ---------------------------------------------------------------------------
 * A mock that returned a short list because `options.signal` was PRESENT would
 * describe a state the code cannot emit, and would go green against a build that
 * merely passed the signal without honouring it. This mock walks folders and
 * consults `signal.aborted` between them — the same shape `searchAllFolders` now
 * has — so it returns the full set unless the signal ACTUALLY flips mid-flight.
 * That the real loop matches is pinned separately, against axios, in
 * `outlookFetchService.cancellation-2856`.
 *
 * ---------------------------------------------------------------------------
 * MUTATIONS
 * ---------------------------------------------------------------------------
 *   1. remove `signal: abort.signal` from the pre-cache fetch calls
 *        -> "stages fewer rows" goes RED (the full mailbox is staged)
 *        -> "stops within a bounded cost" goes RED
 *   2. remove the pre-swap `isCancelled()` checkpoint
 *        -> "leaves the live row-id set identical" goes RED
 */

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
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getOAuthToken: (...a: unknown[]) => mockGetOAuthToken(...a),
    upsertEmailAttachmentMetadata: jest.fn(),
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

jest.mock("../gmailFetchService", () => ({
  __esModule: true,
  default: {
    initialize: jest.fn().mockResolvedValue(false),
    searchEmails: jest.fn().mockResolvedValue([]),
    searchAllLabels: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock("../networkResilience", () => ({
  retryOnNetwork: (fn: () => Promise<unknown>) => fn(),
  networkResilienceService: {},
}));

jest.mock("../../utils/preferenceHelper", () => ({
  getEmailCacheDurationMonths: jest.fn().mockResolvedValue(12),
  computeEmailCacheSinceDate: jest.fn(() => new Date("2026-01-01T00:00:00Z")),
}));

const mockReprocess = jest.fn();
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
import { EMAIL_STAGING_TABLE_PREFIX } from "../emailForceStaging";
import type { EmailPrecacheProgress } from "../emailPrecacheProgress";

const SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-cancel";

const OUTLOOK_TOKEN = {
  id: "acct-outlook",
  access_token: "at",
  connected_email_address: "me@example.com",
};

/** A provider row in the shape the real Outlook mapper emits. */
function providerEmail(n: number) {
  return {
    id: `ext-${n}`,
    subject: `Subject ${n}`,
    from: `sender${n}@example.com`,
    to: "me@example.com",
    cc: null,
    bcc: null,
    body: `<html><body><p>Message ${n}.</p></body></html>`,
    bodyPlain: `Message ${n}.`,
    date: new Date(`2026-03-01T10:00:00Z`),
    threadId: `thread-${n}`,
    messageIdHeader: `<msg-${n}@example.com>`,
    hasAttachments: false,
    attachments: [],
    participants: [
      { role: "from", position: 0, email_address: `sender${n}@example.com`, display_name: null },
      { role: "to", position: 0, email_address: "me@example.com", display_name: null },
    ],
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
  ).run(USER, "me@example.com", "oid-1");
  db.prepare(
    `INSERT INTO oauth_tokens (id, user_id, provider, purpose, connected_email_address)
     VALUES ('acct-outlook', ?, 'microsoft', 'mailbox', 'me@example.com')`,
  ).run(USER);
}

function seedEmail(id: string, externalId: string): void {
  db.prepare(
    `INSERT INTO emails
       (id, user_id, external_id, source, account_id, subject, body_plain, body_html,
        sender, recipients, sent_at, received_at, message_id_header, derived_version)
     VALUES (?, ?, ?, 'outlook', 'acct-outlook', ?, 'truncated…', '<html/>',
             'someone@example.com', 'me@example.com', ?, ?, ?, 0)`,
  ).run(id, USER, externalId, `Seeded ${id}`, "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z", `<seed-${id}@example.com>`);
}

const liveRowIds = (): Set<string> =>
  new Set(
    (db.prepare(`SELECT id FROM emails WHERE user_id = ?`).all(USER) as Array<{ id: string }>).map(
      (r) => r.id,
    ),
  );

const stagingTables = (): string[] =>
  (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?`)
      .all(`${EMAIL_STAGING_TABLE_PREFIX}%`) as Array<{ name: string }>
  ).map((r) => r.name);

/** Rows currently sitting in the force run's staging table for `emails`. */
function countStagedEmails(): number {
  const table = stagingTables().find((t) => t.endsWith("_emails"));
  if (!table) return 0;
  return (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

// ---------------------------------------------------------------------------
// The abort-driven fetch fixture.
// ---------------------------------------------------------------------------
const FOLDER_COUNT = 5;
const PER_FOLDER = 4;
/** What one folder costs. Virtual, so nothing here can depend on wall-clock. */
const MS_PER_FOLDER = 1000;

let virtualMs = 0;
/** Called as each folder lands, so a test can cancel at a chosen point. */
let onFolderFetched: (folderIndex: number) => void = () => {};

/**
 * Stands in for `outlookFetchService.searchAllFolders`: walks folders, consults
 * the signal BETWEEN them, and returns what it has. Deliberately mirrors the
 * real loop rather than short-circuiting on the signal's mere presence.
 */
async function walkFolders(options?: { signal?: AbortSignal }): Promise<ReturnType<typeof providerEmail>[]> {
  const out: ReturnType<typeof providerEmail>[] = [];
  for (let folder = 0; folder < FOLDER_COUNT; folder++) {
    if (options?.signal?.aborted) break;
    await Promise.resolve();
    virtualMs += MS_PER_FOLDER;
    for (let i = 0; i < PER_FOLDER; i++) {
      out.push(providerEmail(folder * PER_FOLDER + i));
    }
    onFolderFetched(folder);
  }
  return out;
}

const FULL_MAILBOX = FOLDER_COUNT * PER_FOLDER; // 20

beforeEach(() => {
  jest.clearAllMocks();
  db = new Database(":memory:") as unknown as DatabaseType;
  loadSchema(db);
  seedParents();

  virtualMs = 0;
  onFolderFetched = () => {};

  mockGetOAuthToken.mockImplementation(async (_u: string, provider: string) =>
    provider === "microsoft" ? OUTLOOK_TOKEN : null,
  );
  mockOutlookInit.mockResolvedValue(true);
  // The inbox round returns nothing; every message arrives through the folder
  // walk, so the row counts below measure exactly the loop under test.
  mockOutlookSearch.mockResolvedValue([]);
  mockOutlookSearchAll.mockImplementation(walkFolders);
  mockReprocess.mockResolvedValue({
    scanned: 0,
    rewritten: 0,
    unchanged: 0,
    batches: 0,
    cancelled: false,
    skippedNeedsRefetch: false,
  });
});

afterEach(() => {
  db.close();
});

/**
 * Run a force pre-cache, capturing the staging row count from inside the
 * terminal progress event — which the `finally` emits immediately BEFORE it
 * drops the staging tables, and is therefore the only moment the count can be
 * observed at all.
 */
async function runForce(): Promise<{
  stagedAtEnd: number;
  virtualMsAtEnd: number;
  result: Awaited<ReturnType<typeof emailSyncService.precacheEmails>>;
  events: EmailPrecacheProgress[];
}> {
  const events: EmailPrecacheProgress[] = [];
  let stagedAtEnd = -1;
  let virtualMsAtEnd = -1;
  const result = await emailSyncService.precacheEmails(
    USER,
    (p) => {
      events.push(p);
      if (p.phase === "done") {
        stagedAtEnd = countStagedEmails();
        virtualMsAtEnd = virtualMs;
      }
    },
    { force: true },
  );
  return { stagedAtEnd, virtualMsAtEnd, result, events };
}

describe("BACKLOG-2856 — a cancelled re-cache stops fetching", () => {
  /**
   * THE BASELINE. Everything below is measured against it, so it is asserted
   * rather than assumed: an uncancelled run stages the whole mailbox.
   */
  it("stages the whole mailbox when nobody cancels", async () => {
    const { stagedAtEnd, virtualMsAtEnd, result } = await runForce();

    expect(stagedAtEnd).toBe(FULL_MAILBOX);
    expect(result.cancelled).toBeUndefined();
    expect(virtualMsAtEnd).toBe(FOLDER_COUNT * MS_PER_FOLDER);
  });

  /**
   * THE CONTROL THIS WHOLE TASK TURNS ON.
   *
   * A cancel during the folder walk must leave FEWER rows in staging than a
   * completed run puts there. On the build the founder ran, this number was the
   * whole mailbox — the fetch had already finished before anything looked at the
   * signal.
   *
   * MUTATION 1: delete `signal: abort.signal` from the `searchAllFolders` call
   * in `precacheEmails` -> RED (stagedAtEnd is 20, the full mailbox).
   */
  it("stages fewer rows when cancelled mid-fetch than when it runs to the end", async () => {
    onFolderFetched = (folder) => {
      // The user clicks Cancel as the second folder lands.
      if (folder === 1) emailSyncService.requestPrecacheCancellation();
    };

    const { stagedAtEnd, result } = await runForce();

    expect(result.cancelled).toBe(true);
    // Upper bound — the defect. Lower bound — the fixture's own control: a zero
    // would mean nothing was ever fetched, which a broken abort could also
    // produce, and would make this assertion pass for the wrong reason.
    expect(stagedAtEnd).toBeGreaterThan(0);
    expect(stagedAtEnd).toBeLessThan(FULL_MAILBOX);
    // Stated exactly rather than as an inequality, so a regression that merely
    // shaves one folder cannot hide inside a range: two folders were walked.
    expect(stagedAtEnd).toBe(2 * PER_FOLDER);
    expect(result.stored).toBe(2 * PER_FOLDER);
  });

  /**
   * RESPONSIVENESS, on a controllable clock.
   *
   * Measured in the fixture's own virtual cost — 1000ms per folder — never
   * against wall-clock, which is how this kind of test goes flaky. The founder
   * paid the FULL cost of the download after clicking Cancel; the bound here is
   * that a cancel costs at most one more unit of work after it is requested.
   *
   * MUTATION 1 -> RED (5000, the whole walk, versus 2000).
   */
  it("stops within one folder of the cancel, not at the end of the walk", async () => {
    onFolderFetched = (folder) => {
      if (folder === 1) emailSyncService.requestPrecacheCancellation();
    };

    const { virtualMsAtEnd } = await runForce();

    // Cancel requested as folder index 1 completed (2000ms spent). Nothing more
    // was fetched, so the run ends there.
    expect(virtualMsAtEnd).toBe(2 * MS_PER_FOLDER);
    expect(virtualMsAtEnd).toBeLessThan(FOLDER_COUNT * MS_PER_FOLDER);
  });

  /**
   * The signal is handed to the fetch layer at all — asserted on the mock's
   * arguments, so a regression that keeps the boundary checks but stops
   * threading the signal is caught here rather than only by the row count.
   */
  it("hands its abort signal to both Outlook rounds", async () => {
    await runForce();

    expect(mockOutlookSearch).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockOutlookSearchAll).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("BACKLOG-2856 — the guarantee that already held still holds", () => {
  /**
   * The part of this feature that was RIGHT, pinned so the responsiveness work
   * cannot erode it: "cancelled before the swap — the email store was never
   * touched". Asserted by row-id SET, not by count — a count cannot separate
   * "untouched" from "deleted and coincidentally refilled".
   *
   * MUTATION 2: delete the pre-swap `isCancelled()` checkpoint -> RED (the swap
   * runs, the seeded ids are gone and re-staged ids take their place).
   */
  it("leaves the live row-id set identical when cancelled mid-fetch", async () => {
    seedEmail("live-1", "ext-900");
    seedEmail("live-2", "ext-901");
    const before = liveRowIds();

    onFolderFetched = (folder) => {
      if (folder === 1) emailSyncService.requestPrecacheCancellation();
    };
    const { result } = await runForce();

    expect(result.cancelled).toBe(true);
    expect(result.error).toBeUndefined(); // a cancel is not a failure
    expect(liveRowIds()).toEqual(before);
    // And nothing was left behind: staging is dropped on every exit path.
    expect(stagingTables()).toEqual([]);
  });

  /**
   * A cancel that arrives once the swap has begun is too late to mean anything,
   * and the run reports the success it actually achieved. Fired from the
   * `swapping` progress event, which is emitted immediately before the swap.
   *
   * Regression cover for the existing boundary: the new threading must not make
   * a post-swap cancel start reporting `cancelled` over a rebuilt mailbox.
   */
  it("still ignores a cancel that lands after the swap has begun", async () => {
    seedEmail("live-1", "ext-900");

    const events: EmailPrecacheProgress[] = [];
    const result = await emailSyncService.precacheEmails(
      USER,
      (p) => {
        events.push(p);
        if (p.phase === "swapping") emailSyncService.requestPrecacheCancellation();
      },
      { force: true },
    );

    expect(result.cancelled).toBeUndefined();
    expect(result.forceSwap?.emailsInserted).toBe(FULL_MAILBOX);
    expect(events[events.length - 1].outcome).toBe("success");
  });
});
