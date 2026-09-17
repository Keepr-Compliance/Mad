/**
 * @jest-environment node
 *
 * BACKLOG-2856 — progress reporting and cancellation for the email re-cache,
 * against the REAL schema and the REAL sqlite driver, with only the network
 * mocked.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ASSERT SEQUENCES, NOT "SOME EVENTS FIRED"
 * ---------------------------------------------------------------------------
 * A progress bar is a claim about ORDER and MONOTONICITY. "At least one event
 * arrived" cannot separate a working bar from one that reports the repair pass
 * after the fetch it was supposed to precede, or one that jumps backwards. So
 * every control here pins the collapsed phase sequence and the percent series,
 * not a count.
 *
 * ---------------------------------------------------------------------------
 * THE TWO PATHS HAVE DIFFERENT SEQUENCES, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * The defect report asked for the repair pass to be reported as the force run's
 * first phase. It is not one: `precacheEmails` SKIPS the repair pass on force
 * (every row it would repair is inside the force set and about to be deleted and
 * re-fetched, and it writes live, which the force design avoids until the swap).
 * Asserting a repairing phase on a force run would have been a fixture
 * describing a state the code cannot emit. So the honest pair is asserted
 * instead:
 *
 *   ordinary:  repairing -> fetching -> done
 *   force:                  fetching -> swapping -> done
 *
 * and the force path gets the mirror control: NO repairing event, ever.
 *
 * ---------------------------------------------------------------------------
 * WHAT CANCELLATION IS ALLOWED TO MEAN
 * ---------------------------------------------------------------------------
 * Stop doing more work — never undo work already done. A force run writes to
 * staging and the `finally` drops staging on every exit, so "live is unchanged"
 * is true BY CONSTRUCTION rather than by rollback. The controls assert that with
 * a row-id SET comparison, because a count can stay equal across a delete and a
 * re-insert of different rows.
 *
 * The boundary that matters most is the last one: a cancel arriving once the
 * swap has begun must be ignored, and the run must report the success it
 * actually achieved. A naive implementation that re-checks the signal after the
 * swap reports `cancelled` over a mailbox it just rebuilt.
 */

import * as nodePath from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;

// The real driver, behind the module every query in emailSyncService goes
// through. Declared before the import of the service under test (jest.mock is
// hoisted), and resolved lazily so each test can swap in a fresh database.
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

// Routed through a mock the tests can reconfigure, because one control below
// needs the real thing's defining behaviour: `retryOnNetwork` re-runs the WHOLE
// provider block on a network error, which restarts that round's own progress
// counter at zero. Straight passthrough stays the default.
const mockRetryOnNetwork = jest.fn(
  async (operation: () => Promise<unknown>) => operation(),
);
jest.mock("../networkResilience", () => ({
  retryOnNetwork: (fn: () => Promise<unknown>) => mockRetryOnNetwork(fn),
  networkResilienceService: {},
}));

jest.mock("../../utils/preferenceHelper", () => ({
  getEmailCacheDurationMonths: jest.fn().mockResolvedValue(12),
  computeEmailCacheSinceDate: jest.fn(() => new Date("2026-01-01T00:00:00Z")),
}));

// The 2857 reprocess pass. Spied rather than stubbed away entirely, because one
// of the controls is that a FORCE run does not call it.
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
import { EMAIL_STAGING_TABLE_PREFIX } from "../emailForceStaging";

const SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-force";
const OTHER_USER = "user-bystander";

const OUTLOOK_TOKEN = {
  id: "acct-outlook",
  access_token: "at",
  connected_email_address: "me@example.com",
};

/**
 * A provider row in the shape the real mappers emit.
 *
 * `bodyPlain` is deliberately the FULL text rather than a truncated stand-in:
 * control 5 asserts that a re-cached row carries a complete `body_plain`, which
 * is the property that makes a force re-cache a fix for BACKLOG-2855's stored
 * data. A fixture that already carried a truncated body would make that
 * assertion pass for the wrong reason.
 */
function providerEmail(n: number, opts: { sentAt?: string } = {}) {
  return {
    id: `ext-${n}`,
    subject: `Subject ${n}`,
    from: `sender${n}@example.com`,
    to: "me@example.com",
    cc: null,
    bcc: null,
    body: `<html><body><p>Paragraph one of message ${n}.</p><p>Paragraph two.</p></body></html>`,
    bodyPlain: `Paragraph one of message ${n}.\n\nParagraph two.`,
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

/**
 * `count` provider rows numbered from `first`.
 *
 * For fixtures whose mock REPORTS progress. A real `searchEmails` that reported
 * 500 downloaded returns those 500, and `fetchStoreAndDedup` counts what it
 * returns. A mock that reports 500 and returns `[]` describes a run the code
 * cannot produce, and the count assertions built on it then expect a drop to 0
 * that no real run shows.
 */
function providerEmails(first: number, count: number) {
  return Array.from({ length: count }, (_, i) => providerEmail(first + i));
}

function loadSchema(database: DatabaseType): void {
  database.pragma("foreign_keys = OFF");
  database.exec(fs.readFileSync(SCHEMA, "utf8"));
  database.pragma("foreign_keys = ON");
}

/**
 * The parent rows `emails` actually requires, seeded for real rather than worked
 * around by leaving `foreign_keys = OFF`.
 *
 * Leaving them off would have been the quicker fixture and it would have made
 * this whole suite worthless for its main claim: the swap's DELETE is what
 * cascade-removes `communications`, and a cascade does not fire with foreign
 * keys disabled. The constraint being ON is the thing under test.
 */
function seedParents(): void {
  const user = db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'microsoft', ?)`,
  );
  user.run(USER, "me@example.com", "oid-1");
  user.run(OTHER_USER, "bystander@example.com", "oid-2");
  const token = db.prepare(
    `INSERT INTO oauth_tokens (id, user_id, provider, purpose, connected_email_address)
     VALUES (?, ?, 'microsoft', 'mailbox', ?)`,
  );
  token.run("acct-outlook", USER, "me@example.com");
  token.run("acct-bystander", OTHER_USER, "bystander@example.com");
  db.prepare(
    `INSERT INTO oauth_tokens (id, user_id, provider, purpose, connected_email_address)
     VALUES ('acct-gmail', ?, 'google', 'mailbox', 'me@example.net')`,
  ).run(USER);
}

/** Insert a row directly, standing in for "already cached before this run". */
function seedEmail(args: {
  id: string;
  userId?: string;
  externalId: string | null;
  source: string | null;
  sentAt: string | null;
  bodyPlain?: string;
  derivedVersion?: number;
  messageIdHeader?: string | null;
  accountId?: string;
}): void {
  const userId = args.userId ?? USER;
  db.prepare(
    `INSERT INTO emails
       (id, user_id, external_id, source, account_id, subject, body_plain, body_html,
        sender, recipients, sent_at, received_at, message_id_header, derived_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'me@example.com', ?, ?, ?, ?)`,
  ).run(
    args.id,
    userId,
    args.externalId,
    args.source,
    // The bystander holds their OWN mailbox account. Sharing `acct-outlook`
    // across two users would trip `idx_emails_account_external` (UNIQUE on
    // account_id, external_id) and is not a state the app can produce — an
    // oauth_tokens row belongs to exactly one user. Within this user, the
    // account follows the provider, because that is what the insert path binds
    // (`oauthToken.id` resolved per provider) and the UNIQUE index is per
    // account.
    args.accountId ??
      (userId !== USER ? "acct-bystander" : args.source === "gmail" ? "acct-gmail" : "acct-outlook"),
    `Seeded ${args.id}`,
    args.bodyPlain ?? "truncated…",
    "<html><body>seeded</body></html>",
    "someone@example.com",
    args.sentAt,
    args.sentAt,
    args.messageIdHeader ?? `<seed-${args.id}@example.com>`,
    args.derivedVersion ?? 0,
  );
}



const externalIds = (userId = USER): string[] =>
  (
    db
      .prepare(`SELECT external_id FROM emails WHERE user_id = ? ORDER BY external_id`)
      .all(userId) as Array<{ external_id: string | null }>
  ).map((r) => r.external_id ?? "(null)");

const stagingTables = (): string[] =>
  (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?`)
      .all(`${EMAIL_STAGING_TABLE_PREFIX}%`) as Array<{ name: string }>
  ).map((r) => r.name);


import type { EmailPrecacheProgress } from "../emailPrecacheProgress";
import {
  EMAIL_PRECACHE_FETCH_RANGE,
  EMAIL_PRECACHE_PERCENT,
} from "../emailPrecacheProgress";
// The REAL classifier, deliberately unmocked: the retry control below has to
// re-run for the same reason the shipped `retryOnNetwork` does, or it is a
// fixture for a retry the service would never perform.
import { isNetworkError } from "../../utils/networkErrors";

beforeEach(() => {
  jest.clearAllMocks();
  db = new Database(":memory:") as unknown as DatabaseType;
  loadSchema(db);
  seedParents();

  mockGetOAuthToken.mockImplementation(async (_u: string, provider: string) =>
    provider === "microsoft" ? OUTLOOK_TOKEN : null,
  );
  // `jest.clearAllMocks()` keeps implementations, so a control that installs a
  // retrying one would leak into every test after it.
  mockRetryOnNetwork.mockImplementation(async (operation: () => Promise<unknown>) =>
    operation(),
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
});

afterEach(() => {
  db.close();
});

/** Run a precache, collecting every progress event it emits. */
async function runCollecting(
  force: boolean,
  onEvent?: (p: EmailPrecacheProgress) => void,
): Promise<{
  events: EmailPrecacheProgress[];
  result: Awaited<ReturnType<typeof emailSyncService.precacheEmails>>;
}> {
  const events: EmailPrecacheProgress[] = [];
  const result = await emailSyncService.precacheEmails(
    USER,
    (p) => {
      events.push(p);
      onEvent?.(p);
    },
    { force },
  );
  return { events, result };
}

/** The phase sequence with consecutive repeats collapsed — the shape a bar shows. */
const phaseSequence = (events: EmailPrecacheProgress[]): string[] =>
  events.map((e) => e.phase).filter((phase, i, all) => phase !== all[i - 1]);

describe("BACKLOG-2856 — the progress sequence an ordinary re-cache reports", () => {
  /**
   * CONTROL — the repair pass is reported, and reported FIRST.
   *
   * This is the dead time the founder was actually staring at on the ordinary
   * button: since BACKLOG-2857 a re-cache repairs stale derivations before it
   * fetches anything, and on a large mailbox that is minutes during which no
   * mail arrives and, until this change, nothing was on screen.
   *
   * MUTATION: move the `emitProgress({ phase: "repairing" ... })` call below the
   * repair block, or delete it -> RED here (sequence loses its first element).
   */
  it("reports the repair pass before it fetches anything", async () => {
    const { events } = await runCollecting(false);

    expect(phaseSequence(events)).toEqual(["repairing", "fetching", "done"]);

    // Not merely "a repairing event exists somewhere" — it must precede every
    // fetching event, which is the whole claim.
    const firstRepair = events.findIndex((e) => e.phase === "repairing");
    const firstFetch = events.findIndex((e) => e.phase === "fetching");
    expect(firstRepair).toBeGreaterThanOrEqual(0);
    expect(firstRepair).toBeLessThan(firstFetch);
  });

  /**
   * CONTROL — the repair pass's own row counter reaches the bar.
   *
   * Without this, "Repairing stored emails..." would sit motionless for the
   * entire pass, which is only marginally better than a blank panel.
   */
  it("streams the repair pass's row count as it advances", async () => {
    mockReprocess.mockImplementation(
      async (opts: { onProgress?: (p: { scanned: number; rewritten: number }) => void }) => {
        opts.onProgress?.({ scanned: 200, rewritten: 12 });
        opts.onProgress?.({ scanned: 400, rewritten: 25 });
        return { scanned: 400, rewritten: 25, unchanged: 375, batches: 2, cancelled: false, skippedNeedsRefetch: false };
      },
    );

    const { events } = await runCollecting(false);

    expect(
      events.filter((e) => e.phase === "repairing").map((e) => e.current),
    ).toEqual([0, 200, 400]);

    // `current` is deliberately NOT clamped in `emitProgress`. The repair pass
    // counts rows scanned, not emails downloaded, so the first fetching event
    // resets it to 0. A clamp would read "(400 so far)" under "Downloading
    // emails" at 10%.
    // MUTATION: clamp `current` to a running max in `emitProgress` -> RED here
    // (`Received: 400`).
    expect(events.find((e) => e.phase === "fetching")?.current).toBe(0);
  });

  /**
   * CONTROL — the repair pass is handed the cancel hook.
   *
   * The pass consults `shouldCancel` between batches; if the service does not
   * pass one, the earliest and longest phase becomes uncancellable while the
   * Cancel button sits on screen next to it.
   */
  it("gives the repair pass a cancel hook and a progress hook", async () => {
    await runCollecting(false);

    const opts = mockReprocess.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof opts.shouldCancel).toBe("function");
    expect(typeof opts.onProgress).toBe("function");
  });
});

describe("BACKLOG-2856 — the progress sequence a FORCE re-cache reports", () => {
  beforeEach(() => {
    seedEmail({ id: "live-1", externalId: "ext-1", source: "outlook", sentAt: "2026-03-01T10:00:00Z" });
    mockOutlookSearch.mockResolvedValue([providerEmail(1)]);
  });

  /**
   * CONTROL — no repairing phase, and the swap is reported before completion.
   *
   * The mirror of the ordinary-path control, and the correction to the defect
   * report: the repair pass is SKIPPED on force, so a repairing event here would
   * mean the skip had been removed — which would put a full-corpus LIVE rewrite
   * immediately before the rows it rewrote were deleted.
   *
   * MUTATION: remove the `if (!isForce)` gate around the repair block -> RED
   * (a repairing phase appears).
   */
  it("never reports a repairing phase, and reports the swap before it finishes", async () => {
    const { events, result } = await runCollecting(true);

    expect(phaseSequence(events)).toEqual(["fetching", "swapping", "done"]);
    expect(events.some((e) => e.phase === "repairing")).toBe(false);
    expect(mockReprocess).not.toHaveBeenCalled();
    // The swap really did happen — otherwise "swapping was reported" would be
    // a claim about a phase that did no work.
    expect(result.forceSwap?.emailsInserted).toBe(1);
  });

  /**
   * CONTROL — percent never goes backwards, on either path.
   *
   * A bar that retreats reads as a restart and is the second-most common way to
   * make a long operation look broken.
   */
  it("never decreases percent across the run", async () => {
    const { events } = await runCollecting(true);

    const percents = events.map((e) => e.percent);
    expect(percents.length).toBeGreaterThan(1);
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1]);
    }
    expect(percents[percents.length - 1]).toBe(100);
  });
});

describe("BACKLOG-2856 — every exit path settles the bar", () => {
  /**
   * CONTROL — terminal event on success.
   *
   * MUTATION: delete the `onProgress?.(terminalProgress(...))` line in the
   * `finally` -> RED here and in both tests below.
   */
  it("ends a successful run with a done/success event", async () => {
    const { events } = await runCollecting(false);

    const last = events[events.length - 1];
    expect(last.phase).toBe("done");
    expect(last.outcome).toBe("success");
    expect(last.percent).toBe(100);
  });

  /**
   * CONTROL — terminal event when the run THROWS.
   *
   * This is one of the two paths that actually strand a bar in the field: an
   * exception skips every remaining emission, so without a terminal in the
   * `finally` the UI keeps a half-filled bar over a run that is already dead.
   */
  it("still ends with a terminal event when the run throws, and does not claim success", async () => {
    mockGetOAuthToken.mockRejectedValue(new Error("token store unreadable"));
    const events: EmailPrecacheProgress[] = [];

    await expect(
      emailSyncService.precacheEmails(USER, (p) => events.push(p), { force: false }),
    ).rejects.toThrow("token store unreadable");

    const last = events[events.length - 1];
    expect(last.phase).toBe("done");
    expect(last.outcome).toBe("error");
    // An error must not fill the bar. Reaching 100 would report a completed
    // rebuild over a run that failed.
    expect(last.percent).toBeLessThan(100);
  });

  /**
   * CONTROL — the already-in-progress guard emits NOTHING.
   *
   * Deliberate, and the one place the "terminal on every exit" rule is
   * inverted: the guard means a run IS live, and the progress channel is shared,
   * so a rejected caller's terminal event would settle the RUNNING run's bar and
   * hide a re-cache still in flight. The rejected caller is settled by its own
   * invoke response instead — asserted at the handler boundary, where the
   * renderer actually consumes it.
   */
  it("emits no progress at all when another run is already in flight", async () => {
    let releaseFirst: (() => void) | undefined;
    mockOutlookSearch.mockImplementation(
      () => new Promise((resolve) => { releaseFirst = () => resolve([]); }),
    );

    const firstEvents: EmailPrecacheProgress[] = [];
    const first = emailSyncService.precacheEmails(USER, (p) => firstEvents.push(p), { force: false });
    await new Promise((r) => setImmediate(r));

    const secondEvents: EmailPrecacheProgress[] = [];
    const second = await emailSyncService.precacheEmails(USER, (p) => secondEvents.push(p), { force: false });

    expect(second.error).toBe("Precache already in progress");
    expect(secondEvents).toEqual([]);

    // And the run that was actually going is undisturbed.
    releaseFirst?.();
    await first;
    expect(firstEvents[firstEvents.length - 1].outcome).toBe("success");
  });
});

describe("BACKLOG-2856 — cancelling a force re-cache leaves live email alone", () => {
  beforeEach(() => {
    // Three rows already cached, all inside the force set.
    seedEmail({ id: "live-1", externalId: "ext-1", source: "outlook", sentAt: "2026-03-01T10:00:00Z" });
    seedEmail({ id: "live-2", externalId: "ext-2", source: "outlook", sentAt: "2026-03-02T10:00:00Z" });
    seedEmail({ id: "live-3", externalId: "ext-3", source: "outlook", sentAt: "2026-03-03T10:00:00Z" });
  });

  /**
   * CONTROL — cancel mid-fetch, asserted by ROW-ID SET.
   *
   * Deliberately not a count. A count of 3 is equally consistent with "nothing
   * happened" and with "the three live rows were deleted and three freshly
   * fetched ones took their place under new ids" — which is the exact failure a
   * broken cancel would produce, and the reason the id SET is the assertion.
   *
   * MUTATION: remove the pre-swap `if (isCancelled())` checkpoint -> RED (the
   * swap runs and every id changes).
   */
  it("leaves the live row-id set identical when cancelled during the fetch", async () => {
    const before = db
      .prepare(`SELECT id FROM emails WHERE user_id = ? ORDER BY id`)
      .all(USER)
      .map((r) => (r as { id: string }).id);
    expect(before).toEqual(["live-1", "live-2", "live-3"]);

    mockOutlookSearch.mockImplementation(async () => {
      // The user hits Cancel while the first round is downloading.
      emailSyncService.requestPrecacheCancellation();
      return [providerEmail(1), providerEmail(2)];
    });

    const { events, result } = await runCollecting(true);

    expect(result.cancelled).toBe(true);
    expect(result.error).toBeUndefined(); // a cancel is not a failure
    expect(result.forceSwap).toBeUndefined(); // the swap never ran

    const after = db
      .prepare(`SELECT id FROM emails WHERE user_id = ? ORDER BY id`)
      .all(USER)
      .map((r) => (r as { id: string }).id);
    expect(after).toEqual(before);

    // Staging is gone — the interrupted run costs two ephemeral tables and
    // nothing else.
    expect(stagingTables()).toEqual([]);

    // And the bar is settled, not stranded at whatever the fetch reached.
    const last = events[events.length - 1];
    expect(last.phase).toBe("done");
    expect(last.outcome).toBe("cancelled");
    expect(last.percent).toBeLessThan(100);
  });

  /**
   * CONTROL — a cancel that arrives once the SWAP has begun is ignored.
   *
   * The boundary where a naive implementation corrupts a good run: re-check the
   * signal after the swap and the service reports `cancelled` over a mailbox it
   * has just successfully rebuilt, sending the user to look for damage that is
   * not there.
   *
   * The cancel is fired from the `swapping` progress event, which the service
   * emits immediately before it swaps — i.e. exactly when a user watching
   * "Replacing your cached emails..." would click Cancel.
   *
   * MUTATION: add an `isCancelled()` check after `swapEmailStagingIntoLive`
   * -> RED here.
   */
  it("ignores a cancel that lands after the swap has begun, and reports its real success", async () => {
    mockOutlookSearch.mockResolvedValue([providerEmail(1), providerEmail(2)]);

    const { events, result } = await runCollecting(true, (p) => {
      if (p.phase === "swapping") emailSyncService.requestPrecacheCancellation();
    });

    expect(result.cancelled).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.forceSwap?.emailsInserted).toBe(2);

    // The rebuild really landed: the old ids are gone, the fetched set is live.
    expect(externalIds()).toEqual(["ext-1", "ext-2"]);
    const ids = db
      .prepare(`SELECT id FROM emails WHERE user_id = ?`)
      .all(USER)
      .map((r) => (r as { id: string }).id);
    expect(ids).not.toContain("live-1");

    const last = events[events.length - 1];
    expect(last.outcome).toBe("success");
    expect(last.percent).toBe(100);
  });

  /**
   * CONTROL — cancelling stops the SECOND provider from starting.
   *
   * Cancel has to mean "do no more work", not merely "finish the current unit".
   * Without the per-round gates the run would keep downloading a whole second
   * mailbox after the user asked it to stop.
   */
  it("does not start the remaining fetch rounds after a cancel", async () => {
    mockGetOAuthToken.mockImplementation(async (_u: string, provider: string) =>
      provider === "microsoft" ? OUTLOOK_TOKEN : { id: "acct-gmail", access_token: "gt" },
    );
    mockGmailInit.mockResolvedValue(true);
    mockOutlookSearch.mockImplementation(async () => {
      emailSyncService.requestPrecacheCancellation();
      return [providerEmail(1)];
    });

    const { result } = await runCollecting(true);

    expect(result.cancelled).toBe(true);
    expect(mockOutlookSearchAll).not.toHaveBeenCalled();
    expect(mockGmailSearch).not.toHaveBeenCalled();
    expect(mockGmailSearchAll).not.toHaveBeenCalled();
  });
});

describe("BACKLOG-2856 — cancelling during the repair pass", () => {
  /**
   * CONTROL — the earliest phase is cancellable.
   *
   * Called out separately because it is the one most likely to be missed when
   * wiring a signal: the repair pass runs before the fetch loop the abort checks
   * naturally cluster around, and it is the phase a user waits through with
   * nothing visibly happening.
   *
   * MUTATION: stop passing `shouldCancel` to `reprocessEmailDerivations`, or
   * delete the post-repair `if (isCancelled())` return -> RED.
   */
  it("stops the run when the user cancels during the repair pass", async () => {
    mockReprocess.mockImplementation(
      async (opts: { shouldCancel?: () => boolean; onProgress?: (p: { scanned: number; rewritten: number }) => void }) => {
        expect(opts.shouldCancel?.()).toBe(false);
        // The user hits Cancel between batches.
        emailSyncService.requestPrecacheCancellation();
        expect(opts.shouldCancel?.()).toBe(true);
        return { scanned: 200, rewritten: 3, unchanged: 197, batches: 1, cancelled: true, skippedNeedsRefetch: false };
      },
    );

    const { events, result } = await runCollecting(false);

    expect(result.cancelled).toBe(true);
    expect(result.error).toBeUndefined();
    // Cancelled before the fetch loop, so no provider was ever contacted.
    expect(mockOutlookSearch).not.toHaveBeenCalled();

    // The sequence stops at repairing and then settles — it never advances to a
    // fetching phase the run did not perform.
    expect(phaseSequence(events)).toEqual(["repairing", "done"]);
    expect(events[events.length - 1].outcome).toBe("cancelled");
  });
});

describe("BACKLOG-2856 — the cancellation request itself", () => {
  it("reports whether a run was actually in flight", async () => {
    // Nothing running: the request is a no-op, not an error, and must not be
    // held for a future run — a stray click must never kill a re-cache the user
    // starts minutes later.
    expect(emailSyncService.requestPrecacheCancellation()).toBe(false);

    mockOutlookSearch.mockResolvedValue([]);
    const first = await runCollecting(false);
    expect(first.result.cancelled).toBeUndefined();
    expect(first.events[first.events.length - 1].outcome).toBe("success");
  });
});

/* ===========================================================================
 * THE FETCH PHASE REPORTS WHERE IT ACTUALLY IS
 * ===========================================================================
 * Everything above pins the ANCHORS: 10 before Outlook, 50 between providers,
 * 90 after Gmail. Those three were also the only percents the fetch phase ever
 * emitted, so on a large mailbox the bar sat on 10 for the whole Outlook round
 * and on 50 for the whole Gmail round — minutes of a filling bar that never
 * filled. The run was healthy; the report was not, and "it is stuck" is what
 * users reported.
 *
 * Each round now interpolates inside its own slice of those same anchors. The
 * anchors do not move, which is why every control above still holds.
 *
 * WHY EXACT SERIES AND NOT "SOMETHING BETWEEN 10 AND 50"
 * -----------------------------------------------------
 * A range assertion cannot separate a bar that tracks the fetch from one that
 * emits a single arbitrary mid-point and then freezes again — which is the
 * defect, one step to the right. So each control pins the whole series a known
 * provider transcript produces.
 * ======================================================================== */

/** What `outlookFetchService`/`gmailFetchService` hand their `onProgress`. */
type ProviderProgress = {
  fetched: number;
  total: number;
  estimatedTotal?: number;
  percentage: number;
  hasEstimate: boolean;
  folderIndex?: number;
  folderCount?: number;
  labelIndex?: number;
  labelCount?: number;
};
type ProgressOptions = { onProgress?: (p: ProviderProgress) => void };

const GMAIL_TOKEN = {
  id: "acct-gmail",
  access_token: "gt",
  connected_email_address: "me@example.net",
};

/** The percents of the fetching events only — the series a filling bar shows. */
const fetchPercents = (events: EmailPrecacheProgress[]): number[] =>
  events.filter((e) => e.phase === "fetching").map((e) => e.percent);

describe("the Outlook rounds report their own progress", () => {
  /**
   * CONTROL — the inbox round divides by Graph's real count.
   *
   * `searchEmails` asks for `@odata.count` before it pages, so its `percentage`
   * is a true fraction and the slice can be linear in it. 20/60/100 percent of
   * the round lands at 13/21/29 — inside [10, 30) and never touching 30.
   *
   * MUTATION: delete the `onProgress:` option from the inbox `searchEmails`
   * call -> RED (the series collapses to the two anchors).
   */
  it("fills 10->30 as the Outlook inbox round pages", async () => {
    mockOutlookSearch.mockImplementation(async (opts: ProgressOptions) => {
      opts.onProgress?.({ fetched: 100, total: 500, estimatedTotal: 500, percentage: 20, hasEstimate: true });
      opts.onProgress?.({ fetched: 300, total: 500, estimatedTotal: 500, percentage: 60, hasEstimate: true });
      opts.onProgress?.({ fetched: 500, total: 500, estimatedTotal: 500, percentage: 100, hasEstimate: true });
      return [];
    });

    const { events } = await runCollecting(false);

    expect(fetchPercents(events)).toEqual([
      EMAIL_PRECACHE_PERCENT.FETCH_START, // 10
      13,
      21,
      29,
      EMAIL_PRECACHE_PERCENT.FETCH_SECOND_PROVIDER, // 50
      EMAIL_PRECACHE_PERCENT.FETCH_DONE, // 90
    ]);
    // The round reporting itself finished must NOT reach the next anchor: 50
    // means "Outlook is done and Gmail has started", and the boundary event is
    // the only thing entitled to say so.
    expect(29).toBeLessThan(EMAIL_PRECACHE_FETCH_RANGE.OUTLOOK_FOLDERS.start);
  });

  /**
   * CONTROL — the inbox round's row count reaches the bar.
   *
   * The panel renders "Downloading emails (N so far)...". Before this the whole
   * Outlook round showed no N at all, because the only event it emitted carried
   * `current: 0`.
   */
  it("streams the inbox round's message count, not just its percent", async () => {
    mockOutlookSearch.mockImplementation(async (opts: ProgressOptions) => {
      opts.onProgress?.({ fetched: 100, total: 500, estimatedTotal: 500, percentage: 20, hasEstimate: true });
      opts.onProgress?.({ fetched: 500, total: 500, estimatedTotal: 500, percentage: 100, hasEstimate: true });
      // Returns the 500 it reported, as the real call does.
      return providerEmails(1, 500);
    });

    const { events } = await runCollecting(false);

    // The boundary and FETCH_DONE carry the run's total, which on a clean run
    // is the 500 the round reported. No drop.
    expect(events.filter((e) => e.phase === "fetching").map((e) => e.current))
      .toEqual([0, 100, 500, 500, 500]);
  });

  /**
   * CONTROL — no count, no movement, and no invented denominator.
   *
   * When the `@odata.count` request fails, `searchEmails` reports
   * `hasEstimate: false` with `percentage` hardcoded to 0. Trusting that would
   * peg the bar at the bottom of the slice and call it progress; dividing by
   * something made up would be worse. The bar holds at the slice start and the
   * message count carries the movement — the idiom the repair pass uses.
   *
   * MUTATION: drop the `p.hasEstimate ?` guard and always use `p.percentage`
   * -> this test stays green (0/100 is still the start of the slice) but the
   * count assertion is what proves the round was reported at all.
   */
  it("holds the percent but keeps counting when Graph gives no total", async () => {
    mockOutlookSearch.mockImplementation(async (opts: ProgressOptions) => {
      opts.onProgress?.({ fetched: 100, total: 100, estimatedTotal: 0, percentage: 0, hasEstimate: false });
      opts.onProgress?.({ fetched: 200, total: 200, estimatedTotal: 0, percentage: 0, hasEstimate: false });
      return providerEmails(1, 200);
    });

    const { events } = await runCollecting(false);

    const fetching = events.filter((e) => e.phase === "fetching");
    expect(fetching.map((e) => e.percent)).toEqual([10, 10, 10, 50, 90]);
    expect(fetching.map((e) => e.current)).toEqual([0, 100, 200, 200, 200]);
  });

  /**
   * CONTROL — the folder walk fills 30->50 by FOLDERS COMPLETED.
   *
   * This is the round the founder's 28.3 seconds were spent inside, and the one
   * whose per-page numbers cannot drive a bar: `searchEmailsByFolder` restarts
   * `fetched` on every folder and always reports `percentage: 0`. The walk-level
   * `folderIndex`/`folderCount` pair is the only monotone signal it has, so that
   * is what the slice divides by.
   *
   * MUTATION: delete the `onProgress:` option from the `searchAllFolders` call,
   * or stop forwarding `folderIndex`/`folderCount` in
   * `outlookFetchService.searchAllFolders` -> RED.
   */
  it("fills 30->50 as the Outlook folder walk completes folders", async () => {
    mockOutlookSearchAll.mockImplementation(async (opts: ProgressOptions) => {
      for (let folderIndex = 0; folderIndex < 4; folderIndex++) {
        // Two pages per folder, with the per-folder counter restarting each
        // time — transcribed from what `searchEmailsByFolder` actually emits.
        opts.onProgress?.({ fetched: 100, total: 100, percentage: 0, hasEstimate: false, folderIndex, folderCount: 4 });
        opts.onProgress?.({ fetched: 180, total: 180, percentage: 0, hasEstimate: false, folderIndex, folderCount: 4 });
      }
      return [];
    });

    const { events } = await runCollecting(false);

    expect(fetchPercents(events)).toEqual([
      EMAIL_PRECACHE_PERCENT.FETCH_START,
      30, 30, // folder 1 of 4
      34, 34, // folder 2 of 4
      39, 39, // folder 3 of 4
      44, 44, // folder 4 of 4
      EMAIL_PRECACHE_PERCENT.FETCH_SECOND_PROVIDER,
      EMAIL_PRECACHE_PERCENT.FETCH_DONE,
    ]);
  });
});

describe("the Gmail rounds report their own progress", () => {
  beforeEach(() => {
    mockGetOAuthToken.mockImplementation(async (_u: string, provider: string) =>
      provider === "microsoft" ? OUTLOOK_TOKEN : GMAIL_TOKEN,
    );
    mockGmailInit.mockResolvedValue(true);
  });

  /**
   * CONTROL — Gmail's two passes land in their two slices.
   *
   * `searchEmails` lists IDs (`hasEstimate: false`) and then downloads one body
   * per ID (`hasEstimate: true`, percentage against the count it just listed).
   * The bodies are nearly all of the time, so they get 54->70 and the ID scan
   * gets a token 50->54 divided by the caller's 2000-message cap.
   *
   * `current` counts BODIES, so it holds at 0 through the scan: listing an ID is
   * not downloading an email, and counting it as one would make the number drop
   * when the body pass restarted the count at ten.
   *
   * MUTATION: delete the `onProgress:` option from the Gmail `searchEmails`
   * call -> RED.
   */
  it("fills 50->70 across Gmail's ID scan and its body downloads", async () => {
    mockGmailSearch.mockImplementation(async (opts: ProgressOptions) => {
      // Pass 1: the ID listing. 2000 is EMAIL_FETCH_SAFETY_CAP, the bound the
      // caller passes and the only denominator this pass has.
      opts.onProgress?.({ fetched: 200, total: 200, estimatedTotal: 9999, percentage: 0, hasEstimate: false });
      opts.onProgress?.({ fetched: 1400, total: 1400, estimatedTotal: 9999, percentage: 0, hasEstimate: false });
      // Pass 2: bodies, against a real count.
      opts.onProgress?.({ fetched: 140, total: 1400, estimatedTotal: 9999, percentage: 10, hasEstimate: true });
      opts.onProgress?.({ fetched: 700, total: 1400, estimatedTotal: 9999, percentage: 50, hasEstimate: true });
      opts.onProgress?.({ fetched: 1400, total: 1400, estimatedTotal: 9999, percentage: 100, hasEstimate: true });
      // The 1,400 bodies it reported downloading. The numbers stay this large
      // because the scan divides by the 2,000 cap: reaching 52 takes at least
      // 1,334 listed IDs, and the body pass downloads one per listed ID.
      return providerEmails(1, 1400);
    });

    const { events } = await runCollecting(false);

    const fetching = events.filter((e) => e.phase === "fetching");
    expect(fetching.map((e) => e.percent)).toEqual([
      EMAIL_PRECACHE_PERCENT.FETCH_START,
      EMAIL_PRECACHE_PERCENT.FETCH_SECOND_PROVIDER, // 50, the boundary
      50, 52, // the ID scan
      55, 61, 69, // the bodies
      EMAIL_PRECACHE_PERCENT.FETCH_DONE,
    ]);
    // FETCH_DONE carries the run's total: the 1,400 the body pass reported.
    expect(fetching.map((e) => e.current)).toEqual([0, 0, 0, 0, 140, 700, 1400, 1400]);
    // Never reaches FETCH_DONE while Gmail is still downloading.
    expect(69).toBeLessThan(EMAIL_PRECACHE_PERCENT.FETCH_DONE);
  });

  /**
   * CONTROL — the label walk fills 70->90 by LABELS COMPLETED.
   *
   * The Gmail mirror of the folder walk, and it was missing from the brief:
   * wiring only `searchEmails` would have left Gmail's longest round reporting
   * nothing at all.
   *
   * MUTATION: delete the `onProgress:` option from `searchAllLabels`, or stop
   * forwarding `labelIndex`/`labelCount` in `gmailFetchService.searchAllLabels`
   * -> RED.
   */
  it("fills 70->90 as the Gmail label walk completes labels", async () => {
    mockGmailSearchAll.mockImplementation(async (opts: ProgressOptions) => {
      for (let labelIndex = 0; labelIndex < 3; labelIndex++) {
        opts.onProgress?.({ fetched: 50, total: 50, percentage: 100, hasEstimate: true, labelIndex, labelCount: 3 });
      }
      return [];
    });

    const { events } = await runCollecting(false);

    expect(fetchPercents(events)).toEqual([
      EMAIL_PRECACHE_PERCENT.FETCH_START,
      EMAIL_PRECACHE_PERCENT.FETCH_SECOND_PROVIDER,
      70, 76, 82,
      EMAIL_PRECACHE_PERCENT.FETCH_DONE,
    ]);
  });
});

describe("a round that restarts does not walk the bar backwards", () => {
  /**
   * CONTROL — the monotonic clamp, against the producer that actually exists.
   *
   * THE BRIEF NAMED THE WRONG MECHANISM. It said Gmail's `estimatedTotal` can
   * revise upward and drag a naive `fetched/estimatedTotal` backwards. It
   * cannot: `gmailFetchService` never puts `resultSizeEstimate` into
   * `percentage` — it reports `percentage: 0, hasEstimate: false` during the
   * scan, in writing, because it distrusts that estimate. A test named for that
   * would be a fixture for a state the code cannot emit.
   *
   * The real producer is `retryOnNetwork`: a network throw anywhere in a
   * provider block re-runs THE WHOLE BLOCK, and the round's own counter restarts
   * at zero with it. Here the inbox round reaches 29, the folder walk dies on a
   * socket hang up, and the re-run reports 20% and 60% of the inbox again —
   * which interpolates to 13 and 21 before the clamp sees them.
   *
   * MUTATION: replace `Math.max(lastPercent, progress.percent)` in
   * `emitProgress` with `progress.percent` -> RED (13 and 21 appear, and the
   * series decreases).
   */
  it("holds the percent when a network retry restarts a provider round", async () => {
    mockRetryOnNetwork.mockImplementation(async (operation: () => Promise<unknown>) => {
      try {
        return await operation();
      } catch (error) {
        if (!isNetworkError(error)) throw error;
        return await operation();
      }
    });

    // The same five messages on both attempts, as the same mailbox would give.
    // Each attempt reports what it has paged so far and returns what it paged.
    let attempt = 0;
    mockOutlookSearch.mockImplementation(async (opts: ProgressOptions) => {
      attempt++;
      if (attempt === 1) {
        opts.onProgress?.({ fetched: 5, total: 5, estimatedTotal: 5, percentage: 100, hasEstimate: true });
      } else {
        opts.onProgress?.({ fetched: 1, total: 5, estimatedTotal: 5, percentage: 20, hasEstimate: true });
        opts.onProgress?.({ fetched: 3, total: 5, estimatedTotal: 5, percentage: 60, hasEstimate: true });
      }
      return providerEmails(1, 5);
    });
    let folderAttempt = 0;
    mockOutlookSearchAll.mockImplementation(async (opts: ProgressOptions) => {
      folderAttempt++;
      // `isNetworkError` matches this string, so `precacheEmails` rethrows it
      // out of the folder round's own catch and the retry wrapper sees it.
      if (folderAttempt === 1) throw new Error("socket hang up");
      opts.onProgress?.({ fetched: 7, total: 7, percentage: 0, hasEstimate: false, folderIndex: 0, folderCount: 2 });
      // `/me/messages` spans every folder, so the walk re-finds the inbox's
      // five and adds two of its own.
      return providerEmails(1, 7);
    });

    const { events } = await runCollecting(false);

    // The block really did run twice — otherwise this control proves nothing.
    expect(attempt).toBe(2);
    expect(folderAttempt).toBe(2);

    // THE COUNT HOLDS ACROSS THE RETRY TOO.
    //
    // The high-water mark lives outside the retried callback. Inside it, the
    // re-run started the mark over and the panel read "(5 so far)" and then
    // "(1 so far)".
    //
    // Scoped to the round events (the ones naming a stage). The between-providers
    // event after them reads `totalFetched`, which on this path is only the two
    // messages the walk found new — attempt 2's inbox dedups to 0 against the
    // ids attempt 1 already saw. That residual is described beside the event in
    // the service and is not what this control is about.
    //
    // MUTATION: move `outlookReported`/`reportOutlook` back inside the
    // `retryOnNetwork` callback -> RED (the series becomes [5, 1, 3, 3]).
    const roundCounts = events
      .filter((e) => e.phase === "fetching" && e.stage !== undefined)
      .map((e) => e.current);
    expect(roundCounts).toEqual([5, 5, 5, 5]);
    for (let i = 1; i < roundCounts.length; i++) {
      expect(roundCounts[i]).toBeGreaterThanOrEqual(roundCounts[i - 1]);
    }

    const percents = fetchPercents(events);
    // The re-run's 20% and 60% would interpolate to these. They must not appear.
    expect(percents).not.toContain(13);
    expect(percents).not.toContain(21);
    expect(percents).toEqual([
      EMAIL_PRECACHE_PERCENT.FETCH_START,
      29, // attempt 1's inbox, complete
      29, 29, // attempt 2's inbox, clamped
      30, // the folder walk, first of two folders
      EMAIL_PRECACHE_PERCENT.FETCH_SECOND_PROVIDER,
      EMAIL_PRECACHE_PERCENT.FETCH_DONE,
    ]);
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1]);
    }
  });

  /**
   * CONTROL — the Gmail mark survives a retry too.
   *
   * The Outlook control above cannot see the Gmail block: moving only
   * `gmailReported` back inside its callback left the whole suite green. So the
   * same retry, on the Gmail side.
   *
   * 30 messages, because `gmailFetchService.searchEmails` downloads bodies in
   * batches of 10 and reports once per batch — fewer than 11 gives a single body
   * event and nothing for a restart to walk back.
   *
   * MUTATION: move `gmailReported`/`reportGmail` back inside the
   * `retryOnNetwork` callback -> RED (the re-run's scan reports 0 again and its
   * bodies climb 10, 20, 30 a second time).
   */
  it("holds the Gmail count when a network retry restarts the Gmail block", async () => {
    mockGetOAuthToken.mockImplementation(async (_u: string, provider: string) =>
      provider === "microsoft" ? OUTLOOK_TOKEN : GMAIL_TOKEN,
    );
    mockGmailInit.mockResolvedValue(true);
    mockRetryOnNetwork.mockImplementation(async (operation: () => Promise<unknown>) => {
      try {
        return await operation();
      } catch (error) {
        if (!isNetworkError(error)) throw error;
        return await operation();
      }
    });

    // Both attempts list the same 30 IDs and download the same 30 bodies.
    let attempt = 0;
    mockGmailSearch.mockImplementation(async (opts: ProgressOptions) => {
      attempt++;
      opts.onProgress?.({ fetched: 30, total: 30, estimatedTotal: 30, percentage: 0, hasEstimate: false });
      for (const fetched of [10, 20, 30]) {
        opts.onProgress?.({
          fetched,
          total: 30,
          estimatedTotal: 30,
          percentage: Math.round((fetched / 30) * 100),
          hasEstimate: true,
        });
      }
      return providerEmails(1, 30);
    });
    let labelAttempt = 0;
    mockGmailSearchAll.mockImplementation(async (opts: ProgressOptions) => {
      labelAttempt++;
      if (labelAttempt === 1) throw new Error("socket hang up");
      opts.onProgress?.({ fetched: 32, total: 32, percentage: 100, hasEstimate: true, labelIndex: 0, labelCount: 2 });
      // The label walk re-finds the 30 and adds two of its own.
      return providerEmails(1, 32);
    });

    const { events } = await runCollecting(false);

    expect(attempt).toBe(2);
    expect(labelAttempt).toBe(2);

    const gmailRoundCounts = events
      .filter((e) => e.stage === "gmail-messages" || e.stage === "gmail-labels")
      .map((e) => e.current);
    expect(gmailRoundCounts).toEqual([
      0, 10, 20, 30, // attempt 1: the scan counts no bodies, then three batches
      30, 30, 30, 30, // attempt 2: its scan and batches, held at the mark
      30, // the label walk
    ]);
    for (let i = 1; i < gmailRoundCounts.length; i++) {
      expect(gmailRoundCounts[i]).toBeGreaterThanOrEqual(gmailRoundCounts[i - 1]);
    }
  });
});

describe("the message count never retracts", () => {
  /**
   * CONTROL — the round's own count is an UPPER BOUND on the boundary's, and the
   * panel must not walk it back.
   *
   * `outlookFetchService.searchEmails` reports its PRE-SLICE length and returns
   * `slice(0, maxResults)`. `fetchStoreAndDedup` then reports what survived its
   * `seenIds` filter, which is smaller again. The panel reads "Downloading
   * emails (N so far)", so if the call ever reported more than the 2,000 it was
   * passed, an unguarded `current` would say 2,099 and then correct itself to
   * 2,000 — the overstate-then-retract this repo's rules exist to catch.
   *
   * On the pre-cache path the clamp cannot bind today; it is a defensive pin.
   * The inbox call passes no `query` and no `contactEmails`, so it runs the
   * `$filter`/`$skip` page loop, which stops after `MAX_GRAPH_PAGES` (10) pages
   * of `$top=100` (`outlookFetchService.ts:368`, `:859`). The call therefore
   * reports 1,000 at most, and the loop's `>= maxResults` break is never
   * reached. Reporting more than 2,000 would need Graph to return pages
   * averaging more than twice `$top`. (Traced by reading `searchEmails`; the
   * 10-page stop on that loop is pinned by `outlookFetchService.pagination.test.ts`.
   * Not run against Graph. The 1,000 inbox ceiling is BACKLOG-2312's, ruled
   * not a bug because the folder walk stores the rest.)
   *
   * So 2,099 is an input for the clamp, not a transcript of this path, and the
   * 2,000 rows the mock RETURNS are what `slice(0, 2000)` would hand back.
   *
   * MUTATION: drop `Math.min(p.fetched, EMAIL_FETCH_SAFETY_CAP)` -> RED here
   * (2,099 appears). Dropping the `reportOutlook(...)` wrapper does NOT red
   * this test: on a clean run the mark and the returned count agree. The retry
   * control in the describe above is what catches that one.
   */
  it("caps the Outlook round at what the call can return, and holds the high mark", async () => {
    mockOutlookSearch.mockImplementation(async (opts: ProgressOptions) => {
      opts.onProgress?.({ fetched: 1000, total: 2000, estimatedTotal: 5000, percentage: 50, hasEstimate: true });
      // Overshooting the 2,000 cap it was given.
      opts.onProgress?.({ fetched: 2099, total: 2000, estimatedTotal: 5000, percentage: 100, hasEstimate: true });
      // What the call hands back after `slice(0, maxResults)`.
      return providerEmails(1, 2000);
    });
    mockOutlookSearchAll.mockImplementation(async (opts: ProgressOptions) => {
      opts.onProgress?.({ fetched: 5, total: 5, percentage: 0, hasEstimate: false, folderIndex: 0, folderCount: 2 });
      // Five messages the inbox round already has: `/me/messages` spans every
      // folder, so the walk re-finds them and `seenIds` drops all five.
      return providerEmails(1, 5);
    });

    const { events } = await runCollecting(false);

    const fetching = events.filter((e) => e.phase === "fetching");
    const currents = fetching.map((e) => e.current);

    // 2,099 is more than this call can hand back; 2,000 is the cap it passed.
    expect(currents).not.toContain(2099);
    expect(currents).toEqual([
      0,    // FETCH_START, before any round
      1000, // inbox, mid-page
      2000, // inbox's 2,099, clamped to the 2,000 the call was passed
      2000, // the folder walk holds the mark
      2000, // the boundary: the run's total, 2,000 from the inbox + 0 new
      2000, // FETCH_DONE
    ]);

    // Monotone across the whole fetch phase. On a clean run the boundary's
    // total equals the mark, so there is nothing for it to step down from.
    for (let i = 1; i < currents.length; i++) {
      expect(currents[i]).toBeGreaterThanOrEqual(currents[i - 1]);
    }
  });
});

describe("the backfill round does not walk the bar backwards", () => {
  /**
   * CONTROL — the clamp against its second producer.
   *
   * The backfill round (`[cacheSinceDate .. oldestCached)`, BACKLOG-3056) runs
   * AFTER both providers' incremental rounds and emits FETCH_SECOND_PROVIDER
   * (50) as its floor. With Gmail connected the label walk has already taken
   * the bar past 50, so without the clamp in `emitProgress` the bar would jump
   * back to 50 for the whole backfill.
   *
   * The retry control above guards the same clamp line through a different
   * producer. Until this test, nothing committed exercised this one.
   *
   * Note what the series also shows: the backfill's own rounds report nothing,
   * so the bar holds at the label walk's last value (82 here, up to 89) until
   * FETCH_DONE.
   *
   * MUTATION: replace `Math.max(lastPercent, progress.percent)` in
   * `emitProgress` with `progress.percent` -> RED (50 appears after 82).
   */
  it("holds the percent when the backfill round re-emits the between-providers anchor", async () => {
    // Already cached and newer than the configured floor (2026-01-01), so the
    // gap behind it is what the backfill fetches — the fixture shape
    // `emailSyncService.windowBackfill-3056.test.ts` uses.
    seedEmail({ id: "live-1", externalId: "ext-cached-1", source: "outlook", sentAt: "2026-03-01T10:00:00Z" });
    mockGetOAuthToken.mockImplementation(async (_u: string, provider: string) =>
      provider === "microsoft" ? OUTLOOK_TOKEN : GMAIL_TOKEN,
    );
    mockGmailInit.mockResolvedValue(true);
    mockGmailSearchAll.mockImplementation(
      async (opts: ProgressOptions & { before?: Date | null }) => {
        // The backfill's call carries a `before` and no `onProgress`. Nothing
        // older is left in this mailbox.
        if (opts.before) return [];
        // The incremental label walk: three labels, one message each.
        for (let labelIndex = 0; labelIndex < 3; labelIndex++) {
          opts.onProgress?.({ fetched: 1, total: 1, percentage: 100, hasEstimate: true, labelIndex, labelCount: 3 });
        }
        return providerEmails(1, 3);
      },
    );

    const { events } = await runCollecting(false);

    // The backfill really ran, for both providers — otherwise the floor event
    // below is not the backfill's and this control proves nothing.
    const backfillCalls = (mock: jest.Mock) =>
      mock.mock.calls.filter(([opts]) => (opts as { before?: Date | null }).before);
    expect(backfillCalls(mockOutlookSearch)).toHaveLength(1);
    expect(backfillCalls(mockGmailSearch)).toHaveLength(1);
    expect(backfillCalls(mockGmailSearchAll)).toHaveLength(1);

    expect(fetchPercents(events)).toEqual([
      EMAIL_PRECACHE_PERCENT.FETCH_START,
      EMAIL_PRECACHE_PERCENT.FETCH_SECOND_PROVIDER,
      70, 76, 82, // the label walk
      82, // the backfill's floor: 50 raw, held by the clamp
      EMAIL_PRECACHE_PERCENT.FETCH_DONE,
    ]);

    // And the held event is the backfill's floor, not a round's: it names no
    // stage and sits directly before FETCH_DONE.
    const fetching = events.filter((e) => e.phase === "fetching");
    const floor = fetching[fetching.length - 2];
    expect(floor.stage).toBeUndefined();
    expect(floor.percent).toBe(82);
  });
});
