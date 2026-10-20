/**
 * @jest-environment node
 *
 * BACKLOG-3063: the Mac importer's chat-roster query (MACOS_CHAT_MEMBER_HANDLES_SQL)
 * and own-account query (MACOS_CHAT_ACCOUNT_LOGINS_SQL), observed through the
 * `participants` JSON and `participants_flat` column that importMessages writes.
 *
 * Real-driver suite: `sqlite3` resolves to the real driver (the jest stub returns []
 * for every query, which would make this vacuous). Run with
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 <file>
 *
 * Fixture provenance. Schema of chat / handle / chat_handle_join (the columns the
 * two queries read) is transcribed from the REAL chat.db CHECK (macOS 15.7.3),
 * pm_comments 4691c96a on BACKLOG-3063: chat.ROWID and handle.ROWID
 * INTEGER PRIMARY KEY, chat.account_login TEXT, handle.id TEXT NOT NULL,
 * chat_handle_join(chat_id, handle_id) INTEGER. The fixture uses the implicit rowid
 * for handle.ROWID, which reads the same. On that machine account_login is only
 * 'P:' or 'E:' prefixed (no NULL, no empty, no other prefix) and no join row dangles.
 * SYNTHETIC: the chat layout and the NULL account_login case. NULL does not occur in
 * the real check; it is kept as defensive coverage of the "me" fallback.
 * The message/attachment table columns come from the importer's own SQL, as in
 * groupChatNames-2814.
 */
import * as os from "os";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as nodePath from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let mockDb: DatabaseType;

jest.mock("os", () => ({
  ...jest.requireActual("os"),
  platform: () => "darwin",
}));

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: { getRawDatabase: () => mockDb },
}));
jest.mock("../permissionService", () => ({
  __esModule: true,
  default: { checkFullDiskAccess: jest.fn(async () => ({ hasPermission: true })) },
}));
jest.mock("../../utils/messageParser", () => ({
  __esModule: true,
  getMessageText: jest.fn(async () => "message text"),
}));
jest.mock("cli-progress", () => ({
  __esModule: true,
  default: {
    SingleBar: jest.fn().mockImplementation(() => ({
      start: jest.fn(), update: jest.fn(), increment: jest.fn(), stop: jest.fn(),
    })),
    Presets: { shades_classic: {} },
  },
}));
jest.mock("../auditService", () => ({
  __esModule: true,
  default: {
    suspendPeriodicSync: jest.fn(() => false),
    resumePeriodicSync: jest.fn(),
    isSyncInFlight: jest.fn(() => false),
  },
}));
jest.mock("../submissionSyncService", () => ({
  __esModule: true,
  default: { pauseRealtime: jest.fn(), resumeRealtime: jest.fn() },
}));

// DELIBERATELY NOT MOCKED: `sqlite3` resolves to the REAL driver by absolute
// path. See the header — against jest.config's stub this suite is vacuous.
jest.mock("sqlite3", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(
    require("path").join(__dirname, "..", "..", "..", "node_modules", "sqlite3"),
  ),
);

import { app } from "electron";
import macOSMessagesImportService from "../macOSMessagesImportService";
import { testImportPlan } from "./helpers/importPlanFixture";
import type { MacOSImportResult } from "../macOSMessagesImportService/types";


const USER = "user-roster-3063";
const OWN_PHONE = "+15550199";
const OWN_EMAIL = "me@example.com";
const H = ["+15550100", "+15550101", "+15550102", "+15550103", "pat@example.com"]; // handle ROWIDs 1..5

let homeDir: string;
let scratchDir: string;
let realHome: string | undefined;
let sourceDbPath: string;

interface SeedOpts { members: boolean; logins: boolean }

/**
 *   chat 1 — GROUP of 3 (h1,h2,h3), account_login 'P:+15550199'
 *   chat 2 — 1:1 (h4),               account_login 'E:me@example.com'
 *   chat 3 — GROUP of 3 (h1,h2,h5 = an email handle), account_login NULL
 * Each chat: one inbound (from its first handle) and one outbound message.
 */
function createSourceDb(path: string, opts: SeedOpts): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE message (
      guid TEXT, text TEXT, attributedBody BLOB, date INTEGER,
      is_from_me INTEGER, handle_id INTEGER, service TEXT,
      cache_has_attachments INTEGER, associated_message_type INTEGER,
      associated_message_guid TEXT
    );
    CREATE TABLE handle (id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, account_login TEXT, display_name TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (
      guid TEXT, filename TEXT, mime_type TEXT, transfer_name TEXT,
      total_bytes INTEGER, is_outgoing INTEGER
    );
    CREATE TABLE message_attachment_join (attachment_id INTEGER, message_id INTEGER);
  `);
  const insH = db.prepare("INSERT INTO handle (id) VALUES (?)");
  for (const h of H) insH.run(h);
  const insC = db.prepare("INSERT INTO chat (ROWID, account_login, display_name) VALUES (?, ?, '')");
  insC.run(1, opts.logins ? `P:${OWN_PHONE}` : null);
  insC.run(2, opts.logins ? `E:${OWN_EMAIL}` : null);
  insC.run(3, null);
  if (opts.members) {
    const j = db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)");
    for (const [c, h] of [[1, 1], [1, 2], [1, 3], [2, 4], [3, 1], [3, 2], [3, 5]]) j.run(c, h);
  }
  const insM = db.prepare(`INSERT INTO message (guid, text, attributedBody, date, is_from_me, handle_id,
    service, cache_has_attachments, associated_message_type, associated_message_guid)
    VALUES (?, 'x', NULL, ?, ?, ?, 'iMessage', 0, NULL, NULL)`);
  const jm = db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)");
  let row = 0;
  for (const [chat, firstHandle] of [[1, 1], [2, 4], [3, 1]]) {
    row++; insM.run(`g-c${chat}-in`, 700000000 * 1e9 + row, 0, firstHandle); jm.run(chat, row);
    // Apple: an outbound GROUP message carries handle_id 0; a 1:1 carries the peer.
    row++; insM.run(`g-c${chat}-out`, 700000000 * 1e9 + row, 1, chat === 2 ? 4 : 0); jm.run(chat, row);
  }
  db.close();
}

function createStoreSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel TEXT, external_id TEXT,
      direction TEXT, body_text TEXT, participants TEXT, participants_flat TEXT,
      thread_id TEXT, sent_at DATETIME, has_attachments INTEGER DEFAULT 0,
      message_type TEXT, metadata TEXT, associated_message_type INTEGER,
      associated_message_guid TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, message_id TEXT, external_message_id TEXT, filename TEXT,
      mime_type TEXT, file_size_bytes INTEGER, storage_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE message_thread_names (
      user_id TEXT NOT NULL, thread_id TEXT NOT NULL, display_name TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, thread_id)
    );
  `);
}

type P = { from: string; to: string[]; chat_members?: string[] };
function participantsByGuid(): Record<string, P> {
  const rows = mockDb.prepare("SELECT external_id, participants FROM messages").all() as
    Array<{ external_id: string; participants: string }>;
  const out: Record<string, P> = {};
  for (const r of rows) {
    const p = JSON.parse(r.participants) as P;
    if (p.chat_members) p.chat_members = [...p.chat_members].sort();
    out[r.external_id] = p;
  }
  return out;
}

/** participants_flat as a sorted list of comma-separated segments (phone-search index). */
function flatByGuid(): Record<string, string[]> {
  const rows = mockDb.prepare("SELECT external_id, participants_flat FROM messages").all() as
    Array<{ external_id: string; participants_flat: string }>;
  return Object.fromEntries(rows.map((r) => [r.external_id, r.participants_flat.split(",").sort()]));
}

function runImport(): Promise<MacOSImportResult> {
  return macOSMessagesImportService.importMessages(
    USER, undefined,
    testImportPlan({ mode: "delta", storedFilters: { lookbackMonths: null, maxMessages: null } }),
  );
}

async function setup(opts: SeedOpts): Promise<void> {
  mockDb = new Database(":memory:");
  createStoreSchema(mockDb);
  homeDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-3063-home-"));
  scratchDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-3063-app-"));
  await fs.mkdir(nodePath.join(homeDir, "Library", "Messages"), { recursive: true });
  sourceDbPath = nodePath.join(homeDir, "Library", "Messages", "chat.db");
  createSourceDb(sourceDbPath, opts);
  realHome = process.env.HOME;
  process.env.HOME = homeDir;
  (app.getPath as jest.Mock).mockImplementation((name: string) =>
    name === "userData" ? scratchDir : `/tmp/test-${name}`,
  );
  jest.spyOn(fsSync.promises, "statfs").mockResolvedValue({
    type: 26, bsize: 4096, blocks: 1e9, bfree: 5e7, bavail: 5e7, files: 10, ffree: 10,
  } as fsSync.StatsFs);
}

afterEach(async () => {
  jest.restoreAllMocks();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  mockDb?.close();
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.rm(scratchDir, { recursive: true, force: true });
});

describe("BACKLOG-3063 — chat roster + account_login reach participants", () => {
  it("MEMBERS: each group's chat_members and participants_flat are exactly its chat_handle_join set; a 1:1 has no chat_members", async () => {
    await setup({ members: true, logins: true });
    const r = await runImport();
    expect(r.success).toBe(true);
    expect(r.messagesImported).toBe(6);
    const p = participantsByGuid();
    const members = Object.fromEntries(Object.entries(p).map(([g, v]) => [g, v.chat_members ?? null]));
    expect(members).toEqual({
      "g-c1-in": [H[0], H[1], H[2]], "g-c1-out": [H[0], H[1], H[2]],
      "g-c2-in": null, "g-c2-out": null,
      "g-c3-in": [H[0], H[1], H[4]], "g-c3-out": [H[0], H[1], H[4]],
    });

    // participants_flat is the phone-search index: digits of from and to (never "me"),
    // then every roster member, no dedupe (importer lines 1688-1705). Sorted segments.
    // The "" segments are CURRENT behaviour pinned on purpose: an outbound group message
    // has handle_id 0, which the importer sanitises to "unknown" (no digits), and an
    // email member (pat@example.com) has no digits either. Not fixed here.
    const flat = flatByGuid();
    expect({ in: flat["g-c1-in"], out: flat["g-c1-out"] }).toEqual({
      in: ["15550100", "15550100", "15550101", "15550102", "15550199"],
      out: ["", "15550100", "15550101", "15550102", "15550199"],
    });
    expect({ in: flat["g-c3-in"], out: flat["g-c3-out"] }).toEqual({
      in: ["", "15550100", "15550100", "15550101"],
      out: ["", "", "15550100", "15550101"],
    });
  });

  it("ACCOUNT LOGIN: own side is the prefix-stripped account_login, 'me' only where it is NULL", async () => {
    await setup({ members: true, logins: true });
    await runImport();
    const p = participantsByGuid();
    const own = Object.fromEntries(Object.entries(p).map(([g, v]) => [g, g.endsWith("-out") ? v.from : v.to]));
    expect(own).toEqual({
      "g-c1-in": [OWN_PHONE], "g-c1-out": OWN_PHONE,
      "g-c2-in": [OWN_EMAIL], "g-c2-out": OWN_EMAIL,
      "g-c3-in": ["me"], "g-c3-out": "me",
    });
  });

  it("GENUINELY EMPTY: no roster rows and no logins -> no chat_members anywhere, own side 'me'", async () => {
    await setup({ members: false, logins: false });
    const r = await runImport();
    expect(r.success).toBe(true);
    expect(r.messagesImported).toBe(6);
    const p = participantsByGuid();
    for (const v of Object.values(p)) expect(v.chat_members).toBeUndefined();
    expect(p["g-c1-in"].to).toEqual(["me"]);
    expect(p["g-c1-out"].from).toBe("me");
  });
});
