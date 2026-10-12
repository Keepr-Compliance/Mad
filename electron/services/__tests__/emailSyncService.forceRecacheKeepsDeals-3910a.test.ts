/**
 * @jest-environment node
 *
 * BACKLOG-3910a — Force Re-cache KEEPS deal emails. End to end through the
 * real `precacheEmails(..., { force: true })`, the real `schema.sql`, the real
 * driver and the real attachment writer; only the network is mocked.
 *
 * The rule (founder 2026-10-11, plan 11916572, SR 4a19bf3e):
 *   - an email tied to a deal (transaction link, rejected suggestion, checklist
 *     member on the email or one of its attachments) is never removed;
 *   - on an OPEN deal it is refreshed IN PLACE from its fresh copy (same id);
 *   - on a LOCKED deal (submitted / under_review / resubmitted / approved) it
 *     is left byte-identical and its fresh copy is discarded.
 *
 * Every control below names the wrong build it was run against; the counts
 * are recorded on BACKLOG-3910 ("3910a SLICE 1").
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
  // The REAL attachment writer runs in this suite (C14), and it reaches the
  // database through these two.
  ensureDb: () => db,
  dbTransaction: (fn: () => unknown) => db.transaction(fn)(),
}));

const mockGetOAuthToken = jest.fn();
// The real BACKLOG-1870 writer, not a spy: C14 asserts on the attachment rows
// it leaves behind.
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getOAuthToken: (...a: unknown[]) => mockGetOAuthToken(...a),
    upsertEmailAttachmentMetadata: (...a: unknown[]) =>
      (
        jest.requireActual("../db/attachmentDbService") as typeof import("../db/attachmentDbService")
      ).upsertEmailAttachmentMetadata(...(a as [never])),
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
import { EMAIL_STAGING_TABLE_PREFIX, emailForceSwapSteps } from "../emailForceStaging";
import { computeParticipantHash } from "../../utils/emailAddress";
import { V71_CREATE_PROVIDER_INDEX_SQL } from "../db/migrationV71Sql";

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


// The installed database carries migration v71's partial unique index on
// attachments (schema.sql leaves it to the migration, see its header). The
// attachment writer's ON CONFLICT clause needs it.
beforeEach(() => {
  db.exec(V71_CREATE_PROVIDER_INDEX_SQL);
});

const OPEN_DEAL = "deal-open";
const OTHER_DEAL = "deal-other";

function addDeal(id: string, status = "not_submitted"): void {
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, submission_status) VALUES (?, ?, ?, ?)`,
  ).run(id, USER, `${id} Main St`, status);
}
/** A deal link, carrying the email's thread like the real writers do. */
function link(commId: string, dealId: string, emailId: string): void {
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id, link_source)
     VALUES (?, ?, ?, ?, (SELECT thread_id FROM emails WHERE id = ?), 'manual')`,
  ).run(commId, USER, dealId, emailId, emailId);
}
function reject(id: string, dealId: string, emailId: string): void {
  db.prepare(
    `INSERT INTO ignored_communications (id, user_id, transaction_id, email_id, email_thread_id)
     VALUES (?, ?, ?, ?, (SELECT thread_id FROM emails WHERE id = ?))`,
  ).run(id, USER, dealId, emailId, emailId);
}
function checklistEmailMember(dealId: string, memberId: string, emailId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES (?, ?, 'tpl', 'Residential')`,
  ).run(`ck-${dealId}`, dealId);
  db.prepare(
    `INSERT OR IGNORE INTO transaction_checklist_items (id, checklist_id, title) VALUES (?, ?, 'Signed offer')`,
  ).run(`it-${dealId}`, `ck-${dealId}`);
  db.prepare(
    `INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES (?, ?, 'email', 'e')`,
  ).run(`L-${memberId}`, `it-${dealId}`);
  db.prepare(
    `INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id) VALUES (?, ?, 'email', ?)`,
  ).run(memberId, `L-${memberId}`, emailId);
}
function seedThread(id: string, threadId: string): void {
  db.prepare(`UPDATE emails SET thread_id = ? WHERE id = ?`).run(threadId, id);
}
function seedParticipant(emailId: string, address: string): void {
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
     VALUES (?, 'from', 0, ?, ?)`,
  ).run(emailId, computeParticipantHash(emailId, "from", 0, address), address);
}

const all = (q: string, ...p: unknown[]): unknown[] => db.prepare(q).all(...(p as never[]));
/** Everything the swap could touch, for byte-identity checks. */
const snapshot = (): Record<string, unknown[]> => ({
  emails: all(`SELECT * FROM emails ORDER BY id`),
  participants: all(`SELECT * FROM email_participants ORDER BY email_id, role, position`),
  communications: all(`SELECT * FROM communications ORDER BY id`),
  ignored: all(`SELECT * FROM ignored_communications ORDER BY id`),
  attachments: all(`SELECT * FROM attachments ORDER BY id`),
  members: all(`SELECT * FROM transaction_checklist_link_members ORDER BY id`),
});
const emailRow = (id: string) => db.prepare(`SELECT * FROM emails WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
const countExt = (ext: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM emails WHERE external_id = ?`).get(ext) as { n: number }).n;

/** The fresh copy of message 1, with a CHANGED body and its own participants. */
function freshCopy(n = 1, over: Record<string, unknown> = {}) {
  return {
    ...providerEmail(n),
    bodyPlain: `FRESH body of message ${n}`,
    body: `<p>FRESH body of message ${n}</p>`,
    ...over,
  };
}

function seedLinked(id = "live-1", ext = "ext-1"): void {
  seedEmail({
    id,
    externalId: ext,
    source: "outlook",
    sentAt: "2026-03-01T10:00:00Z",
    messageIdHeader: "<msg-1@example.com>",
    bodyPlain: "OLD body",
  });
  seedThread(id, "thread-1");
  seedParticipant(id, "old-sender@example.com");
}

describe("BACKLOG-3910a — an email on an OPEN deal is refreshed in place", () => {
  beforeEach(() => {
    addDeal(OPEN_DEAL);
    addDeal(OTHER_DEAL);
  });

  /**
   * C1 + C2. Linked to an open deal, a checklist member, an attachment row with
   * a stored file, and a rejection on another deal. After: same id, fresh body,
   * every id that points at it unchanged, the stored file intact, one row.
   *
   * MUTATIONS: keep-stale (hide protected rows from the removal AND the read
   * view, no refresh) -> body stays "OLD body", red. Refresh by remove+insert
   * -> link, member, attachment and rejection ids gone, red. Exclude protected
   * rows from the removal only (no pairing) -> the swap throws on the unique
   * index and reports "could not be applied" (C2), red.
   */
  it("C1/C2: same id, fresh content, every link, member, attachment and rejection kept", async () => {
    seedLinked();
    link("comm-1", OPEN_DEAL, "live-1");
    reject("ign-1", OTHER_DEAL, "live-1");
    checklistEmailMember(OPEN_DEAL, "mem-1", "live-1");
    db.prepare(
      `INSERT INTO attachments (id, email_id, filename, mime_type, storage_path, provider_attachment_id)
       VALUES ('att-1', 'live-1', 'offer.pdf', 'application/pdf', '/files/offer.pdf', 'g-offer')`,
    ).run();
    mockOutlookSearch.mockResolvedValue([freshCopy()]);

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(result.error).toBeUndefined();
    expect(result.forceSwap).toMatchObject({
      emailsRefreshed: 1,
      emailsInserted: 0,
      emailsKeptLocked: 0,
      emailsKeptNoCopy: 0,
    });
    expect(emailIdSet()).toEqual(["live-1"]);
    expect(emailRow("live-1")?.body_plain).toBe("FRESH body of message 1");
    expect(countExt("ext-1")).toBe(1);
    expect(all(`SELECT id, email_id FROM communications`)).toEqual([{ id: "comm-1", email_id: "live-1" }]);
    expect(all(`SELECT id, email_id FROM ignored_communications`)).toEqual([{ id: "ign-1", email_id: "live-1" }]);
    expect(all(`SELECT id, email_id FROM transaction_checklist_link_members`)).toEqual([
      { id: "mem-1", email_id: "live-1" },
    ]);
    expect(all(`SELECT id, email_id, storage_path FROM attachments`)).toEqual([
      { id: "att-1", email_id: "live-1", storage_path: "/files/offer.pdf" },
    ]);
  });

  /**
   * C3 — a rejection alone keeps the email.
   * MUTATION: keep-set = transaction links only -> live-1 removed, red.
   */
  it("C3: an email whose only tie is a rejected suggestion is kept and refreshed", async () => {
    seedLinked();
    reject("ign-1", OTHER_DEAL, "live-1");
    mockOutlookSearch.mockResolvedValue([freshCopy()]);

    await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(emailIdSet()).toEqual(["live-1"]);
    expect(emailRow("live-1")?.body_plain).toBe("FRESH body of message 1");
    expect(all(`SELECT id FROM ignored_communications`)).toEqual([{ id: "ign-1" }]);
  });

  /**
   * C5c — an open status refreshes. Proves the gate reads submission_status
   * rather than "nothing refreshes".
   * MUTATION: freeze everything protected -> body stays "OLD body", red.
   */
  it.each(["not_submitted", "needs_changes", "rejected"])(
    "C5c: a deal with status %s is open — its email is refreshed",
    async (status) => {
      addDeal("deal-s", status);
      seedLinked();
      link("comm-1", "deal-s", "live-1");
      mockOutlookSearch.mockResolvedValue([freshCopy()]);

      const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

      expect(emailIdSet()).toEqual(["live-1"]);
      expect(emailRow("live-1")?.body_plain).toBe("FRESH body of message 1");
      expect(result.forceSwap?.emailsRefreshed).toBe(1);
    },
  );

  /**
   * C6 — a legacy row with NULL account_id is paired by user, not account.
   * MUTATION: account-scoped pairing (`s.account_id === k.account_id` required)
   * -> the copy is unpaired, inserted beside it: two rows for ext-1, red.
   */
  it("C6: a legacy NULL-account row pairs with its fresh copy — one row, original id", async () => {
    seedEmail({
      id: "legacy-1",
      externalId: "ext-1",
      source: "outlook",
      sentAt: "2026-03-01T10:00:00Z",
      messageIdHeader: "<msg-1@example.com>",
      accountId: null as unknown as string,
    });
    db.prepare(`UPDATE emails SET account_id = NULL WHERE id = 'legacy-1'`).run();
    link("comm-1", OPEN_DEAL, "legacy-1");
    mockOutlookSearch.mockResolvedValue([freshCopy()]);

    await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(emailIdSet()).toEqual(["legacy-1"]);
    expect(countExt("ext-1")).toBe(1);
    expect(emailRow("legacy-1")).toMatchObject({
      account_id: "acct-outlook",
      body_plain: "FRESH body of message 1",
    });
  });

  /**
   * C6b (SR S2) — two kept rows match one copy: the same-account row wins, the
   * loser is untouched and counted as kept with no copy.
   * MUTATION: drop the same-account rank (oldest-first only) -> legacy-1 (older)
   * wins, acct-1 is left stale, red.
   */
  it("C6b: the same-account kept row wins the pairing; the other is untouched", async () => {
    seedEmail({
      id: "legacy-1",
      externalId: "ext-1",
      source: "outlook",
      sentAt: "2026-03-01T10:00:00Z",
      messageIdHeader: "<msg-1@example.com>",
    });
    db.prepare(`UPDATE emails SET account_id = NULL, created_at = '2020-01-01 00:00:00' WHERE id = 'legacy-1'`).run();
    seedEmail({
      id: "acct-1",
      externalId: "ext-1",
      source: "outlook",
      sentAt: "2026-03-01T10:00:00Z",
      messageIdHeader: "<msg-1@example.com>",
    });
    link("comm-1", OPEN_DEAL, "legacy-1");
    link("comm-2", OPEN_DEAL, "acct-1");
    const loserBefore = emailRow("legacy-1");
    mockOutlookSearch.mockResolvedValue([freshCopy()]);

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(result.error).toBeUndefined();
    expect(emailIdSet()).toEqual(["acct-1", "legacy-1"]);
    expect(emailRow("acct-1")?.body_plain).toBe("FRESH body of message 1");
    expect(emailRow("legacy-1")).toEqual(loserBefore);
    expect(result.forceSwap).toMatchObject({ emailsRefreshed: 1, emailsKeptNoCopy: 1 });
  });

  /**
   * C12 (SR R2) — a new thread id moves with the email onto its deal links.
   * MUTATION: skip the thread propagation -> communications.thread_id stays
   * "thread-1", red.
   */
  it("C12: a changed thread id is carried onto the link and the rejection", async () => {
    seedLinked();
    link("comm-1", OPEN_DEAL, "live-1");
    reject("ign-1", OTHER_DEAL, "live-1");
    mockOutlookSearch.mockResolvedValue([freshCopy(1, { threadId: "thread-NEW" })]);

    await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(emailRow("live-1")?.thread_id).toBe("thread-NEW");
    expect(all(`SELECT thread_id FROM communications`)).toEqual([{ thread_id: "thread-NEW" }]);
    expect(all(`SELECT email_thread_id FROM ignored_communications`)).toEqual([
      { email_thread_id: "thread-NEW" },
    ]);
  });

  /**
   * C15 — participants of a refreshed email carry its id and a hash computed
   * from it.
   * MUTATION: copy the staged participant_hash -> hash mismatch, red.
   */
  it("C15: refreshed participants are the fresh ones, keyed and hashed to the live id", async () => {
    seedLinked();
    link("comm-1", OPEN_DEAL, "live-1");
    mockOutlookSearch.mockResolvedValue([freshCopy()]);

    await emailSyncService.precacheEmails(USER, undefined, { force: true });

    const parts = all(
      `SELECT email_id, role, position, email_address, participant_hash FROM email_participants ORDER BY role`,
    ) as Array<{ email_id: string; role: "from" | "to"; position: number; email_address: string; participant_hash: string }>;
    expect(parts.map((p) => `${p.email_id}:${p.role}:${p.email_address}`)).toEqual([
      "live-1:from:sender1@example.com",
      "live-1:to:me@example.com",
    ]);
    for (const p of parts) {
      expect(p.participant_hash).toBe(computeParticipantHash("live-1", p.role, p.position, p.email_address));
    }
  });

  /**
   * C14 — attachment details on a refreshed email: an existing non-NULL mime is
   * kept, a NULL size is filled, a new attachment is added, an attachment
   * missing from the fresh copy is kept with its stored file.
   * MUTATION: swap the COALESCE arguments in the writer's backfill -> att-a's
   * mime becomes the fresh one, red.
   */
  it("C14: never overwrites, fills NULLs, adds new, keeps the missing one", async () => {
    seedLinked();
    link("comm-1", OPEN_DEAL, "live-1");
    db.prepare(
      `INSERT INTO attachments (id, email_id, filename, mime_type, file_size_bytes, storage_path, provider_attachment_id) VALUES
         ('att-a', 'live-1', 'a.pdf', 'application/pdf', 10, '/files/a.pdf', 'g-a'),
         ('att-b', 'live-1', 'b.pdf', 'application/pdf', NULL, NULL, 'g-b'),
         ('att-d', 'live-1', 'd.pdf', 'application/pdf', 40, '/files/d.pdf', 'g-d')`,
    ).run();
    mockOutlookSearch.mockResolvedValue([
      freshCopy(1, {
        hasAttachments: true,
        attachments: [
          { name: "a.pdf", contentType: "application/octet-stream", size: 99, id: "g-a" },
          { name: "b.pdf", contentType: "application/pdf", size: 20, id: "g-b" },
          { name: "c.pdf", contentType: "application/pdf", size: 30, id: "g-c" },
        ],
      }),
    ]);

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(result.error).toBeUndefined();
    const rows = all(
      `SELECT id, filename, mime_type, file_size_bytes, storage_path FROM attachments WHERE email_id = 'live-1' ORDER BY filename`,
    ) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.filename)).toEqual(["a.pdf", "b.pdf", "c.pdf", "d.pdf"]);
    expect(rows[0]).toEqual({ id: "att-a", filename: "a.pdf", mime_type: "application/pdf", file_size_bytes: 10, storage_path: "/files/a.pdf" });
    expect(rows[1]).toMatchObject({ id: "att-b", file_size_bytes: 20 });
    expect(rows[3]).toEqual({ id: "att-d", filename: "d.pdf", mime_type: "application/pdf", file_size_bytes: 40, storage_path: "/files/d.pdf" });
  });

  /**
   * C14b (SR S3) — the pair moves account (legacy NULL account -> acct-outlook);
   * the kept attachment carries an OLD provider id, the fresh detail a new one.
   * One row for the filename, the kept one.
   * MUTATION: drop the account-change filename match -> a second offer.pdf row,
   * red.
   */
  it("C14b: no duplicate attachment row when the pair moves account", async () => {
    seedLinked();
    db.prepare(`UPDATE emails SET account_id = NULL WHERE id = 'live-1'`).run();
    link("comm-1", OPEN_DEAL, "live-1");
    db.prepare(
      `INSERT INTO attachments (id, email_id, filename, mime_type, storage_path, provider_attachment_id)
       VALUES ('att-old', 'live-1', 'offer.pdf', 'application/pdf', '/files/offer.pdf', 'old-graph-id')`,
    ).run();
    mockOutlookSearch.mockResolvedValue([
      freshCopy(1, {
        hasAttachments: true,
        attachments: [{ name: "offer.pdf", contentType: "application/pdf", size: 5, id: "new-graph-id" }],
      }),
    ]);

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(result.error).toBeUndefined();
    expect(emailRow("live-1")?.account_id).toBe("acct-outlook");
    expect(all(`SELECT id, filename, storage_path FROM attachments`)).toEqual([
      { id: "att-old", filename: "offer.pdf", storage_path: "/files/offer.pdf" },
    ]);
  });

  /**
   * C13 — a throw in the step AFTER the refresh leaves everything identical,
   * including the refreshed row's content.
   * MUTATION: run the swap steps outside `db.transaction` -> live-1 keeps the
   * FRESH body and unprotected rows are gone, red.
   */
  it("C13: a throw after the refresh rolls back the refresh and the removal", async () => {
    seedLinked();
    link("comm-1", OPEN_DEAL, "live-1");
    seedEmail({ id: "unprotected", externalId: "ext-9", source: "outlook", sentAt: "2026-03-09T10:00:00Z" });
    const before = snapshot();
    mockOutlookSearch.mockResolvedValue([freshCopy(), providerEmail(2)]);
    const spy = jest.spyOn(emailForceSwapSteps, "insertFromStaging").mockImplementation(() => {
      throw new Error("disk full");
    });

    try {
      const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });
      expect(result.error).toMatch(/left unchanged/i);
    } finally {
      spy.mockRestore();
    }

    expect(snapshot()).toEqual(before);
  });
});

describe("BACKLOG-3910a — an email on a LOCKED deal is left exactly as it is", () => {
  /**
   * C5 + S5. Every column, its participants and attachments identical; no
   * second row; the fresh copy, its participants and its attachment detail are
   * all discarded (no new attachment row on the held email).
   * MUTATION: refresh frozen pairs like open ones -> body changes, red. Insert
   * the frozen copy instead of discarding it -> UNIQUE throw, "could not be
   * applied", red. Keep the copy's buffered attachment detail -> a new
   * attachment row, red.
   */
  it.each(["submitted", "under_review", "resubmitted", "approved"])(
    "C5: status %s — the linked email is byte-identical and its copy is discarded",
    async (status) => {
      addDeal("deal-locked", status);
      seedLinked();
      link("comm-1", "deal-locked", "live-1");
      db.prepare(
        `INSERT INTO attachments (id, email_id, filename, storage_path) VALUES ('att-1', 'live-1', 'offer.pdf', '/files/offer.pdf')`,
      ).run();
      const before = snapshot();
      mockOutlookSearch.mockResolvedValue([
        freshCopy(1, {
          hasAttachments: true,
          attachments: [{ name: "new.pdf", contentType: "application/pdf", size: 5, id: "g-new" }],
        }),
      ]);

      const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

      expect(result.error).toBeUndefined();
      expect(result.forceSwap).toMatchObject({ emailsKeptLocked: 1, emailsRefreshed: 0, emailsInserted: 0 });
      expect(snapshot()).toEqual(before);
      expect(stagingTables()).toEqual([]);
    },
  );

  /**
   * C5b (R3(a)) — linked to an open deal AND a locked one: frozen.
   * MUTATION: freeze only when EVERY linked deal is locked -> body changes, red.
   */
  it("C5b: an email on an open deal and a locked deal is frozen", async () => {
    addDeal(OPEN_DEAL);
    addDeal("deal-locked", "approved");
    seedLinked();
    link("comm-1", OPEN_DEAL, "live-1");
    link("comm-2", "deal-locked", "live-1");
    const before = snapshot();
    mockOutlookSearch.mockResolvedValue([freshCopy()]);

    await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(snapshot()).toEqual(before);
  });
});

describe("BACKLOG-3910a — Needs Review suggestions do not protect an email", () => {
  /**
   * C9'. A pending-only email is removed (its fresh copy arrives under a new
   * id) and its pending row goes with it; the same shape also linked to a deal
   * keeps its id and its pending row.
   * MUTATION: add the pending-review table to the keep-set -> pending-only
   * keeps its id, red.
   */
  it("C9': pending-only is replaced and its suggestion cleared; pending + linked keeps both", async () => {
    addDeal(OPEN_DEAL);
    addDeal(OTHER_DEAL);
    seedEmail({ id: "pending-only", externalId: "ext-1", source: "outlook", sentAt: "2026-03-01T10:00:00Z", messageIdHeader: "<msg-1@example.com>" });
    seedEmail({ id: "pending-linked", externalId: "ext-2", source: "outlook", sentAt: "2026-03-02T10:00:00Z", messageIdHeader: "<msg-2@example.com>" });
    const pend = db.prepare(
      `INSERT INTO pending_review_communications (id, user_id, transaction_id, email_id) VALUES (?, ?, ?, ?)`,
    );
    pend.run("p-1", USER, OPEN_DEAL, "pending-only");
    pend.run("p-2", USER, OPEN_DEAL, "pending-linked");
    link("comm-2", OTHER_DEAL, "pending-linked");
    mockOutlookSearch.mockResolvedValue([providerEmail(1), providerEmail(2)]);

    await emailSyncService.precacheEmails(USER, undefined, { force: true });

    const ids = emailIdSet();
    expect(ids).not.toContain("pending-only");
    expect(ids).toContain("pending-linked");
    expect(countExt("ext-1")).toBe(1);
    expect(all(`SELECT id FROM pending_review_communications ORDER BY id`)).toEqual([{ id: "p-2" }]);
  });
});
