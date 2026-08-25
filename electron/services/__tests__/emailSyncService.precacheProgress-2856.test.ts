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

jest.mock("../networkResilience", () => ({
  retryOnNetwork: (fn: () => Promise<unknown>) => fn(),
  networkResilienceService: {},
}));

const CACHE_SINCE = new Date("2026-01-01T00:00:00Z");
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
import { CURRENT_DERIVATION_VERSION } from "../../utils/derivationVersion";
import {
  EMAIL_STAGING_TABLE_PREFIX,
  emailForceSwapSteps,
  sweepStaleEmailStaging,
} from "../emailForceStaging";
import { sweepStaleStaging } from "../macOSMessagesImportService/forceStaging";

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

const emailIdSet = (userId = USER): string[] =>
  (db.prepare(`SELECT id FROM emails WHERE user_id = ? ORDER BY id`).all(userId) as Array<{
    id: string;
  }>).map((r) => r.id);

const externalIdSet = (userId = USER): string[] =>
  (
    db
      .prepare(`SELECT external_id FROM emails WHERE user_id = ? ORDER BY external_id`)
      .all(userId) as Array<{ external_id: string | null }>
  ).map((r) => r.external_id ?? "(null)");

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

beforeEach(() => {
  jest.clearAllMocks();
  db = new Database(":memory:") as unknown as DatabaseType;
  loadSchema(db);
  seedParents();

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
