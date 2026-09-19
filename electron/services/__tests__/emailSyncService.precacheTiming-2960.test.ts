/**
 * @jest-environment node
 *
 * BACKLOG-2960 — the pre-cache run emits exactly one wall-clock timing line,
 * on every exit path, spanning the WHOLE run.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE EXISTS
 * ---------------------------------------------------------------------------
 * BACKLOG-2960 converts the data layer's exported functions to promise-returning
 * ones. The founder's acceptance bound is "≤3% wall-clock on a full re-cache of
 * 33,637 emails". Before this instrument there was no duration on the pre-cache
 * path at all, so the bound had nothing to be measured against — the "before"
 * number did not exist. This PR ships the instrument ALONE, against unconverted
 * code, so that the before and after are produced by the same line.
 *
 * That makes the properties below load-bearing in an unusual way: they are not
 * protecting a feature, they are protecting a MEASUREMENT. A timer that starts
 * inside the provider loop does not fail visibly — it silently reports a smaller
 * number on both sides of the comparison, and a 3% regression in the repair pass
 * or the swap becomes invisible. Every control here exists because the
 * corresponding mistake is silent.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REAL DRIVER AND THE REAL SCHEMA
 * ---------------------------------------------------------------------------
 * Same harness as `emailSyncService.precacheProgress-2856.test.ts`, deliberately:
 * these claims are about a run that actually reaches the staging swap and the
 * bounds read, and a fully-mocked `dbGet`/`dbRun` cannot produce either. The
 * `mode` control in particular depends on `getCachedEmailSentAtBounds` seeing
 * real rows — a mocked bounds read would let `mode=re-cache` pass for a mailbox
 * that was empty.
 *
 * Only the network is mocked.
 *
 * ---------------------------------------------------------------------------
 * FIXTURE PROVENANCE
 * ---------------------------------------------------------------------------
 * `providerEmail()` and the seed helpers are transcribed from the 2856 progress
 * suite in this same directory, which captured them from the real mappers. No
 * shape is invented here; this suite adds no new fixture kind, only delays.
 *
 * ---------------------------------------------------------------------------
 * CONTROLS, AND THE MUTATION THAT MAKES EACH RED
 * ---------------------------------------------------------------------------
 *   1. exactly one line       -> emit the line twice (e.g. also on the success
 *                                return): RED — the count assertion is on the
 *                                tag, not on "a line exists"
 *   2. force is labelled force-> initialise `precacheMode` to "re-cache" instead
 *                                of `isForce ? "force" : "cache"`: RED
 *   3. empty vs seeded cache  -> drop the `cachedBounds?.newest` branch: RED
 *   4. the timer wraps the RUN-> move `runStartedAt` inside either provider
 *                                block: RED (two providers, 60 ms each, the
 *                                assertion needs both)
 *   5. cancel still reports   -> emit the line only on the success path: RED
 *   6. counts match the result-> report `forceSwap.emailsInserted` as `checked`:
 *                                RED
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

jest.mock("../../utils/preferenceHelper", () => ({
  getEmailCacheDurationMonths: jest.fn().mockResolvedValue(12),
  computeEmailCacheSinceDate: jest.fn(() => new Date("2026-01-01T00:00:00Z")),
}));

const mockReprocess = jest.fn();
jest.mock("../emailDerivationReprocessService", () => ({
  reprocessEmailDerivations: (...a: unknown[]) => mockReprocess(...a),
}));

/**
 * Sentry is mocked down to the two methods this service uses — the SAME shape
 * the sibling suites use, and deliberately WITHOUT `getClient`.
 *
 * That is a control in itself: `resolvePrecacheBuild()` reads the release off
 * the Sentry client, and this mock is exactly the condition where that read
 * blows up. If the guard around it were removed, every test in this file would
 * fail rather than the build silently reading "unknown".
 */
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));

const mockLogInfo = jest.fn();
jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: (...a: unknown[]) => mockLogInfo(...a),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import emailSyncService from "../emailSyncService";
import { EMAIL_PRECACHE_TIMING_TAG } from "../emailPrecacheTiming";
import { instrumentDatabaseTiming } from "../db/core/dbTiming";

const SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-timing";

const OUTLOOK_TOKEN = {
  id: "acct-outlook",
  access_token: "at",
  connected_email_address: "me@example.com",
};
const GMAIL_TOKEN = {
  id: "acct-gmail",
  access_token: "at",
  connected_email_address: "me@example.net",
};

/** Transcribed from the 2856 progress suite's capture of the real mappers. */
function providerEmail(n: number, opts: { sentAt?: string } = {}) {
  return {
    id: `ext-${n}`,
    subject: `Subject ${n}`,
    from: `sender${n}@example.com`,
    to: "me@example.com",
    cc: null,
    bcc: null,
    body: `<html><body><p>Paragraph one of message ${n}.</p></body></html>`,
    bodyPlain: `Paragraph one of message ${n}.`,
    date: new Date(opts.sentAt ?? `2026-03-0${(n % 9) + 1}T10:00:00Z`),
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
  db.prepare(
    `INSERT INTO oauth_tokens (id, user_id, provider, purpose, connected_email_address)
     VALUES ('acct-gmail', ?, 'google', 'mailbox', 'me@example.net')`,
  ).run(USER);
}

/** Insert a row directly, standing in for "already cached before this run". */
function seedEmail(id: string, externalId: string, sentAt: string): void {
  db.prepare(
    `INSERT INTO emails
       (id, user_id, external_id, source, account_id, subject, body_plain, body_html,
        sender, recipients, sent_at, received_at, message_id_header, derived_version)
     VALUES (?, ?, ?, 'outlook', 'acct-outlook', ?, 'seeded', '<html></html>',
             'someone@example.com', 'me@example.com', ?, ?, ?, 0)`,
  ).run(id, USER, externalId, `Seeded ${id}`, sentAt, sentAt, `<seed-${id}@example.com>`);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Milliseconds the next `db.prepare` should block for. Set by a test, consumed
 * once. Blocking rather than awaiting because a database call is synchronous —
 * an `await` would move the delay out of the region being measured, which is the
 * distinction these controls exist to test.
 */
let plantedDbDelayMs = 0;

function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* spin */
  }
}

/**
 * Every `logService.info` line carrying the timing tag.
 *
 * Collected by TAG, not by call index, because the run emits a dozen info lines
 * and pinning an index would make this suite fail for any unrelated log added
 * later — the kind of brittleness that gets a control deleted rather than fixed.
 */
function timingLines(): string[] {
  return mockLogInfo.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.startsWith(EMAIL_PRECACHE_TIMING_TAG));
}

/** The single timing line, asserting there is exactly one before returning it. */
function theTimingLine(): string {
  const lines = timingLines();
  expect(lines).toHaveLength(1);
  return lines[0];
}

/** Read one `key=value` field out of the rendered line. */
function field(line: string, key: string): string {
  const match = line.match(new RegExp(`(?:^| )${key}=([^\\s]+)`));
  if (!match) throw new Error(`no ${key}= in: ${line}`);
  return match[1];
}

/**
 * The suite's default network + reprocess behaviour, named so a test that needs
 * a SECOND pre-cache run can restore it after `jest.clearAllMocks()`. Extracted
 * verbatim from `beforeEach`; changing one changes both.
 */
function restoreProviderMocks(): void {
  mockGetOAuthToken.mockImplementation(async (_u: string, provider: string) =>
    provider === "microsoft" ? OUTLOOK_TOKEN : null,
  );
  mockOutlookInit.mockResolvedValue(true);
  mockOutlookSearch.mockResolvedValue([]);
  mockOutlookSearchAll.mockResolvedValue([]);
  mockGmailInit.mockResolvedValue(false);
  mockGmailSearch.mockResolvedValue([]);
  mockGmailSearchAll.mockResolvedValue([]);
  mockReprocess.mockResolvedValue({
    scanned: 0,
    rewritten: 0,
    unchanged: 0,
    batches: 0,
    cancelled: false,
    skippedNeedsRefetch: false,
  });
}

/**
 * Build a fresh in-memory database, instrumented exactly the way production
 * instruments the live handle. Called from `beforeEach`, and again by the
 * database-time controls, which need two runs from an IDENTICAL starting state
 * for their comparison to mean anything.
 */
function freshDatabase(): void {
  db = new Database(":memory:") as unknown as DatabaseType;

  // BACKLOG-2960 — this stands in for `setDb()`, which is where production
  // installs database-time accounting. The topology is the same one the app
  // has: ONE handle, instrumented once, reached both through the conduits (the
  // `dbConnection` mock above calls `db.prepare` on it) and through
  // `getRawDatabase()`. Without this the suite would exercise an uninstrumented
  // handle and every `dbMs` would be 0 — green, and proving nothing.
  //
  // The delay plant is installed UNDERNEATH the instrument on purpose: a
  // busy-wait here is inside the measured region, which is what lets a test
  // plant database time without a contrived SQL function.
  plantedDbDelayMs = 0;
  const rawPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    if (plantedDbDelayMs > 0) {
      const ms = plantedDbDelayMs;
      plantedDbDelayMs = 0; // one-shot: a fixed total, not a per-call tax
      busyWait(ms);
    }
    return rawPrepare(sql);
  }) as unknown as DatabaseType["prepare"];
  instrumentDatabaseTiming(db);

  loadSchema(db);
  seedParents();
}

beforeEach(() => {
  jest.clearAllMocks();
  freshDatabase();
  restoreProviderMocks();
});

afterEach(() => {
  db.close();
});

describe("BACKLOG-2960 — one timing line per run", () => {
  /**
   * CONTROL 1 — exactly one, not "at least one".
   *
   * A duration that appears twice with different numbers is worse than no
   * duration: the reader has to guess which one the 3% bound applies to. The
   * emission lives in the `finally` precisely so no future exit path can add a
   * second one, and this is the assertion that holds that.
   *
   * MUTATION: add a second emission on the success return -> RED.
   */
  it("emits exactly one timing line on an ordinary run", async () => {
    await emailSyncService.precacheEmails(USER, undefined, { force: false });
    expect(timingLines()).toHaveLength(1);
  });

  /**
   * CONTROL 5 — every exit path, not just the happy one.
   *
   * A run the user cancelled still consumed wall-clock, and a run that ends in a
   * provider error still did. Reporting only successes would mean the log is
   * silent exactly when someone is trying to work out why a re-cache felt slow.
   *
   * The `outcome` field is what keeps those out of the baseline: the comparison
   * uses `outcome=success` lines only, which is stated in the PR body.
   *
   * MUTATION: move the emission out of the `finally` onto the success path -> RED.
   */
  it("emits a line, marked cancelled, when the user stops the run", async () => {
    mockOutlookInit.mockImplementation(async () => {
      emailSyncService.requestPrecacheCancellation();
      return true;
    });

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: false });

    expect(result.cancelled).toBe(true);
    expect(field(theTimingLine(), "outcome")).toBe("cancelled");
  });

  /**
   * The "already in progress" guard returns BEFORE the `try`, so it emits
   * nothing — asserted, because the alternative (an `elapsedMs` near zero
   * landing in the log for a run that never happened) would pollute the average
   * the founder is about to compute.
   */
  it("emits nothing for an invocation the in-progress guard rejected", async () => {
    let releaseFirstRun: () => void = () => {};
    mockOutlookInit.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseFirstRun = resolve;
      });
      return true;
    });

    const first = emailSyncService.precacheEmails(USER, undefined, { force: false });
    // Let the first run reach the provider block and park there.
    await sleep(20);

    const rejected = await emailSyncService.precacheEmails(USER, undefined, { force: false });
    expect(rejected.error).toBe("Precache already in progress");
    expect(timingLines()).toHaveLength(0);

    releaseFirstRun();
    await first;
    // The run that WAS a run reports; the rejected invocation still does not.
    expect(timingLines()).toHaveLength(1);
  });
});

describe("BACKLOG-2960 — the mode label", () => {
  /**
   * CONTROL 2 — a force run says so.
   *
   * This is the mode the 3% bound is stated against. A force run mislabelled as
   * an incremental one would put a 13-minute number in the same bucket as the
   * two-second runs that follow it, and the average would be meaningless.
   *
   * MUTATION: initialise `precacheMode` to "re-cache" -> RED.
   */
  it("labels a force re-cache `force`", async () => {
    seedEmail("live-1", "ext-1", "2026-03-01T10:00:00Z");
    mockOutlookSearch.mockResolvedValue([providerEmail(1)]);

    await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(field(theTimingLine(), "mode")).toBe("force");
  });

  /**
   * CONTROL 3a — an ordinary run over a mailbox that already held mail.
   *
   * Decided by the same bounds read the existing "date range computed" line
   * reports as `isIncremental`, against REAL rows — which is why this suite
   * carries the real driver.
   */
  it("labels an incremental run over a populated cache `re-cache`", async () => {
    seedEmail("live-1", "ext-1", "2026-03-01T10:00:00Z");

    await emailSyncService.precacheEmails(USER, undefined, { force: false });

    expect(field(theTimingLine(), "mode")).toBe("re-cache");
  });

  /**
   * CONTROL 3b — the mirror. An empty cache is a first fill, not a re-cache.
   *
   * MUTATION: drop the `cachedBounds?.newest` branch (always "cache") -> 3a red.
   *           Hard-code "re-cache" -> this one red. Both directions covered.
   */
  it("labels a first fill over an empty cache `cache`", async () => {
    await emailSyncService.precacheEmails(USER, undefined, { force: false });

    expect(field(theTimingLine(), "mode")).toBe("cache");
  });
});

describe("BACKLOG-2960 — the timer spans the whole run", () => {
  /**
   * CONTROL 4 — THE control this instrument exists for.
   *
   * `precacheEmails` on the founder's mailbox spends time in the repair pass, in
   * the staging build, in TWO providers' fetch rounds and in the swap. A timer
   * around any single one of those still produces a plausible-looking number,
   * and the mistake is invisible in the log.
   *
   * So: two connected providers, each parked for 60 ms inside its own
   * `initialize`. The whole run must report at least the SUM. A per-provider
   * timer reports ~60, a per-batch timer reports ~0, and both fail here.
   *
   * The bound is `>=` a sum of real sleeps rather than an equality or an upper
   * bound, because a CI box can be arbitrarily slow — an upper bound would make
   * this suite flaky, which is how controls get deleted.
   *
   * MUTATION: move `const runStartedAt = Date.now()` inside either provider
   * block -> RED.
   */
  it("reports at least the sum of two sequential provider rounds", async () => {
    const PROVIDER_DELAY_MS = 60;

    mockGetOAuthToken.mockImplementation(async (_u: string, provider: string) =>
      provider === "microsoft" ? OUTLOOK_TOKEN : GMAIL_TOKEN,
    );
    mockOutlookInit.mockImplementation(async () => {
      await sleep(PROVIDER_DELAY_MS);
      return true;
    });
    mockGmailInit.mockImplementation(async () => {
      await sleep(PROVIDER_DELAY_MS);
      return true;
    });

    await emailSyncService.precacheEmails(USER, undefined, { force: false });

    // Both providers actually ran — without this the assertion below could pass
    // on a single 120 ms round, proving nothing about the span.
    expect(mockOutlookInit).toHaveBeenCalledTimes(1);
    expect(mockGmailInit).toHaveBeenCalledTimes(1);

    expect(Number(field(theTimingLine(), "elapsedMs"))).toBeGreaterThanOrEqual(
      PROVIDER_DELAY_MS * 2,
    );
  });

  /**
   * The repair pass runs BEFORE any provider is touched and is minutes of the
   * founder's ordinary re-cache. A timer started at the first fetch would miss
   * it entirely — and the repair pass is one of the places the async conversion
   * could regress, since it is a read-write loop over the whole corpus.
   *
   * MUTATION: start the timer after the repair block -> RED.
   */
  it("includes the pre-fetch repair pass in the span", async () => {
    const REPAIR_DELAY_MS = 80;
    mockReprocess.mockImplementation(async () => {
      await sleep(REPAIR_DELAY_MS);
      return {
        scanned: 0,
        rewritten: 0,
        unchanged: 0,
        batches: 0,
        cancelled: false,
        skippedNeedsRefetch: false,
      };
    });

    await emailSyncService.precacheEmails(USER, undefined, { force: false });

    expect(mockReprocess).toHaveBeenCalledTimes(1);
    expect(Number(field(theTimingLine(), "elapsedMs"))).toBeGreaterThanOrEqual(REPAIR_DELAY_MS);
  });
});

describe("BACKLOG-2960 — the counts on the line are the run's own", () => {
  /**
   * CONTROL 6 — `checked` and `written` are the numbers the caller is handed and
   * the Settings panel prints ("Cached N new emails (M checked)"), so a reader
   * can reconcile the timing line against what the user was told.
   *
   * MUTATION: report `forceSwap.emailsInserted` as `checked` -> RED on the force
   * case below, where the two differ.
   */
  it("matches the returned fetched/stored counts on an ordinary run", async () => {
    mockOutlookSearch.mockResolvedValue([providerEmail(1), providerEmail(2)]);

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: false });
    const line = theTimingLine();

    expect(Number(field(line, "checked"))).toBe(result.fetched);
    expect(Number(field(line, "written"))).toBe(result.stored);
    expect(result.fetched).toBeGreaterThan(0);
  });

  /**
   * A force run additionally reports what LANDED after the swap, which is the
   * number the user sees ("Re-cached N emails") and is not the same as `written`
   * — `written` counts rows staged, `inserted` counts rows that survived into
   * live. The 3% bound is about duration, but a duration line that cannot be
   * matched to the run the user remembers is hard to trust.
   */
  it("reports what the swap inserted on a force run", async () => {
    seedEmail("live-1", "ext-1", "2026-03-01T10:00:00Z");
    mockOutlookSearch.mockResolvedValue([providerEmail(1)]);

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });
    const line = theTimingLine();

    expect(result.forceSwap).toBeDefined();
    expect(Number(field(line, "inserted"))).toBe(result.forceSwap?.emailsInserted);
  });

  /** An ordinary run never swapped, so the field must be absent, not zero. */
  it("omits `inserted` on an ordinary run", async () => {
    await emailSyncService.precacheEmails(USER, undefined, { force: false });
    expect(theTimingLine()).not.toContain("inserted=");
  });

  /**
   * The connected mailboxes, so two runs of different durations can be compared
   * only when they did comparable work. One provider connected is a different
   * run from two.
   */
  it("names the connected providers", async () => {
    mockGetOAuthToken.mockImplementation(async (_u: string, provider: string) =>
      provider === "microsoft" ? OUTLOOK_TOKEN : GMAIL_TOKEN,
    );
    mockGmailInit.mockResolvedValue(true);

    await emailSyncService.precacheEmails(USER, undefined, { force: false });

    expect(field(theTimingLine(), "providers")).toBe("outlook+gmail");
  });

  /**
   * The providers reported are the ones the run WORKED, not the ones that
   * FINISHED — asserted at the boundary where those two sets differ.
   *
   * A force run whose Outlook all-folders round fails keeps Outlook out of
   * `rebuiltProviders` (a partial fetch must not license deleting Outlook's live
   * rows — BACKLOG-2856), while Gmail completes. The run still spent its Outlook
   * time. Reporting the narrowed set would make a slow half-failed run look like
   * a fast single-provider one, which is exactly the confusion that would make a
   * 3% comparison wrong.
   *
   * MUTATION: report `rebuiltProviders` instead of the connected set -> RED.
   */
  it("names every provider the run worked, not only those that finished", async () => {
    seedEmail("live-1", "ext-1", "2026-03-01T10:00:00Z");
    mockGetOAuthToken.mockImplementation(async (_u: string, provider: string) =>
      provider === "microsoft" ? OUTLOOK_TOKEN : GMAIL_TOKEN,
    );
    mockGmailInit.mockResolvedValue(true);
    // Not a network error, so the run continues instead of aborting — this is
    // the "continuing" branch in the service, and it withholds the rebuilt mark.
    mockOutlookSearchAll.mockRejectedValue(new Error("folder enumeration failed"));

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

    // The premise: the two sets really do differ on this run. Without this the
    // assertion below could pass for the wrong reason.
    expect(result.forceSwap?.providers).toEqual(["gmail"]);
    expect(field(theTimingLine(), "providers")).toBe("outlook+gmail");
  });

  /**
   * With Sentry mocked down to two methods (see the mock's own note) the build
   * cannot be read, and the line must say "unknown" rather than omit the field
   * or throw. This is the guard in `resolvePrecacheBuild` under test.
   */
  it("reports build=unknown rather than throwing when the release is unreadable", async () => {
    const previous = process.env.npm_package_version;
    delete process.env.npm_package_version;
    try {
      await emailSyncService.precacheEmails(USER, undefined, { force: false });
      expect(field(theTimingLine(), "build")).toBe("unknown");
    } finally {
      if (previous !== undefined) process.env.npm_package_version = previous;
    }
  });
});

describe("BACKLOG-2960 — database time is reported separately from total elapsed", () => {
  /**
   * -------------------------------------------------------------------------
   * WHY THESE CONTROLS, AND WHY DIFFERENTIAL
   * -------------------------------------------------------------------------
   * `elapsedMs` cannot carry the conversion's acceptance bound. Four force
   * re-caches of unchanged code on the founder's machine ran 56,553 / 43,363 /
   * 39,326 / 42,478 ms — 40% spread, 9.5% excluding the first-after-launch
   * (pm_comments `ac7a6f40`). The run is dominated by fetching mail over the
   * network; the promise-conversion changes the data layer. `dbMs` exists so the
   * bound applies to the half that actually moves when the conversion regresses.
   *
   * "It reports a number" is worth nothing here — 0 is a number, and so is a
   * relabelled `elapsedMs`. Each control below plants a delay in a KNOWN place
   * and asserts which figure moves. Tolerances are pre-registered: the planted
   * delay is 250 ms, "rose" means >= 200, "did not rise" means < 60.
   */
  const PLANTED_MS = 250;
  const ROSE = 200;
  const DID_NOT_RISE = 60;

  /**
   * A batch big enough that the run's database work exceeds the line's
   * millisecond resolution. With an empty mailbox the whole run costs well under
   * 0.5 ms of SQL and rounds to `dbMs=0` — honest, but it cannot carry a
   * differential control.
   */
  const BATCH = Array.from({ length: 60 }, (_, i) => providerEmail(i + 1));

  /**
   * Rebuild the database, reset the mocks, run one pre-cache, read its one line.
   *
   * The full reset is the point: these are two-run comparisons, and a second run
   * against a mailbox the first run just filled does completely different
   * database work (lookups instead of inserts). Only an identical starting state
   * makes the delta attributable to the planted delay.
   */
  async function runAndRead(
    configure: () => void = () => {},
  ): Promise<{ elapsedMs: number; dbMs: number }> {
    jest.clearAllMocks();
    freshDatabase();
    restoreProviderMocks();
    mockOutlookSearch.mockResolvedValue(BATCH);
    configure();

    await emailSyncService.precacheEmails(USER, undefined, { force: false });
    const line = theTimingLine();
    return {
      elapsedMs: Number(field(line, "elapsedMs")),
      dbMs: Number(field(line, "dbMs")),
    };
  }

  /**
   * CONTROL (a) — the figure is real, and it is strictly smaller than the total.
   *
   * The run is given a network leg (30 ms parked in the provider's `initialize`)
   * because without one the inequality is not meaningful HERE: against an
   * in-memory database with mocked providers, essentially all of the elapsed
   * time IS database time, and both figures round to the same millisecond. A
   * real re-cache is the opposite shape — tens of seconds of network around a
   * much smaller core of SQL — so the control reproduces that shape rather than
   * asserting a strict inequality the harness cannot honestly produce.
   *
   * The third assertion is what stops this being satisfied by rounding: the
   * network leg must be MISSING from `dbMs`, not merely smaller than the total.
   */
  const NETWORK_LEG_MS = 30;

  it("reports a non-zero database time strictly below the total elapsed", async () => {
    const { elapsedMs, dbMs } = await runAndRead(() => {
      mockOutlookInit.mockImplementation(async () => {
        await sleep(NETWORK_LEG_MS);
        return true;
      });
    });

    expect(dbMs).toBeGreaterThan(0);
    expect(dbMs).toBeLessThan(elapsedMs);
    expect(elapsedMs - dbMs).toBeGreaterThanOrEqual(NETWORK_LEG_MS - 5);
  });

  /**
   * CONTROL (b) — a delay INSIDE the data layer moves BOTH figures, together.
   *
   * The plant sits under the instrument in `beforeEach`, so this is database
   * time by construction. A blocking wait also stalls the event loop, so the
   * wall clock must absorb the same 250 ms: the two rises match.
   */
  it("raises database time, and the total with it, when the delay is inside the data layer", async () => {
    const baseline = await runAndRead();
    const delayed = await runAndRead(() => {
      plantedDbDelayMs = PLANTED_MS;
    });

    expect(plantedDbDelayMs).toBe(0); // the plant actually fired

    const dbRise = delayed.dbMs - baseline.dbMs;
    const elapsedRise = delayed.elapsedMs - baseline.elapsedMs;

    expect(dbRise).toBeGreaterThanOrEqual(ROSE);
    expect(elapsedRise).toBeGreaterThanOrEqual(ROSE);
    // And by the SAME amount — a blocking wait inside the database stalls the
    // event loop too, so the whole delay lands in both figures. Asserting only
    // that each rose would also pass an instrument that charged some unrelated
    // extra work to `dbMs`.
    expect(Math.abs(elapsedRise - dbRise)).toBeLessThan(DID_NOT_RISE);
  });

  /**
   * CONTROL (c) — THE ONE THAT MATTERS MOST.
   *
   * A delay OUTSIDE the data layer — parked in the provider's `initialize`,
   * which is the network leg — must move the total and leave database time
   * alone. This is the whole premise: `dbMs` is worth adding only if it does not
   * inherit the variance that made `elapsedMs` unusable as a bound.
   *
   * An instrument that charged the whole span, or the gaps between calls, passes
   * (a) and (b) and fails here.
   */
  it("leaves database time flat when the delay is outside the data layer", async () => {
    const baseline = await runAndRead();
    const delayed = await runAndRead(() => {
      mockOutlookInit.mockImplementation(async () => {
        await sleep(PLANTED_MS);
        return true;
      });
    });

    expect(mockOutlookInit).toHaveBeenCalledTimes(1); // the delay actually ran
    expect(delayed.elapsedMs - baseline.elapsedMs).toBeGreaterThanOrEqual(ROSE);
    expect(delayed.dbMs - baseline.dbMs).toBeLessThan(DID_NOT_RISE);
  });
});
