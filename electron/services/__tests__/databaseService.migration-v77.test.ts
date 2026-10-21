/**
 * @jest-environment node
 *
 * BACKLOG-3983 — migration v77 on the REAL upgrade path: a one-time repair of
 * texts whose `messages.transaction_id` names a deal they hold no link to.
 * SR plan review pm_comments 12dae358 on BACKLOG-3983; plan pm_comments b2d6f2f2.
 *
 * Launch 1: the real `initialize()` builds an install at the current version,
 * the rows below are written, `schema_version` is put back to 76.
 * Launch 2: the real `initialize()` runs v77 through the real runner
 * (foreign_keys OFF for the loop, like production).
 *
 * EXECUTED (real writers, pre-BACKLOG-2550 order: pointer first, then the link,
 * as autoLinkService.ts did at f64f0a416^ lines 2126-2133; deal A locked between
 * the two, so the "auto" link is refused and the pointer stays):
 *   S1 m-old1   column A, no link anywhere                -> NULL
 *   S2 m-old2   column A, manual link to B only           -> B
 * TRANSCRIBED, NOT EXECUTED (no runtime writer found; foreign keys are ON for
 * every runtime connection; legacy installs only):
 *   S3 m-dang   column names a deal with no row            -> NULL
 *   S4 m-s4     links B (older) + missing deal (newer), column another missing deal -> B
 *   S5 m-s5     links B (older) + missing deal (newer), column that SAME missing deal -> B
 * Healthy controls (TRANSCRIBED; each has a NEWER link to B, so a repair that
 * re-points every column moves them):
 *   H1 m-recent column A, per-message A + newer per-message B -> A
 *   H2 m-th     column A, thread-only A + newer per-message B -> A
 *   H3 m-mail   channel email, column A, no message link   -> A (emails are not texts)
 *   H4 m-free   column NULL, no link                       -> NULL
 *
 * Run under Electron's node locally (the shared native module is Electron-ABI):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/services/__tests__/databaseService.migration-v77.test.ts --bail=0
 *
 * EVERY FIXTURE ROW IS SYNTHETIC.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../node_modules/better-sqlite3-multiple-ciphers"),
);

let userDataDir = "/tmp/unset-3983";
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => userDataDir),
    isPackaged: true,
    isReady: jest.fn(() => true),
    whenReady: jest.fn(() => Promise.resolve()),
    quit: jest.fn(),
  },
  dialog: { showMessageBox: jest.fn().mockResolvedValue({ response: 0 }) },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));
jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(true),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));
/** The precondition of the v2.41.0 race, not a fixture of its result: deal A locked mid-write. */
let mockLocked = new Set<string>();
jest.mock("../dealLockState", () => ({
  getDealLockReason: jest.fn((id: string) => (mockLocked.has(id) ? "submitted" : null)),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;
type Chain = Array<{ version: number; migrate: (d: DatabaseType) => void }>;
type ColMap = Record<string, string | null>;

function loadService(): AnyService {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../tests/helpers/installTestCapabilities").installTestCapabilities();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../databaseService").default;
}
const chain = (svc: AnyService): Chain => (svc.constructor as { MIGRATIONS: Chain }).MIGRATIONS;

const USER = "u-3983";
const CONTACT = "ct-3983";
const PHONE = "+12065550183"; // S1/S2/H1 thread: the picker control reads this contact
const PHONE2 = "+12065550184";
const EMAIL = "lender-3983@keepr.test";
const A = "tx-A";
const B = "tx-B";
const T1 = "th-3983-1";

const version = (db: DatabaseType): number =>
  (db.prepare("SELECT version FROM schema_version WHERE id=1").get() as { version: number }).version;
const column = (db: DatabaseType): ColMap =>
  Object.fromEntries(
    (db.prepare("SELECT id, transaction_id FROM messages ORDER BY id").all() as Array<{
      id: string;
      transaction_id: string | null;
    }>).map((r) => [r.id, r.transaction_id]),
  );
const links = (db: DatabaseType): string[] =>
  (db.prepare("SELECT id, message_id, thread_id, transaction_id FROM communications").all() as Array<
    Record<string, unknown>
  >)
    .map((r) => [r.id, r.message_id, r.thread_id, r.transaction_id].map(String).join("|"))
    .sort();

function text(db: DatabaseType, id: string, sentAt: string, thread: string, phone = PHONE): void {
  const last10 = phone.replace(/\D/g, "").slice(-10);
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text, participants, participants_flat, thread_id, sent_at)
     VALUES (?, ?, 'imessage', 'inbound', 'see you at closing', ?, ?, ?, ?)`,
  ).run(id, USER, JSON.stringify({ from: phone, to: ["me"] }), `${last10},me`, thread, sentAt);
}
function email(db: DatabaseType, id: string, sentAt: string): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, subject, body_text, participants, sent_at)
     VALUES (?, ?, 'email', 'inbound', 'Closing docs', 'attached', ?, ?)`,
  ).run(id, USER, JSON.stringify({ from: EMAIL, to: ["agent@keepr.test"] }), sentAt);
}
function link(db: DatabaseType, id: string, txn: string, messageId: string | null, linkedAt: string, thread: string | null = null): void {
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, message_id, thread_id, link_source, linked_at)
     VALUES (?, ?, ?, ?, ?, 'manual', ?)`,
  ).run(id, USER, txn, messageId, thread, linkedAt);
}
function base(db: DatabaseType): void {
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent@keepr.test', 'google', 'o-3983')`,
  ).run(USER);
  db.prepare(`INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, 'Lender')`).run(CONTACT, USER);
  db.prepare(`INSERT INTO contact_phones (id, contact_id, phone_e164, is_primary) VALUES ('cp-3983', ?, ?, 1)`).run(
    CONTACT,
    PHONE,
  );
  db.prepare(`INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES ('ce-3983', ?, ?, 1)`).run(
    CONTACT,
    EMAIL,
  );
  for (const [id, addr] of [
    [A, "100 Oak Street"],
    [B, "200 Elm Street"],
  ]) {
    db.prepare(
      `INSERT INTO transactions (id, user_id, property_address, status, started_at, created_at, submission_status, skip_address_filter)
       VALUES (?, ?, ?, 'active', '2026-01-01', '2026-01-01', 'not_submitted', 1)`,
    ).run(id, USER, addr);
    db.prepare(
      `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, 'buyer_agent')`,
    ).run(`tc-${id}`, id, CONTACT);
  }
}

/** Writes every state into the launch-1 store; S1/S2 through the real writers. */
function buildStates(db: DatabaseType, which: "all" | "healthy"): void {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { linkMessageToTransaction } = require("../db/messageDbService");
  const { createCommunicationReferenceSync } = require("../messageMatchingService");
  const { dbTransaction } = require("../db/core/dbConnection");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const manual = (m: string, t: string): void =>
    dbTransaction(() => {
      linkMessageToTransaction(m, t);
      createCommunicationReferenceSync(m, t, USER, "manual", 1.0);
    });
  const pre2550Expand = (m: string, t: string): string | null => {
    linkMessageToTransaction(m, t);
    return createCommunicationReferenceSync(m, t, USER, "auto", 0.9);
  };
  base(db);

  // H1: manual attach to A (real writer), then a newer per-message link to B.
  text(db, "m-recent", "2026-03-01T16:00:00.000Z", T1);
  manual("m-recent", A);
  link(db, "c-recent-b", B, "m-recent", "2099-01-01 00:00:00");
  db.prepare("UPDATE messages SET transaction_id = ? WHERE id = 'm-recent'").run(A);
  // H2: thread-only link to A, newer per-message B, column A.
  text(db, "m-th", "2026-02-01T00:00:00.000Z", "th-3983-only", PHONE2);
  link(db, "c-th", A, null, "2026-01-01 00:00:00", "th-3983-only");
  link(db, "c-th-b", B, "m-th", "2099-01-01 00:00:00");
  db.prepare("UPDATE messages SET transaction_id = ? WHERE id = 'm-th'").run(A);
  // H3: an email row with column A and no per-message link (emails link through email_id).
  email(db, "m-mail", "2026-03-03T00:00:00.000Z");
  db.prepare("UPDATE messages SET transaction_id = ? WHERE id = 'm-mail'").run(A);
  // H4: a free text.
  text(db, "m-free", "2026-03-04T00:00:00.000Z", "th-3983-free", PHONE2);
  if (which === "healthy") return;

  // S1 / S2 — EXECUTED: deal A locks between the pointer write and the link write.
  text(db, "m-old1", "2026-03-05T00:00:00.000Z", T1);
  text(db, "m-old2", "2026-03-06T00:00:00.000Z", T1);
  manual("m-old2", B);
  mockLocked.add(A);
  expect(pre2550Expand("m-old1", A)).toBeNull();
  expect(pre2550Expand("m-old2", A)).toBeNull();
  mockLocked.clear();

  // S3 / S4 / S5 — TRANSCRIBED, NOT EXECUTED: foreign keys off, deals with no row.
  db.pragma("foreign_keys = OFF");
  text(db, "m-dang", "2026-03-07T00:00:00.000Z", "th-3983-d", PHONE2);
  db.prepare("UPDATE messages SET transaction_id = 'tx-gone3' WHERE id = 'm-dang'").run();
  text(db, "m-s4", "2026-03-08T00:00:00.000Z", "th-3983-s4", PHONE2);
  link(db, "c-s4-b", B, "m-s4", "2026-01-01 00:00:00");
  link(db, "c-s4-g", "tx-gone4", "m-s4", "2026-02-01 00:00:00");
  db.prepare("UPDATE messages SET transaction_id = 'tx-gone4b' WHERE id = 'm-s4'").run();
  text(db, "m-s5", "2026-03-09T00:00:00.000Z", "th-3983-s5", PHONE2);
  link(db, "c-s5-b", B, "m-s5", "2026-01-01 00:00:00");
  link(db, "c-s5-g", "tx-gone5", "m-s5", "2026-02-01 00:00:00");
  db.prepare("UPDATE messages SET transaction_id = 'tx-gone5' WHERE id = 'm-s5'").run();
  db.pragma("foreign_keys = ON");
}

const HEALTHY_BEFORE: ColMap = { "m-free": null, "m-mail": A, "m-recent": A, "m-th": A };
const BEFORE_ALL: ColMap = {
  ...HEALTHY_BEFORE,
  "m-old1": A,
  "m-old2": A,
  "m-dang": "tx-gone3",
  "m-s4": "tx-gone4b",
  "m-s5": "tx-gone5",
};
const AFTER_ALL: ColMap = { ...HEALTHY_BEFORE, "m-old1": null, "m-old2": B, "m-dang": null, "m-s4": B, "m-s5": B };

const pickerIds = (txn: string, phone = PHONE): string[] => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getMessagesByContact } = require("../db/messageDbService");
  return (getMessagesByContact(USER, phone, txn) as Array<{ id: string }>).map((m) => m.id).sort();
};

/** Launch 1 + states at v76, then launch 2 (v77 runs). */
async function upgradeFrom76(which: "all" | "healthy") {
  const first = loadService();
  await expect(first.initialize()).resolves.toBe(true);
  const firstDb = first.db as DatabaseType;
  buildStates(firstDb, which);
  firstDb.prepare("UPDATE schema_version SET version = 76 WHERE id = 1").run();
  const before = column(firstDb);
  const pickerBefore = pickerIds(A);
  const linksBefore = links(firstDb);
  expect(version(firstDb)).toBe(76);
  await first.close();

  const second = loadService();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { installLogger } = require("../../capabilities/loggerProvider");
  const info = jest.fn();
  installLogger({ debug: jest.fn(), info, warn: jest.fn(), error: jest.fn() });
  await expect(second.initialize()).resolves.toBe(true);
  const db = second.db as DatabaseType;
  const v77Log = info.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith("[v77]"));
  return { svc: second, db, before, pickerBefore, linksBefore, v77Log };
}

function rerunV77(svc: AnyService, db: DatabaseType): void {
  const v77 = chain(svc).find((m) => m.version === 77)!;
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => v77.migrate(db))();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

describe("migration v77 — BACKLOG-3983, texts whose deal column names a deal they are not linked to", () => {
  jest.setTimeout(120000);
  let dir = "";
  beforeEach(() => {
    mockLocked = new Set();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3983-v77-"));
    userDataDir = dir;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is in the chain as v77, right after v76", () => {
    const versions = chain(loadService()).map((m) => m.version);
    expect(versions).toContain(77);
    expect(versions.indexOf(77)).toBe(versions.indexOf(76) + 1);
  });

  it("U0: the v77 setter is the live re-point rule at b272c6c68, verbatim", () => {
    // V77_REPOINT_SQL is FROZEN (MIGRATION-GUIDE rule 2: a merged migration never
    // changes). It was checked byte-equal to REPOINT_MESSAGE_TRANSACTION_SQL
    // (messageDbService.ts) at b272c6c68. If this goes red, do NOT edit the frozen copy.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { V77_REPOINT_SQL } = require("../db/migrationV77Sql");
    const FROZEN_AT_B272C6C68 = `UPDATE messages SET transaction_id = (
      SELECT c.transaction_id FROM communications c
      WHERE c.transaction_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM transactions t WHERE t.id = c.transaction_id)
        AND (
          c.message_id = messages.id
          OR (
            c.message_id IS NULL
            AND c.email_id IS NULL
            AND c.thread_id IS NOT NULL
            AND c.thread_id = messages.thread_id
            AND +c.user_id = messages.user_id
          )
        )
      ORDER BY c.linked_at DESC, c.rowid DESC
      LIMIT 1
    ) WHERE id = ?`;
    if (V77_REPOINT_SQL !== FROZEN_AT_B272C6C68) {
      throw new Error(
        "V77_REPOINT_SQL no longer matches the frozen re-point rule. NEVER edit the frozen copy " +
          "in migrationV77Sql.ts (a merged migration never changes). Restore it.",
      );
    }
  });

  it("U1: S1-S5 are repaired at v77; healthy rows, emails and link rows are not touched; re-run is identical", async () => {
    const { svc, db, before, pickerBefore, linksBefore, v77Log } = await upgradeFrom76("all");
    expect(before).toEqual(BEFORE_ALL);
    expect(version(db)).toBe(chain(svc).at(-1)!.version);
    // Coordinator's control: S1's column named deal A with no link to A, so it was
    // hidden from A's attach picker (the picker reads an empty column). After v77 it
    // is offered there. Real picker read (getMessagesByContact), not a fixture.
    expect(pickerBefore).toEqual([]);
    expect(pickerIds(A)).toEqual(["m-old1"]);
    expect(column(db)).toEqual(AFTER_ALL);
    expect(links(db)).toEqual(linksBefore);
    expect(v77Log).toEqual(["[v77] re-pointed 3 text(s), cleared 2"]);

    rerunV77(svc, db);
    expect(column(db)).toEqual(AFTER_ALL);
    expect(links(db)).toEqual(linksBefore);
    await svc.close();
  });

  it("U2: nothing qualifies at v76 -> v77 changes nothing", async () => {
    const { svc, db, before, linksBefore, v77Log } = await upgradeFrom76("healthy");
    expect(before).toEqual(HEALTHY_BEFORE);
    expect(column(db)).toEqual(HEALTHY_BEFORE);
    expect(links(db)).toEqual(linksBefore);
    expect(v77Log).toEqual(["[v77] re-pointed 0 text(s), cleared 0"]);
    rerunV77(svc, db);
    expect(column(db)).toEqual(HEALTHY_BEFORE);
    await svc.close();
  });

  it("P1: the qualifier searches idx_messages_transaction_id with no statistics (not a scan, not the channel index)", async () => {
    const svc = loadService();
    await expect(svc.initialize()).resolves.toBe(true);
    const db = svc.db as DatabaseType;
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'").get()).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { V77_ORPHAN_TEXT_IDS_SQL } = require("../db/migrationV77Sql");
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${V77_ORPHAN_TEXT_IDS_SQL}`).all() as Array<{ detail: string }>).map(
      (r) => r.detail,
    );
    expect(plan[0]).toBe("SEARCH m USING INDEX idx_messages_transaction_id (transaction_id>?)");
    expect(plan.join(" | ")).not.toMatch(/idx_messages_channel|SCAN m\b/);
    await svc.close();
  });

  it("C1 (static census): every statement that writes messages.transaction_id is one the executed census drives", () => {
    const root = path.join(__dirname, "..", "..");
    const found: Record<string, number> = {};
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== "__tests__" && e.name !== "node_modules") walk(p);
        } else if (/\.(ts|js|sql)$/.test(e.name) && !/\.test\./.test(e.name)) {
          const s = fs.readFileSync(p, "utf8");
          const re = /UPDATE\s+(?:OR\s+\w+\s+)?(?:main\.)?["`]?messages["`]?\s+SET\b([\s\S]{0,400}?)(WHERE|;|`)/gi;
          let m: RegExpExecArray | null;
          while ((m = re.exec(s))) {
            if (/transaction_id/i.test(m[1])) {
              const k = path.relative(root, p);
              found[k] = (found[k] ?? 0) + 1;
            }
          }
        }
      }
    };
    walk(root);
    // A new writer fails here: add it to the executed census (C2) and to this map.
    expect(found).toEqual({
      [path.join("services", "db", "messageDbService.ts")]: 2, // linkMessageToTransaction, REPOINT
      [path.join("services", "db", "messageMatchingSql.ts")]: 2, // claim 0.9, claim 0.85
      [path.join("services", "db", "migrationV76Sql.ts")]: 2, // v76 setter, v76 clear
      [path.join("services", "db", "migrationV77Sql.ts")]: 1, // v77 setter
    });
  });

  it("C2 (executed census): every writer runs, logs exactly what it writes, and leaves no text pointing at a deal it is not linked to", async () => {
    const svc = loadService();
    await expect(svc.initialize()).resolves.toBe(true);
    const db = svc.db as DatabaseType;
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { linkMessageToTransaction } = require("../db/messageDbService");
    const mm = require("../messageMatchingService");
    const { dbTransaction } = require("../db/core/dbConnection");
    const { deleteTransactionSync } = require("../db/transactionDbService");
    const txService = require("../transactionService/transactionService").default;
    const { rejectReviewItemsSync } = require("../reviewStateService");
    const { V77_ORPHAN_TEXT_IDS_SQL } = require("../db/migrationV77Sql");
    /* eslint-enable @typescript-eslint/no-require-imports */
    base(db);
    db.exec(`CREATE TEMP TABLE census (id TEXT, old TEXT, new TEXT)`);
    db.exec(`CREATE TEMP TRIGGER census_messages_txn AFTER UPDATE OF transaction_id ON main.messages
             BEGIN INSERT INTO census VALUES (NEW.id, OLD.transaction_id, NEW.transaction_id); END`);
    const take = (): Array<[string, string | null, string | null]> => {
      const rows = (db.prepare("SELECT id, old, new FROM census ORDER BY rowid").all() as Array<{
        id: string;
        old: string | null;
        new: string | null;
      }>).map((r) => [r.id, r.old, r.new] as [string, string | null, string | null]);
      db.exec("DELETE FROM census");
      return rows;
    };
    const orphans = (): string[] =>
      (db.prepare(V77_ORPHAN_TEXT_IDS_SQL).all() as Array<{ id: string }>).map((r) => r.id).sort();
    const manual = (m: string, t: string): void =>
      dbTransaction(() => {
        linkMessageToTransaction(m, t);
        mm.createCommunicationReferenceSync(m, t, USER, "manual", 1.0);
      });

    // claimMessagesForTransactionSql09 (autoLinkTextsToTransaction).
    text(db, "t-auto", "2026-03-01T16:00:00.000Z", T1);
    await mm.autoLinkTextsToTransaction(A);
    expect(take()).toEqual([["t-auto", null, A]]);
    expect(orphans()).toEqual([]);

    // linkMessageToTransaction (manual attach).
    text(db, "t-man", "2026-03-02T16:00:00.000Z", "th-3983-man", PHONE2);
    manual("t-man", B);
    expect(take()).toEqual([["t-man", null, B]]);
    manual("t-auto", B);
    expect(take()).toEqual([["t-auto", A, B]]);
    expect(orphans()).toEqual([]);

    // REPOINT via transactionService.unlinkMessages (the texts tab's remove).
    await txService.unlinkMessages(["t-auto"], B);
    expect(take()).toEqual([["t-auto", B, A]]);
    expect(orphans()).toEqual([]);

    // claimMessagesForTransactionSql085 (autoLinkEmailsToTransaction). Driven, and it
    // never writes: its candidate read (EMAIL_CHANNEL_CANDIDATES_SQL) selects
    // m.sender / m.recipients, which `messages` does not have, so the call returns
    // that error before the claim. Recorded, not fixed here (emails are outside v77).
    email(db, "e-auto", "2026-03-03T00:00:00.000Z");
    const emailRun = await mm.autoLinkEmailsToTransaction(A);
    expect(emailRun.linked).toBe(0);
    expect(emailRun.errors.length).toBeGreaterThan(0);
    // The failing read itself (the wrapped message differs by runner: CI's plain node
    // reports "Unknown error", Electron's node the SQLite text).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EMAIL_CHANNEL_CANDIDATES_SQL } = require("../db/messageMatchingSql");
    expect(() => db.prepare(EMAIL_CHANNEL_CANDIDATES_SQL)).toThrow(/no such column: m\.sender/);
    expect(take()).toEqual([]);
    expect(orphans()).toEqual([]);
    manual("e-auto", A);
    expect(take()).toEqual([["e-auto", null, A]]);

    // DELETE_COMMUNICATION_SQL (rejecting a legacy review item). It removes a link
    // row and writes no column. Its rows are address_missing links, written by the
    // email sweep (code-read: autoLinkSql.ts email_id rows); no text-shaped writer
    // found. Driven here on an email message's link; the email keeps column A and is
    // outside v77 by design (emails are not texts).
    const eLink = db.prepare("SELECT id FROM communications WHERE message_id = 'e-auto'").get() as { id: string };
    db.prepare("UPDATE communications SET match_reason = 'address_missing' WHERE id = ?").run(eLink.id);
    expect(rejectReviewItemsSync([`legacy:${eLink.id}`]).rejected).toBe(1);
    expect(take()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM communications WHERE message_id = 'e-auto'").get()).toEqual({ n: 0 });
    expect(orphans()).toEqual([]);

    // v76 setter + v76 clear, then the v77 setter, on states written for them.
    text(db, "t-v76", "2026-03-04T00:00:00.000Z", "th-3983-v76", PHONE2);
    link(db, "c-v76", A, "t-v76", "2026-01-01 00:00:00");
    text(db, "t-v76g", "2026-03-05T00:00:00.000Z", "th-3983-v76g", PHONE2);
    text(db, "t-v77", "2026-03-06T00:00:00.000Z", "th-3983-v77", PHONE2);
    db.pragma("foreign_keys = OFF");
    link(db, "c-v76g", "tx-gone", "t-v76g", "2026-01-01 00:00:00");
    db.prepare("UPDATE messages SET transaction_id = ? WHERE id = 't-v77'").run(B);
    take();
    const run = (v: number): void => {
      const entry = chain(svc).find((m) => m.version === v)!;
      db.transaction(() => entry.migrate(db))();
    };
    run(76);
    expect(take()).toEqual([
      ["t-v76", null, A],
      ["t-v76g", null, "tx-gone"],
      ["t-v76g", "tx-gone", null],
    ]);
    expect(orphans()).toEqual(["t-v77"]);
    run(77);
    db.pragma("foreign_keys = ON");
    expect(take()).toEqual([["t-v77", B, null]]);
    expect(orphans()).toEqual([]);

    // FK ON DELETE SET NULL + REPOINT via deleteTransactionSync (deal delete).
    deleteTransactionSync(B);
    expect(take()).toEqual([
      ["t-man", B, null],
      ["t-man", null, null],
    ]);
    expect(orphans()).toEqual([]);

    // Every writer in C1's map ran at least once above.
    await svc.close();
  });
});
