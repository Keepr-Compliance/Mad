/**
 * @jest-environment node
 *
 * BACKLOG-2856 — email Force Re-cache, end to end against the REAL schema and
 * the REAL sqlite driver, with only the network mocked.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DB IS NOT MOCKED HERE
 * ---------------------------------------------------------------------------
 * Every claim this feature makes is a claim about what is IN the database after
 * an interruption: "live `emails` is unchanged", "rows outside the force set
 * survive", "the swap is atomic". A mocked `dbAll`/`dbRun` can only confirm that
 * some strings were passed to a spy, which is exactly the shape of check that
 * cannot separate a working swap from a broken one. So `dbConnection` is pointed
 * at a real in-memory database loaded from `electron/database/schema.sql`, and
 * the assertions read rows back.
 *
 * The fetch services ARE mocked — they are the network — but what they return is
 * the shape the real mappers produce, and the emails they hand back are read
 * back out of the database at the end to prove the round trip.
 *
 * ---------------------------------------------------------------------------
 * CONTROLS, AND THE MUTATIONS THAT MAKE EACH ONE RED
 * ---------------------------------------------------------------------------
 * Each of these was run in the failing direction before being trusted; the
 * mutation is named next to the test so the next person can repeat it.
 *
 *   1. high-water-mark bypass    -> restore the `MAX(sent_at)` clamp on force runs
 *   2. dedup read view           -> point the dedup reads back at live `emails`
 *   3. interruption atomicity    -> run the swap steps outside one transaction
 *   4. force-set scope           -> widen the predicate (drop `source` / `sent_at`)
 *   5. derivation + body_plain   -> stamp a literal 0 instead of the constant
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

const stagingTables = (): string[] =>
  (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?`)
      .all(`${EMAIL_STAGING_TABLE_PREFIX}%`) as Array<{ name: string }>
  ).map((r) => r.name);

beforeEach(() => {
  jest.clearAllMocks();
  db = new Database(":memory:") as unknown as DatabaseType;
  loadSchema(db);
  seedParents();

  // Outlook only, unless a test says otherwise. One provider keeps the force set
  // unambiguous; the multi-provider scoping gets its own test.
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

describe("BACKLOG-2856 — force re-cache re-fetches the whole window", () => {
  /**
   * CONTROL 1 — the high-water mark.
   *
   * This replaces the control the item was filed with. The item said a stored
   * Graph DELTA CURSOR (`email_sync_state.cursor`) is what would make a force
   * run fetch nothing, and instructed clearing it. Traced instead of assumed:
   * that cursor is read only by `shadowDeltaSyncService`, which is opt-in behind
   * `KEEPR_SHADOW_DELTA_SYNC` / `shadowDeltaSync.enabled` and is not on this
   * path — `searchEmails`/`searchAllFolders` never consult a deltaLink. Clearing
   * it would have passed trivially and proved nothing.
   *
   * What actually gates the re-fetch is the LOCAL clamp in `precacheEmails`:
   * `MAX(sent_at)` over live `emails`. Under stage-and-swap live keeps its rows
   * for the whole rebuild, so an unbypassed clamp would ask the provider for
   * "anything after the newest row I already have" — nothing — and the swap
   * would then delete the corpus and put that nothing back.
   *
   * MUTATION: delete `isForce ? null :` from the clamp -> `after` arrives as the
   * seeded 2026-06-01 instead of the 2026-01-01 cache floor, and the second
   * assertion goes red.
   */
  it("fetches from the cache-window floor, not from the newest cached row", async () => {
    seedEmail({
      id: "live-recent",
      externalId: "ext-1",
      source: "outlook",
      sentAt: "2026-06-01T00:00:00Z",
    });

    await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(mockOutlookSearch).toHaveBeenCalledTimes(1);
    const { after } = mockOutlookSearch.mock.calls[0][0] as { after: Date };
    expect(after.toISOString()).toBe(CACHE_SINCE.toISOString());
  });

  /** The ordinary (non-force) run must keep the incremental clamp it always had. */
  it("an incremental run still clamps to the newest cached row", async () => {
    seedEmail({
      id: "live-recent",
      externalId: "ext-1",
      source: "outlook",
      sentAt: "2026-06-01T00:00:00Z",
    });

    await emailSyncService.precacheEmails(USER);

    const { after } = mockOutlookSearch.mock.calls[0][0] as { after: Date };
    expect(after.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  /**
   * CONTROL 2 — the dedup read view, and the catastrophic path it prevents.
   *
   * A fully-cached mailbox is the case the whole feature exists for: nothing is
   * newer, so an incremental run is a no-op, and the force run must still
   * replace every row. If the dedup reads consulted live `emails` — which still
   * holds the force set during the rebuild — every re-fetched row would be
   * classified an already-cached duplicate, staging would finish EMPTY, and the
   * swap would delete the mailbox and insert nothing.
   *
   * Asserted on the external_id SET, not a count: a count of 3 would also be
   * satisfied by three rows that were never replaced.
   *
   * MUTATION: make `emailsSource` return `{ sql: "emails", params: [] }`
   * unconditionally -> `emailIdSet` comes back EMPTY (the mailbox is deleted and
   * nothing replaces it), which is the exact disaster this control is for.
   */
  it("re-stages and replaces every row of an already fully-cached mailbox", async () => {
    for (let n = 1; n <= 3; n++) {
      seedEmail({
        id: `live-${n}`,
        externalId: `ext-${n}`,
        source: "outlook",
        sentAt: `2026-03-0${n}T10:00:00Z`,
        messageIdHeader: `<msg-${n}@example.com>`,
      });
    }
    const before = emailIdSet();
    expect(before).toEqual(["live-1", "live-2", "live-3"]);

    mockOutlookSearch.mockResolvedValue([1, 2, 3].map((n) => providerEmail(n)));

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

    // Same provider ids, brand-new local ids: the corpus was rebuilt, not kept.
    expect(externalIdSet()).toEqual(["ext-1", "ext-2", "ext-3"]);
    const after = emailIdSet();
    expect(after).toHaveLength(3);
    expect(after.some((id) => before.includes(id))).toBe(false);
    expect(result.forceSwap).toEqual({
      emailsDeleted: 3,
      emailsInserted: 3,
      participantsInserted: 6,
      providers: ["outlook"],
    });
  });

  /**
   * CONTROL 5 — what the re-fetched rows actually carry.
   *
   * `body_plain` complete proves the row came back through the CURRENT mapper
   * (the BACKLOG-2855 fix), which is the founder's stated reason for wanting the
   * button. `derived_version` current proves the 2857 reprocess pass will not
   * immediately rewrite every freshly-fetched row.
   *
   * MUTATION: bind a literal `0` instead of `CURRENT_DERIVATION_VERSION` in the
   * insert -> the derived_version assertion goes red.
   */
  it("re-fetched rows carry a full body_plain and the current derivation version", async () => {
    seedEmail({
      id: "live-1",
      externalId: "ext-1",
      source: "outlook",
      sentAt: "2026-03-01T10:00:00Z",
      bodyPlain: "trunc",
      derivedVersion: 0,
      messageIdHeader: "<msg-1@example.com>",
    });
    mockOutlookSearch.mockResolvedValue([providerEmail(1)]);

    await emailSyncService.precacheEmails(USER, undefined, { force: true });

    const row = db
      .prepare(`SELECT body_plain, derived_version FROM emails WHERE external_id = 'ext-1'`)
      .get() as { body_plain: string; derived_version: number };

    expect(row.body_plain).toBe("Paragraph one of message 1.\n\nParagraph two.");
    expect(row.derived_version).toBe(CURRENT_DERIVATION_VERSION);
  });

  /** A force run must not spend a pass repairing rows it is about to delete. */
  it("skips the derivation reprocess pass on a force run, and runs it otherwise", async () => {
    await emailSyncService.precacheEmails(USER, undefined, { force: true });
    expect(mockReprocess).not.toHaveBeenCalled();

    await emailSyncService.precacheEmails(USER);
    // BACKLOG-2856 (progress/cancel round): the pass is now also handed a
    // `shouldCancel` and an `onProgress` hook, so the options object is matched
    // on the field this test is actually about. The claim here is unchanged and
    // undiminished — WHETHER the pass runs on each path — and the two hooks have
    // their own controls in `emailSyncService.precacheProgress-2856`.
    expect(mockReprocess).toHaveBeenCalledTimes(1);
    expect(mockReprocess).toHaveBeenCalledWith(expect.objectContaining({ userId: USER }));
  });
});

describe("BACKLOG-2856 — what a force re-cache leaves alone", () => {
  /**
   * CONTROL 4 — the force set is scoped, asserted BY IDENTITY.
   *
   * Each of these rows is one thing this run cannot put back, and the 2796
   * incident is what they are here for: an unscoped force set deleted everything
   * the user had and rebuilt only what one source could supply.
   *
   * MUTATION: drop the `source IN (…)` clause -> the disconnected-Gmail row
   * disappears. Drop `sent_at >= ?` -> the out-of-window row disappears. Drop
   * `external_id IS NOT NULL` -> the manual row disappears.
   */
  it("leaves other users, null-external-id, out-of-window and other-provider rows untouched", async () => {
    seedEmail({
      id: "keep-other-user",
      userId: OTHER_USER,
      externalId: "ext-1",
      source: "outlook",
      sentAt: "2026-03-01T10:00:00Z",
    });
    seedEmail({
      id: "keep-null-external",
      externalId: null,
      source: "outlook",
      sentAt: "2026-03-01T10:00:00Z",
    });
    seedEmail({
      id: "keep-out-of-window",
      externalId: "ext-old",
      source: "outlook",
      sentAt: "2025-06-01T10:00:00Z",
    });
    seedEmail({
      id: "keep-gmail-disconnected",
      externalId: "ext-g1",
      source: "gmail",
      sentAt: "2026-03-01T10:00:00Z",
    });
    seedEmail({
      id: "replace-me",
      externalId: "ext-1",
      source: "outlook",
      sentAt: "2026-03-01T10:00:00Z",
      messageIdHeader: "<msg-1@example.com>",
    });

    mockOutlookSearch.mockResolvedValue([providerEmail(1)]);

    await emailSyncService.precacheEmails(USER, undefined, { force: true });

    // By identity, not by count.
    expect(emailIdSet(OTHER_USER)).toEqual(["keep-other-user"]);
    const survivors = emailIdSet().filter((id) => id.startsWith("keep-"));
    expect(survivors).toEqual([
      "keep-gmail-disconnected",
      "keep-null-external",
      "keep-out-of-window",
    ]);
    expect(emailIdSet()).not.toContain("replace-me");
  });

  /**
   * A provider whose fetch did not complete keeps its rows.
   *
   * The all-folders round is most of an Outlook mailbox. If it fails, this run
   * holds the inbox and little else, so deleting the rest would trim the corpus
   * to whatever arrived before the failure and report it as a success.
   *
   * MUTATION: push "outlook" into `rebuiltProviders` unconditionally -> the
   * archived row is deleted and the first assertion goes red.
   */
  it("does not delete a provider's rows when its all-folders round failed", async () => {
    seedEmail({
      id: "archived-row",
      externalId: "ext-archived",
      source: "outlook",
      sentAt: "2026-02-01T10:00:00Z",
    });
    mockOutlookSearch.mockResolvedValue([providerEmail(1)]);
    mockOutlookSearchAll.mockRejectedValue(new Error("Graph 500 on all folders"));

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(emailIdSet()).toContain("archived-row");
    // Nothing was rebuilt, so there was nothing to swap in — and that is
    // reported as an error rather than a green "0 re-cached".
    expect(result.forceSwap).toBeUndefined();
    expect(result.error).toMatch(/could not complete/i);
    expect(stagingTables()).toEqual([]);
  });
});

describe("BACKLOG-2856 — one provider succeeds while the other does not", () => {
  const GMAIL_TOKEN = {
    id: "acct-gmail",
    access_token: "at",
    connected_email_address: "me@example.net",
  };

  beforeEach(() => {
    // Both mailboxes connected, so the force set starts optimistic over BOTH.
    mockGetOAuthToken.mockImplementation(async (_u: string, provider: string) =>
      provider === "microsoft" ? OUTLOOK_TOKEN : GMAIL_TOKEN,
    );
    mockGmailInit.mockResolvedValue(true);
  });

  /**
   * THE BRANCH THIS TEST EXISTS FOR: `restrictForceSetToRebuiltProviders`
   * actually pruning staged rows.
   *
   * Every other force test here runs Outlook-only, and the partial-failure test
   * above ends with NO provider rebuilt — which returns `null` before the
   * pruning loop ever runs. So the deletes, the participants-before-emails
   * ordering, and the `attachmentMeta` splice were all unexecuted code until
   * this test. That is the whole reason the loop was written.
   *
   * The scenario is the mixed one: Outlook completes both rounds, Gmail's
   * all-labels round fails. Gmail's live rows must survive, and this run has
   * ALREADY STAGED replacements for them from the Gmail inbox round. Those
   * staged rows must be thrown away, because their `external_id` is now held by
   * a surviving live row under the same `account_id` — which is precisely what
   * `idx_emails_account_external` forbids.
   *
   * MUTATION: delete the pruning loop from `restrictForceSetToRebuiltProviders`
   * -> the swap's plain INSERT hits UNIQUE, the whole swap rolls back, and the
   * run reports "could not be applied" in exactly the case the code exists to
   * rescue. Live stays intact either way (the safe direction), so nothing but
   * this test distinguishes the two.
   */
  it("swaps in the provider that finished and leaves the failed provider's rows alone", async () => {
    seedEmail({
      id: "outlook-live",
      externalId: "ext-1",
      source: "outlook",
      sentAt: "2026-03-01T10:00:00.000Z",
      messageIdHeader: "<msg-1@example.com>",
    });
    seedEmail({
      id: "gmail-live",
      externalId: "gext-1",
      source: "gmail",
      sentAt: "2026-03-02T10:00:00.000Z",
      messageIdHeader: "<gmsg-1@example.com>",
    });

    mockOutlookSearch.mockResolvedValue([providerEmail(1)]);
    mockOutlookSearchAll.mockResolvedValue([]);

    // Gmail's inbox round SUCCEEDS and stages a replacement carrying the same
    // provider id as the surviving live row...
    mockGmailSearch.mockResolvedValue([
      { ...providerEmail(1), id: "gext-1", messageIdHeader: "<gmsg-1@example.com>" },
    ]);
    // ...and then its all-labels round fails (non-network, so the Gmail block
    // completes and the run reaches the swap).
    mockGmailSearchAll.mockRejectedValue(new Error("Gmail 403 on label list"));

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

    // The swap happened, for Outlook only.
    expect(result.forceSwap).toEqual({
      emailsDeleted: 1,
      emailsInserted: 1,
      participantsInserted: 2,
      providers: ["outlook"],
    });
    expect(result.error).toBeUndefined();

    // Gmail's row survives BY IDENTITY — same local id, never replaced.
    expect(emailIdSet()).toContain("gmail-live");
    // Outlook's row was replaced: same provider id, a new local id.
    expect(emailIdSet()).not.toContain("outlook-live");
    expect(externalIdSet()).toEqual(["ext-1", "gext-1"]);
    // And exactly one row holds the Gmail provider id — the staged duplicate was
    // pruned rather than inserted alongside it.
    expect(
      db.prepare(`SELECT COUNT(*) AS c FROM emails WHERE external_id = 'gext-1'`).get(),
    ).toEqual({ c: 1 });
    expect(stagingTables()).toEqual([]);
  });
});

describe("BACKLOG-2856 — staging is namespaced away from the messages force path", () => {
  /**
   * The two force features must not share a staging namespace.
   *
   * `forceStaging.sweepStaleStaging` (the macOS messages path) drops EVERY
   * `staging_msgimport_%` table in the database, unscoped, as its way of
   * reclaiming a crashed run's leftovers. Had the email re-cache staged under
   * that prefix, a messages Force Re-import starting mid-run would have dropped
   * the email rebuild's tables out from under it — and the reverse. Nothing else
   * in the codebase would have flagged that; the two features never appear in
   * the same file.
   *
   * MUTATION: set `EMAIL_STAGING_TABLE_PREFIX` to `"staging_msgimport_"` -> the
   * messages sweep takes the email tables and the first assertion goes red.
   */
  it("survives the messages sweep, and reclaims its own orphans", () => {
    const emailOrphan = `${EMAIL_STAGING_TABLE_PREFIX}deadbeef_emails`;
    const messagesOrphan = "staging_msgimport_deadbeef_messages";
    db.exec(`CREATE TABLE "${emailOrphan}" (id TEXT)`);
    db.exec(`CREATE TABLE "${messagesOrphan}" (id TEXT)`);

    // The messages sweep must not touch the email staging table.
    sweepStaleStaging(db);
    expect(stagingTables()).toEqual([emailOrphan]);

    // The email sweep reclaims its own, and returns what it dropped.
    expect(sweepStaleEmailStaging(db)).toEqual([emailOrphan]);
    expect(stagingTables()).toEqual([]);
  });
});

describe("BACKLOG-2856 — an interrupted force re-cache changes nothing", () => {
  /**
   * CONTROL 3 — atomicity by construction.
   *
   * The failure is injected DURING the fetch, which is where a real interruption
   * lands (cancel, crash, dropped connection, full disk). The claim under test is
   * not "the transaction rolled back" but "live was never written in the first
   * place", so the assertion is that the row-id SET is byte-identical either
   * side of the run.
   *
   * THE FETCH DELIBERATELY INCLUDES A ROW LIVE DOES NOT HAVE (`ext-99`), and
   * that detail is the whole discriminating power of this test. An earlier
   * version seeded only replacements for rows already present, and it stayed
   * GREEN under the mutation that makes the rebuild write straight to live —
   * because the UNIQUE index on (account_id, external_id) rejected every insert
   * and the per-row try/catch swallowed it. It was passing on the strength of a
   * constraint, not on the property it claimed to check. A brand-new id has
   * nothing to collide with, so it lands in live under any design that writes
   * live before the swap, and its absence here is real evidence.
   *
   * MUTATION: point `writeEmailsTable` at `"emails"` (the pre-staging shape) ->
   * `ext-99` is in live after the interrupted run and this goes red.
   */
  it("leaves the live row-id set identical when the fetch throws mid-run", async () => {
    for (let n = 1; n <= 3; n++) {
      seedEmail({
        id: `live-${n}`,
        externalId: `ext-${n}`,
        source: "outlook",
        sentAt: `2026-03-0${n}T10:00:00Z`,
      });
    }
    const before = emailIdSet();

    // The inbox round succeeds and stages rows — three replacements AND one
    // message live has never seen; the all-folders round then dies with a
    // network error, which propagates out of the whole Outlook block.
    mockOutlookSearch.mockResolvedValue([
      ...[1, 2, 3].map((n) => providerEmail(n)),
      providerEmail(99, { sentAt: "2026-04-01T10:00:00Z" }),
    ]);
    mockOutlookSearchAll.mockRejectedValue(
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    );

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(emailIdSet()).toEqual(before);
    expect(externalIdSet()).toEqual(["ext-1", "ext-2", "ext-3"]);
    expect(result.forceSwap).toBeUndefined();
  });

  /**
   * The swap itself is ONE transaction — proved by breaking it in the middle.
   *
   * The test above interrupts during the FETCH, which never reaches the swap, so
   * it says nothing about what happens if a step inside the swap throws (a full
   * disk, a constraint the rebuild violated). This one injects the failure
   * exactly at the seam between the DELETE and the INSERT, which is the only
   * place the atomicity claim can be observed.
   *
   * MUTATION: in `swapEmailStagingIntoLive`, call the three steps directly
   * instead of inside `db.transaction(...)` -> the DELETE commits, the INSERT
   * throws, and live comes back EMPTY. That is the failure mode stage-and-swap
   * exists to make impossible, and this is the test that would catch it.
   */
  it("rolls the whole swap back when a step inside it throws", async () => {
    for (let n = 1; n <= 3; n++) {
      seedEmail({
        id: `live-${n}`,
        externalId: `ext-${n}`,
        source: "outlook",
        sentAt: `2026-03-0${n}T10:00:00Z`,
      });
    }
    const before = emailIdSet();
    mockOutlookSearch.mockResolvedValue([1, 2, 3].map((n) => providerEmail(n)));

    const insertSpy = jest
      .spyOn(emailForceSwapSteps, "insertFromStaging")
      .mockImplementation(() => {
        throw new Error("disk full");
      });

    try {
      const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });
      expect(result.forceSwap).toBeUndefined();
      expect(result.error).toMatch(/left unchanged/i);
    } finally {
      insertSpy.mockRestore();
    }

    // The DELETE ran inside the same transaction as the throw, so it is gone too.
    expect(emailIdSet()).toEqual(before);
    expect(stagingTables()).toEqual([]);
  });

  /**
   * The staging tables are ephemeral on EVERY exit path.
   *
   * An abandoned run that leaves its tables behind is not a data problem — live
   * is intact precisely because the swap never ran — but they accumulate, and
   * the next run's sweep is the only thing that reclaims them. Asserting the
   * `finally` actually fires is cheaper than discovering a dozen orphans later.
   */
  it("drops its staging tables after an interrupted run and after a clean one", async () => {
    mockOutlookSearch.mockResolvedValue([providerEmail(1)]);
    mockOutlookSearchAll.mockRejectedValue(
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    );
    await emailSyncService.precacheEmails(USER, undefined, { force: true });
    expect(stagingTables()).toEqual([]);

    mockOutlookSearchAll.mockResolvedValue([]);
    await emailSyncService.precacheEmails(USER, undefined, { force: true });
    expect(stagingTables()).toEqual([]);
  });

  /**
   * Link loss is the AGREED behaviour, so it is pinned rather than left implicit.
   *
   * Founder, 2026-08-24: parity with the messages force re-import, including
   * losing every email<->transaction link. If a future change quietly starts
   * preserving links via `message_id_header`, this test is what says the change
   * was a decision and not an accident — and the UI copy would need to change
   * with it.
   */
  it("cascade-deletes the communications rows of replaced emails (agreed parity cost)", async () => {
    seedEmail({
      id: "live-1",
      externalId: "ext-1",
      source: "outlook",
      sentAt: "2026-03-01T10:00:00Z",
      messageIdHeader: "<msg-1@example.com>",
    });
    db.prepare(
      `INSERT INTO transactions (id, user_id, property_address) VALUES ('txn-1', ?, '1 Main St')`,
    ).run(USER);
    // Columns transcribed from `schema.sql` communications, not invented: the
    // first draft of this fixture used `type` and `occurred_at`, which the table
    // does not have. It failed loudly here rather than quietly proving nothing,
    // which is the argument for running fixtures against the real schema.
    db.prepare(
      `INSERT INTO communications (id, user_id, transaction_id, email_id, link_source)
       VALUES ('comm-1', ?, 'txn-1', 'live-1', 'manual')`,
    ).run(USER);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM communications`).get()).toEqual({ c: 1 });

    mockOutlookSearch.mockResolvedValue([providerEmail(1)]);
    await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(db.prepare(`SELECT COUNT(*) AS c FROM communications`).get()).toEqual({ c: 0 });
  });
});
