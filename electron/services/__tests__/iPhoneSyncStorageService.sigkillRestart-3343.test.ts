/**
 * @jest-environment node
 *
 * BACKLOG-3343 — a REAL process death mid-sync, then a real relaunch.
 *
 * A child process opens a file-backed database with the real driver and the shipped
 * schema.sql, and writes one iPhone sync session's start through the PRODUCTION
 * modules: `iphoneSyncOpenSessionDbService.markStarted`, then 2 messages
 * (`syncDbService.batchInsertMessages`) and 1 attachment row + its file
 * (`syncDbService.insertAttachment`), all tagged with the session id. It prints
 * READY and blocks. The parent sends SIGKILL — no `finally`, no exit handler runs.
 *
 * The parent then opens the same file on a NEW connection, in a fresh module
 * registry, and runs the real `recoverInterruptedSessions()`.
 *
 * VACUITY GUARD: before the sweep, the parent asserts (on its own connection) that
 * the child's marker, rows and file are COMMITTED and present. A marker kept only in
 * memory, or left inside an uncommitted transaction at READY, fails there or after.
 *
 * Runs on the Node-ABI driver (`npm test` / CI). Locally with an Electron-ABI tree:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --runTestsByPath <this file>
 */

import * as os from "os";
import * as nodePath from "path";
import * as nodeFs from "fs";
import { spawn } from "child_process";
import type { Database as DatabaseType } from "better-sqlite3";

const mockUserData = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3343-kill-ud-"));
jest.mock("electron", () => ({ app: { getPath: jest.fn(() => mockUserData) } }));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const REPO_ROOT = nodePath.join(__dirname, "..", "..", "..");
const USER = "user-3343k";
const SESSION = "session-3343-killed";
const DONE = "session-3343-kept";

function loadDriver(): (new (file: string, opts?: object) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(nodePath.join(REPO_ROOT, "node_modules", "better-sqlite3-multiple-ciphers"));
    const probe = new Database(":memory:");
    probe.close();
    return Database;
  } catch (error) {
    if (process.env.CI) {
      throw new Error(`[3343] real sqlite driver must load on CI: ${String(error).slice(0, 200)}`);
    }
    process.stderr.write(
      `[3343] real sqlite driver unavailable under this runtime (${String(error).slice(0, 80)}); ` +
        "run under ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js\n",
    );
    return null;
  }
}
const Driver = loadDriver();
const maybe = Driver ? describe : describe.skip;

// The child bypasses jest's moduleNameMapper, so it makes the same two substitutions
// jest makes for every test ('electron', '@sentry/electron*'); see the 2548 suite
// (auditLogTriggerAtomicity-2548) for why both are needed under plain node in CI.
const CHILD_SOURCE = `
const Module = require('module');
const path = require('path');
const fs = require('fs');
const [REPO, DB_PATH, USER_DATA, USER, SESSION] = process.argv.slice(2);
const noop = () => undefined;
const SENTRY_STUB = {
  captureException: noop, captureMessage: noop, init: noop, setTag: noop,
  setUser: noop, addBreadcrumb: noop, flush: () => Promise.resolve(true),
  withScope: (cb) => cb({ setTag: noop, setExtra: noop }),
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getAppPath: () => REPO, getPath: () => USER_DATA } };
  if (request === '@sentry/electron' || request.indexOf('@sentry/electron/') === 0) return SENTRY_STUB;
  return origLoad.apply(this, arguments);
};
require(path.join(REPO, 'node_modules', 'ts-node')).register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true },
});
const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3-multiple-ciphers'));
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
const dbConnection = require(path.join(REPO, 'electron/services/db/core/dbConnection.ts'));
const openSessions = require(path.join(REPO, 'electron/services/db/iphoneSyncOpenSessionDbService.ts'));
const syncDb = require(path.join(REPO, 'electron/services/db/syncDbService.ts'));
dbConnection.setDb(db);

openSessions.markStarted(USER, SESSION);
const msg = (n) => ({
  id: 'msg-killed-' + n, userId: USER, channel: 'sms', externalId: 'killed-' + n, direction: 'inbound',
  bodyText: 'text ' + n, participants: JSON.stringify({ from: '+15555550199', to: ['me'] }),
  participantsFlat: '5555550199,me', threadId: 'th-killed', sentAt: '2024-01-01T10:00:0' + n + '.000Z',
  hasAttachments: n === 1 ? 1 : 0, messageType: null, metadata: null,
});
const stored = syncDb.batchInsertMessages([msg(1), msg(2)], 500, SESSION);
const attDir = path.join(USER_DATA, 'message-attachments');
fs.mkdirSync(attDir, { recursive: true });
const attFile = path.join(attDir, 'killed.jpg');
fs.writeFileSync(attFile, 'x');
syncDb.insertAttachment({
  id: 'att-killed', messageId: 'msg-killed-1', externalMessageId: 'killed-1', filename: 'IMG.jpg',
  mimeType: 'image/jpeg', fileSizeBytes: 1, storagePath: attFile, sessionId: SESSION,
});
process.stdout.write('READY ' + JSON.stringify({ stored: stored.stored, attFile }) + '\\n');
setInterval(() => {}, 1000);
`;

let tmp: string;
let childPath: string;

interface Killed {
  ready: { stored: number; attFile: string };
  signal: NodeJS.Signals | null;
  stderr: string;
}

function runAndKill(dbPath: string): Promise<Killed> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childPath, REPO_ROOT, dbPath, mockUserData, USER, SESSION], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TS_NODE_TRANSPILE_ONLY: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let ready: Killed["ready"] | null = null;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child never printed READY.\n  stdout: ${out}\n  stderr: ${err}`));
    }, 110_000);
    child.stdout.on("data", (d) => {
      out += String(d);
      const m = /READY (\{.*\})/.exec(out);
      if (m && !ready) {
        ready = JSON.parse(m[1]);
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("exit", (_code, signal) => {
      clearTimeout(timer);
      if (!ready) return reject(new Error(`child exited before READY (signal ${signal}).\n  stderr: ${err}`));
      resolve({ ready, signal, stderr: err });
    });
  });
}

beforeAll(() => {
  tmp = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3343-kill-"));
  childPath = nodePath.join(tmp, "syncChild.js");
  nodeFs.writeFileSync(childPath, CHILD_SOURCE, "utf8");
});
afterAll(() => {
  nodeFs.rmSync(tmp, { recursive: true, force: true });
  nodeFs.rmSync(mockUserData, { recursive: true, force: true });
});

maybe("BACKLOG-3343 SIGKILL mid-sync, then relaunch", () => {
  jest.setTimeout(150_000);

  it("the next launch removes the killed session's rows, attachment file and marker, and nothing else", async () => {
    const dbPath = nodePath.join(tmp, "mad.db");
    const setup = new Driver!(dbPath) as DatabaseType;
    setup.pragma("journal_mode = WAL");
    setup.pragma("foreign_keys = ON");
    setup.exec(nodeFs.readFileSync(nodePath.join(REPO_ROOT, "electron", "database", "schema.sql"), "utf8"));
    setup.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
      USER,
      "u3343k@example.test",
      "oauth-3343k",
    );
    // An unrelated FINISHED session (no marker) that must survive the sweep.
    setup
      .prepare(
        `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, participants_flat, thread_id, sent_at, sync_session_id)
         VALUES ('msg-kept', ?, 'sms', 'kept-1', 'inbound', 'kept', '{}', 'x', 'th-kept', '2024-01-02T00:00:00.000Z', ?)`,
      )
      .run(USER, DONE);
    setup.close();

    const killed = await runAndKill(dbPath);
    expect(killed.ready.stored).toBe(2);

    // A new process: a fresh connection to the file and a fresh module registry.
    const conn = new Driver!(dbPath) as DatabaseType;
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = ON");
    const ids = (q: string, ...a: string[]) =>
      (conn.prepare(q).all(...a) as Array<{ id: string }>).map((r) => r.id).sort();
    const state = () => ({
      markers: ids("SELECT session_id AS id FROM iphone_sync_open_sessions"),
      messages: ids("SELECT external_id AS id FROM messages WHERE sync_session_id = ?", SESSION),
      attachments: ids("SELECT id FROM attachments WHERE sync_session_id = ?", SESSION),
      kept: ids("SELECT external_id AS id FROM messages WHERE sync_session_id = ?", DONE),
      file: nodeFs.existsSync(killed.ready.attFile),
    });

    try {
      // Vacuity guard: the killed child's work is committed and visible to a new process.
      expect(state()).toEqual({
        markers: [SESSION],
        messages: ["killed-1", "killed-2"],
        attachments: ["att-killed"],
        kept: ["kept-1"],
        file: true,
      });

      let svc!: { recoverInterruptedSessions: () => Promise<{ found: number; recovered: number }> };
      jest.isolateModules(() => {
        /* eslint-disable @typescript-eslint/no-require-imports */
        require("../db/core/dbConnection").setDb(conn);
        svc = require("../iPhoneSyncStorageService").iPhoneSyncStorageService;
        /* eslint-enable @typescript-eslint/no-require-imports */
      });
      const r = await svc.recoverInterruptedSessions();

      expect(r).toEqual(expect.objectContaining({ found: 1, recovered: 1 }));
      expect(state()).toEqual({ markers: [], messages: [], attachments: [], kept: ["kept-1"], file: false });
    } finally {
      conn.close();
    }
  });
});
