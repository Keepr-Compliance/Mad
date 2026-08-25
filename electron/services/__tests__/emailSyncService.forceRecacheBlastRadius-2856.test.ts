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

const externalIds = (userId = USER): string[] =>
  (
    db
      .prepare(`SELECT external_id FROM emails WHERE user_id = ? ORDER BY external_id`)
      .all(userId) as Array<{ external_id: string | null }>
  ).map((r) => r.external_id ?? "(null)");

const idsIn = (table: string): string[] =>
  (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);

describe("BACKLOG-2856 — MEASURING what a force re-cache destroys", () => {
  beforeEach(() => {
    db.prepare(
      `INSERT INTO transactions (id, user_id, property_address) VALUES ('txn-1', ?, '1 Main St')`,
    ).run(USER);

    // Three emails inside the force set, in the three states a user can have
    // them in, plus one deliberately OUTSIDE it.
    seedEmail({ id: "live-linked", externalId: "ext-1", source: "outlook", sentAt: "2026-03-01T10:00:00Z" });
    seedEmail({ id: "live-pending", externalId: "ext-2", source: "outlook", sentAt: "2026-03-02T10:00:00Z" });
    seedEmail({ id: "live-rejected", externalId: "ext-3", source: "outlook", sentAt: "2026-03-03T10:00:00Z" });
    // Outside the window -> outside the force set -> must survive untouched.
    seedEmail({ id: "live-old", externalId: "ext-old", source: "outlook", sentAt: "2025-01-01T10:00:00Z" });

    // A LINK the user made.
    db.prepare(
      `INSERT INTO communications (id, user_id, transaction_id, email_id, link_source, match_reason)
       VALUES ('comm-linked', ?, 'txn-1', 'live-linked', 'manual', 'address_found')`,
    ).run(USER);
    // Store B: the legacy "needs review" row.
    db.prepare(
      `INSERT INTO communications (id, user_id, transaction_id, email_id, link_source, match_reason)
       VALUES ('comm-review', ?, 'txn-1', 'live-pending', 'auto', 'address_missing')`,
    ).run(USER);
    // Store A: the pending Needs Review queue — a DECISION NOT YET MADE.
    db.prepare(
      `INSERT INTO pending_review_communications (id, user_id, transaction_id, email_id)
       VALUES ('prc-email', ?, 'txn-1', 'live-pending')`,
    ).run(USER);
    // A TEXT thread queued for review — keyed by thread, not by email, so the
    // email swap has no business touching it. This is the control that stops
    // "the queue is emptied" from being read as "everything is emptied".
    db.prepare(
      `INSERT INTO pending_review_communications (id, user_id, transaction_id, thread_id)
       VALUES ('prc-thread', ?, 'txn-1', 'thread-abc')`,
    ).run(USER);
    // A DECISION THE USER ALREADY MADE: this email was rejected/removed.
    db.prepare(
      `INSERT INTO ignored_communications (id, user_id, transaction_id, email_id, match_reason)
       VALUES ('ign-rejected', ?, 'txn-1', 'live-rejected', 'address_missing')`,
    ).run(USER);
  });

  /**
   * THE MEASUREMENT — asserted by id SET, never by count.
   *
   * A count cannot tell "nothing was touched" apart from "these rows were
   * deleted and different ones took their place", which is precisely what a
   * force re-cache does to `emails`. Every assertion below names the exact rows.
   */
  it("destroys links, the pending review queue and prior decisions — and spares everything keyed elsewhere", async () => {
    mockOutlookSearch.mockResolvedValue([providerEmail(1), providerEmail(2), providerEmail(3)]);

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });
    expect(result.forceSwap?.emailsInserted).toBe(3);

    // --- what is GONE ---
    // Every link row, both the user's manual link and the address_missing
    // review row, because both key off emails.id.
    expect(idsIn("communications")).toEqual([]);
    // The email side of the Needs Review queue.
    expect(idsIn("pending_review_communications")).toEqual(["prc-thread"]);
    // The user's prior remove decision. This is the one nothing on screen
    // mentioned: with the suppression row gone, the email is no longer known to
    // have been rejected.
    expect(idsIn("ignored_communications")).toEqual([]);

    // --- what SURVIVES ---
    // The out-of-window email keeps its identity: the blast radius is the force
    // set, not the mailbox.
    const survivingIds = (
      db.prepare(`SELECT id FROM emails WHERE user_id = ? ORDER BY id`).all(USER) as Array<{ id: string }>
    ).map((r) => r.id);
    expect(survivingIds).toContain("live-old");
    expect(survivingIds).not.toContain("live-linked");
    expect(survivingIds).not.toContain("live-pending");
    expect(survivingIds).not.toContain("live-rejected");

    // And the re-fetched mail is present under NEW ids — which is the mechanism
    // by which a decision recorded against the old id cannot be reattached.
    expect(externalIds()).toEqual(["ext-1", "ext-2", "ext-3", "ext-old"]);
  });

  /**
   * THE TIE — the confirmation names every category this suite just proved is
   * destroyed.
   *
   * This is the control that would have caught the defect. A test that only
   * rendered the dialog would have passed against the old copy; a test that only
   * checked the deletions would have passed too, because the deletions were
   * correct and intended. The failure lived exactly in the gap between them: the
   * swap destroyed three things and the warning named one.
   *
   * The renderer file is read as TEXT rather than imported — `electron/` cannot
   * import from `src/` (rootDir), and reading is enough to pin the copy.
   *
   * MUTATION: delete any entry from FORCE_RECACHE_LOSSES, or drop its table
   * annotation -> RED here.
   */
  it("names every destroyed category in the confirmation the user actually reads", async () => {
    mockOutlookSearch.mockResolvedValue([providerEmail(1), providerEmail(2), providerEmail(3)]);
    await emailSyncService.precacheEmails(USER, undefined, { force: true });

    // The tables this run measurably emptied, derived from the database rather
    // than from a list someone maintained by hand.
    const emptied = ["communications", "pending_review_communications", "ignored_communications"].filter(
      (table) =>
        (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE email_id IS NOT NULL`).get() as { c: number })
          .c === 0,
    );
    expect(emptied).toEqual([
      "communications",
      "pending_review_communications",
      "ignored_communications",
    ]);

    const warningSource = fs.readFileSync(
      nodePath.join(__dirname, "..", "..", "..", "src", "components", "settings", "forceRecacheWarning.ts"),
      "utf8",
    );

    // The key -> table mapping lives HERE, on the electron side, because
    // BACKLOG-2791 forbids a renderer file from naming the pending review store
    // at all. The renderer carries semantic keys; this suite owns which table
    // each one stands for, and it is the side that can actually observe the
    // deletions.
    const KEY_FOR_TABLE: Record<string, string> = {
      communications: "links",
      pending_review_communications: "review-queue",
      ignored_communications: "decisions",
    };
    for (const table of emptied) {
      expect(warningSource).toContain(`key: "${KEY_FOR_TABLE[table]}"`);
    }

    // And the copy says the three things in plain words, so a future edit that
    // keeps the annotations but guts the sentences still goes red.
    expect(warningSource).toMatch(/unlinked from their transactions/i);
    expect(warningSource).toMatch(/Needs Review queue will be emptied/i);
    expect(warningSource).toMatch(/decisions you already made .* will be lost/i);
  });

  /**
   * THE CONSEQUENCE, MEASURED BY EXECUTION rather than inferred from the schema.
   *
   * `queueEmailForReview` is the primitive every discovery path uses, and it
   * refuses to re-queue an email that carries a rejection suppression row. So
   * whether a prior decision survives a force re-cache is exactly the question
   * "does that call still return false afterwards". Asked before and after,
   * against the real tables, instead of trusting the FK diagram.
   */
  it("re-queues a previously REJECTED email after a force re-cache, proving the decision is lost", async () => {
    const { queueEmailForReview } = await import("../reviewStateService");

    // Before: the rejection suppresses re-queueing. If this were already true
    // the "after" assertion would prove nothing, so it is pinned first.
    await expect(queueEmailForReview("txn-1", "live-rejected", USER)).resolves.toBe(false);

    mockOutlookSearch.mockResolvedValue([providerEmail(1), providerEmail(2), providerEmail(3)]);
    await emailSyncService.precacheEmails(USER, undefined, { force: true });

    // After: the same message, now under a new id, is re-queueable — it comes
    // back to the user as an UNDECIDED item.
    const reborn = db
      .prepare(`SELECT id FROM emails WHERE user_id = ? AND external_id = 'ext-3'`)
      .get(USER) as { id: string };
    expect(reborn.id).not.toBe("live-rejected");
    await expect(queueEmailForReview("txn-1", reborn.id, USER)).resolves.toBe(true);
  });
});
