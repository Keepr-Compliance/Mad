/**
 * @jest-environment node
 *
 * BACKLOG-3913 — after a Force Re-cache swap commits, the stored files of the
 * attachment rows it removed are reclaimed; nothing else is touched.
 *
 * End to end through the real `precacheEmails(..., { force: true })`, the real
 * `schema.sql`, the real driver and a real temp `userData` folder; only the
 * network is mocked. Mocks and seed helpers are transcribed from
 * `emailSyncService.forceRecacheKeepsDeals-3910a.test.ts`.
 *
 * CONTROLS (each mutation run in the failing direction; results on BACKLOG-3913):
 *   O1 orphan unlinked             -> remove the cleanup call -> red (O1, O5)
 *   O3 shared file kept            -> drop the reference check -> red
 *   O4 out-of-root path refused    -> skip containment, unlink the stored path -> red
 *   O5 unlink failure tolerated    -> rethrow per file -> red; rethrow to the run -> red
 *   O2 protected email's file kept -> guarded TWICE: the candidate set excludes
 *      protected emails AND the reference check keeps any referenced file. Either
 *      mutation alone stays green; both together -> red.
 *   O7 case-variant extension      -> drop COLLATE NOCASE from the reference check -> red
 *   O8 download vs cleanup race    -> drop the existsSync term in the dedup branch -> red
 *   O6 failed / not-applied swap   -> the rows were never removed, so the
 *      reference check also keeps their files. Running the cleanup on the failed
 *      swap alone stays green; with the reference check dropped -> red (O6a).
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
    // The REAL download-side writers (control O8 runs emailAttachmentService).
    getAttachmentStoragePaths: () =>
      (jest.requireActual("../db/attachmentDbService") as typeof import("../db/attachmentDbService")).getAttachmentStoragePaths(),
    findEmailAttachmentRow: (...a: unknown[]) =>
      (jest.requireActual("../db/attachmentDbService") as typeof import("../db/attachmentDbService")).findEmailAttachmentRow(...(a as [never, never, never])),
    createAttachmentRecord: (...a: unknown[]) =>
      (jest.requireActual("../db/attachmentDbService") as typeof import("../db/attachmentDbService")).createAttachmentRecord(...(a as [never])),
    setEmailAttachmentStorage: (...a: unknown[]) =>
      (jest.requireActual("../db/attachmentDbService") as typeof import("../db/attachmentDbService")).setEmailAttachmentStorage(...(a as [never, never, never, never])),
    getAttachmentsByEmailId: () => [],
  },
}));

// O8: the at-rest sealer is replaced by a plain write (encryption is covered by
// atRest.attachmentWriters-3816); the text extractor is not under test.
jest.mock("../atRest/attachmentWriter", () => ({
  ...jest.requireActual("../atRest/attachmentWriter"),
  sealBufferToFile: async (dest: string, data: Buffer) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("fs").writeFileSync(dest, data);
    return { sha256: "x", plaintextSize: data.length };
  },
}));
jest.mock("../attachmentTextExtractionService", () => ({
  extractTextForAttachment: jest.fn().mockResolvedValue(undefined),
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
const mockGmailGetAttachment = jest.fn();
jest.mock("../gmailFetchService", () => ({
  __esModule: true,
  default: {
    initialize: (...a: unknown[]) => mockGmailInit(...a),
    searchEmails: (...a: unknown[]) => mockGmailSearch(...a),
    searchAllLabels: (...a: unknown[]) => mockGmailSearchAll(...a),
    getAttachment: (...a: unknown[]) => mockGmailGetAttachment(...a),
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

// A real temp folder stands in for userData; created per test.
let mockUserData = "";
jest.mock("electron", () => ({
  app: { getPath: () => mockUserData },
}));

import emailSyncService from "../emailSyncService";
import { emailForceSwapSteps } from "../emailForceStaging";
import { computeParticipantHash } from "../../utils/emailAddress";
import * as os from "os";
import * as crypto from "crypto";
import emailAttachmentService from "../emailAttachmentService";
import * as orphanFiles from "../emailForceOrphanFiles";
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

beforeEach(() => {
  jest.clearAllMocks();
  mockUserData = fs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3913-"));
  fs.mkdirSync(nodePath.join(mockUserData, "attachments"));
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

// Pass-through spy: records whether the cleanup was called at all (O6a/O6b).
let cleanupSpy: jest.SpyInstance;
beforeEach(() => {
  cleanupSpy = jest.spyOn(orphanFiles, "removeOrphanedAttachmentFiles");
});

afterEach(() => {
  cleanupSpy.mockRestore();
  db.close();
  fs.rmSync(mockUserData, { recursive: true, force: true });
});


// The installed database carries migration v71's partial unique index on
// attachments (schema.sql leaves it to the migration, see its header). The
// attachment writer's ON CONFLICT clause needs it.
beforeEach(() => {
  db.exec(V71_CREATE_PROVIDER_INDEX_SQL);
});

const OPEN_DEAL = "deal-open";

/** A stored file in the real attachments root, named like the writer names them (sha256 + ext). */
function storedFile(name: string): string {
  const p = nodePath.join(mockUserData, "attachments", name);
  fs.writeFileSync(p, `bytes of ${name}`);
  return p;
}
function attach(id: string, emailId: string, storagePath: string): void {
  db.prepare(
    `INSERT INTO attachments (id, email_id, filename, mime_type, storage_path, provider_attachment_id)
     VALUES (?, ?, ?, 'application/pdf', ?, ?)`,
  ).run(id, emailId, `${id}.pdf`, storagePath, `g-${id}`);
}
function addDeal(id: string): void {
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, submission_status) VALUES (?, ?, ?, 'not_submitted')`,
  ).run(id, USER, `${id} Main St`);
}
function seedParticipant(emailId: string, address: string): void {
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
     VALUES (?, 'from', 0, ?, ?)`,
  ).run(emailId, computeParticipantHash(emailId, "from", 0, address), address);
}
const all = (q: string, ...p: unknown[]): unknown[] => db.prepare(q).all(...(p as never[]));
function link(commId: string, dealId: string, emailId: string): void {
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id, link_source)
     VALUES (?, ?, ?, ?, (SELECT thread_id FROM emails WHERE id = ?), 'manual')`,
  ).run(commId, USER, dealId, emailId, emailId);
}

/**
 * The common scene: `removed` (unprotected, gone after the swap) and `kept`
 * (linked to an open deal, refreshed in place). The provider returns kept's
 * fresh copy only, so the run is a complete, applied rebuild.
 */
function seedScene(): void {
  addDeal(OPEN_DEAL);
  seedEmail({ id: "removed", externalId: "ext-9", source: "outlook", sentAt: "2026-03-09T10:00:00Z" });
  seedEmail({
    id: "kept",
    externalId: "ext-1",
    source: "outlook",
    sentAt: "2026-03-01T10:00:00Z",
    messageIdHeader: "<msg-1@example.com>",
  });
  db.prepare(`UPDATE emails SET thread_id = 'thread-1' WHERE id = 'kept'`).run();
  seedParticipant("kept", "old-sender@example.com");
  link("comm-1", OPEN_DEAL, "kept");
  mockOutlookSearch.mockResolvedValue([{ ...providerEmail(1), bodyPlain: "FRESH" }]);
}

const exists = (p: string): boolean => fs.existsSync(p);

describe("BACKLOG-3913 — Force Re-cache reclaims the files of removed attachment rows", () => {
  it("O1 + O2: a removed email's file is unlinked; a kept email's file stays", async () => {
    seedScene();
    const orphan = storedFile("aaaa.pdf");
    const keptFile = storedFile("bbbb.pdf");
    attach("att-removed", "removed", orphan);
    attach("att-kept", "kept", keptFile);

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(result.error).toBeUndefined();
    expect(result.forceSwap).toMatchObject({ emailsDeleted: 1, emailsRefreshed: 1 });
    expect(emailIdSet()).toEqual(["kept"]);
    expect(exists(orphan)).toBe(false);
    expect(exists(keptFile)).toBe(true);
  });

  it("O3: a content-addressed file shared by a removed row and a kept row stays", async () => {
    seedScene();
    const shared = storedFile("cccc.pdf");
    attach("att-removed", "removed", shared);
    attach("att-kept", "kept", shared);
    // And one shared with ANOTHER user's row only.
    seedEmail({ id: "theirs", userId: OTHER_USER, externalId: "ext-t", source: "outlook", sentAt: "2026-03-02T10:00:00Z" });
    seedEmail({ id: "removed-2", externalId: "ext-8", source: "outlook", sentAt: "2026-03-08T10:00:00Z" });
    const sharedWithOther = storedFile("dddd.pdf");
    attach("att-removed-2", "removed-2", sharedWithOther);
    attach("att-theirs", "theirs", sharedWithOther);

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(result.forceSwap).toMatchObject({ emailsDeleted: 2 });
    expect(all(`SELECT id FROM attachments ORDER BY id`)).toEqual([{ id: "att-kept" }, { id: "att-theirs" }]);
    expect(exists(shared)).toBe(true);
    expect(exists(sharedWithOther)).toBe(true);
  });

  it("O4: a stored path outside the attachment roots is never unlinked", async () => {
    seedScene();
    const outside = nodePath.join(mockUserData, "mad.db");
    fs.writeFileSync(outside, "the database");
    const traversal = nodePath.join(mockUserData, "attachments", "..", "keys.json");
    fs.writeFileSync(nodePath.join(mockUserData, "keys.json"), "keys");
    attach("att-out", "removed", outside);
    seedEmail({ id: "removed-2", externalId: "ext-8", source: "outlook", sentAt: "2026-03-08T10:00:00Z" });
    attach("att-trav", "removed-2", traversal);

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(result.forceSwap).toMatchObject({ emailsDeleted: 2 });
    expect(exists(outside)).toBe(true);
    expect(exists(nodePath.join(mockUserData, "keys.json"))).toBe(true);
  });

  it("O5: an unlink failure is tolerated and the re-cache result is unchanged", async () => {
    seedScene();
    const first = storedFile("eeee.pdf");
    const second = storedFile("ffff.pdf");
    attach("att-removed", "removed", first);
    seedEmail({ id: "removed-2", externalId: "ext-8", source: "outlook", sentAt: "2026-03-08T10:00:00Z" });
    attach("att-removed-2", "removed-2", second);
    const realUnlink = fs.unlinkSync;
    // The CJS module object itself: a namespace import is a copy, and spying on
    // it would not reach the module under test.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsModule = require("fs") as typeof import("fs");
    const unlinkCalls: string[] = [];
    const spy = jest.spyOn(fsModule, "unlinkSync").mockImplementation((p: fs.PathLike) => {
      unlinkCalls.push(String(p));
      // The FIRST unlink fails, whichever file it is: candidate order is not
      // defined, and the claim is that the files after a failure still go.
      if (unlinkCalls.length === 1) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      return realUnlink(p);
    });

    let result;
    try {
      result = await emailSyncService.precacheEmails(USER, undefined, { force: true });
    } finally {
      spy.mockRestore();
    }

    // The failure really was hit (mockRestore clears the spy's own record).
    expect(unlinkCalls).toHaveLength(2);
    expect(result.error).toBeUndefined();
    expect(result.forceSwap).toMatchObject({ emailsDeleted: 2, emailsRefreshed: 1 });
    // The failed file stays; the failure does not stop the next one.
    const failed = unlinkCalls[0];
    expect([first, second].filter((f) => exists(f))).toHaveLength(1);
    expect(exists(failed)).toBe(true);
  });

  it("O6a: a swap that throws touches no file", async () => {
    seedScene();
    const orphan = storedFile("1111.pdf");
    attach("att-removed", "removed", orphan);
    const spy = jest.spyOn(emailForceSwapSteps, "insertFromStaging").mockImplementation(() => {
      throw new Error("disk full");
    });

    let result;
    try {
      result = await emailSyncService.precacheEmails(USER, undefined, { force: true });
    } finally {
      spy.mockRestore();
    }

    expect(result.error).toMatch(/left unchanged/i);
    expect(emailIdSet()).toEqual(["kept", "removed"]);
    expect(exists(orphan)).toBe(true);
    // Ordering control: the cleanup is never even called on a failed swap.
    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it("O6b: a not-applied run (a mailbox did not finish) touches no file", async () => {
    seedScene();
    const orphan = storedFile("2222.pdf");
    attach("att-removed", "removed", orphan);
    // Transcribed from the 2960 timing suite: a non-network failure withholds
    // the rebuilt mark, so the run applies nothing.
    mockOutlookSearchAll.mockRejectedValue(new Error("folder enumeration failed"));

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(result.forceSwap).toBeUndefined();
    expect(result.forceNotApplied?.mailboxes.map((m) => m.provider)).toEqual(["outlook"]);
    expect(emailIdSet()).toEqual(["kept", "removed"]);
    expect(exists(orphan)).toBe(true);
    expect(cleanupSpy).not.toHaveBeenCalled();
  });

  it("O7: a kept row whose extension differs only in case keeps the file the removed row pointed at", async () => {
    // SR probe. The extension keeps the sender's case, so one content hash can have
    // a `.pdf` row and a `.PDF` row; on a case-insensitive filesystem that is ONE
    // file. Probe transcribed from the review: removed `ffff.pdf`, kept `ffff.PDF`.
    seedScene();
    const file = storedFile("ffff.pdf");
    const keptName = nodePath.join(mockUserData, "attachments", "ffff.PDF");
    attach("att-removed", "removed", file);
    attach("att-kept", "kept", keptName);

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(result.forceSwap).toMatchObject({ emailsDeleted: 1 });
    expect(all(`SELECT id FROM attachments`)).toEqual([{ id: "att-kept" }]);
    expect(exists(file)).toBe(true);
    expect(exists(keptName)).toBe(true);
  });

  it("O8: a download whose hash set was loaded before the swap re-writes the file the cleanup removed", async () => {
    seedScene();
    const data = Buffer.from("the same document in two emails");
    const hash = crypto.createHash("sha256").update(data).digest("hex");
    const file = storedFile(`${hash}.pdf`);
    attach("att-removed", "removed", file);

    // The provider fetch of the download is held open until the swap is done.
    let release!: (b: Buffer) => void;
    let fetchStarted!: () => void;
    const started = new Promise<void>((r) => (fetchStarted = r));
    mockGmailGetAttachment.mockImplementation(
      () =>
        new Promise<Buffer>((r) => {
          release = r;
          fetchStarted();
        }),
    );
    const download = emailAttachmentService.downloadEmailAttachments(USER, "kept", "ext-1", "gmail", [
      { filename: "doc.pdf", mimeType: "application/pdf", size: data.length, partId: "1", attachmentId: "g-1" },
    ]);
    await started; // existingHashes already holds `hash` (via att-removed)

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });
    expect(result.forceSwap).toMatchObject({ emailsDeleted: 1 });
    expect(exists(file)).toBe(false); // the cleanup did remove it

    release(data);
    const downloaded = await download;

    expect(downloaded.stored).toBe(1);
    const row = db.prepare(`SELECT storage_path FROM attachments WHERE email_id = 'kept'`).get() as {
      storage_path: string;
    };
    expect(row.storage_path).toBe(file);
    expect(exists(row.storage_path)).toBe(true);
  });
});
