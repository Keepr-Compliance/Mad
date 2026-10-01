/**
 * @jest-environment node
 */
/**
 * BACKLOG-3658 P3b — consent + cache options (rcs_consent) and the optional
 * auto-delete of old chats linked to nothing, on the REAL production schema
 * (run under Electron's Node locally).
 *
 * Mutation controls (each turns a test red):
 *   K4 consent writes not scoped to the user                → "each user's consent is their own"
 *   K5 withdrawing also resets the options                  → "withdrawing keeps the options"
 *   A1 auto-delete touches a chat linked to a transaction   → "linked chats are kept"
 *   A2 auto-delete ignores the age (deletes a recent chat)   → "a recent unlinked chat is kept"
 *   A3 auto-delete reaches another user or another source    → "only this user's gmweb2 chats"
 *   A4 a shared image file deleted                           → "an image file another row uses is kept"
 */

import * as nodePath from "path";
import * as fs from "fs";
import * as os from "os";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { setDb } from "../db/core/dbConnection";
import { getRcsConsent, rcsAutoDeleteDbOps, setRcsCacheOptions, setRcsConsent } from "../db/syncDbService";
import { clearUnlinkedOldChats, type RcsClearFs } from "../rcsClearService";

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3658k";
const OTHER = "user-3658k-b";
const CUTOFF = "2026-07-03T00:00:00.000Z";

let db: DatabaseType;
let tmp: string;
let attachmentsRoot: string;

const count = (q: string, ...p: unknown[]): number => (db.prepare(q).get(...p) as { n: number }).n;

function msg(id: string, user: string, thread: string, sentAt: string, opts: { source?: string; reaction?: boolean } = {}): void {
  const ext = opts.source === "android" ? `android-${id}` : `gmweb2:${thread}:${id}`;
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, participants, thread_id, sent_at, metadata,
       associated_message_type, associated_message_guid)
     VALUES (?, ?, 'sms', ?, 'inbound', 'x', '{"from":"+15555550101","to":["me"]}', ?, ?, '{}', ?, ?)`,
  ).run(id, user, ext, thread, sentAt, opts.reaction ? 2001 : null, opts.reaction ? `gmweb2:${thread}:m` : null);
}

function files(): RcsClearFs {
  return {
    attachmentsRoot,
    resolve: (p) => (nodePath.isAbsolute(p) ? p : nodePath.join(tmp, p)),
    deleteFile: (abs) => {
      try {
        fs.unlinkSync(abs);
        return true;
      } catch {
        return false;
      }
    },
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rcs-consent-3658-"));
  attachmentsRoot = nodePath.join(tmp, "message-attachments");
  fs.mkdirSync(attachmentsRoot);
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(PRODUCTION_SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  for (const [u, n] of [[USER, "a"], [OTHER, "b"]]) {
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
      u, `agent-3658k-${n}@example.test`, `oauth-3658k-${n}`,
    );
  }
  db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES ('tx-a', ?, '1 Test Street')").run(USER);
  setDb(db);
});

afterEach(() => {
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("rcs_consent (P3b)", () => {
  it("each user's consent is their own; none means null (K4)", () => {
    expect(getRcsConsent(USER)).toBeNull();
    setRcsConsent(USER, 1, "2026-10-01T10:00:00.000Z");
    expect(getRcsConsent(USER)).toEqual({ consentAt: "2026-10-01T10:00:00.000Z", consentVersion: 1, contactsOnly: false, autoDeleteDays: null });
    expect(getRcsConsent(OTHER)).toBeNull();
  });

  it("withdrawing keeps the options (K5)", () => {
    setRcsConsent(USER, 1, "2026-10-01T10:00:00.000Z");
    setRcsCacheOptions(USER, { autoDeleteDays: 90, contactsOnly: true });
    setRcsConsent(USER, null, "2026-10-02T10:00:00.000Z");
    expect(getRcsConsent(USER)).toEqual({ consentAt: null, consentVersion: null, contactsOnly: true, autoDeleteDays: 90 });
    setRcsCacheOptions(USER, { autoDeleteDays: null });
    expect(getRcsConsent(USER)?.autoDeleteDays).toBeNull();
  });
});

describe("auto-delete of old chats linked to nothing (P3b, off by default)", () => {
  beforeEach(() => {
    // t-old: unlinked, last message before the cutoff → deleted (with its reaction).
    msg("o1", USER, "gmweb2-old", "2026-05-01T10:00:00.000Z");
    msg("o2", USER, "gmweb2-old", "2026-06-01T10:00:00.000Z");
    msg("o3", USER, "gmweb2-old", "2026-06-01T10:01:00.000Z", { reaction: true });
    // t-recent: unlinked but its last message is recent → kept.
    msg("r1", USER, "gmweb2-recent", "2026-05-01T10:00:00.000Z");
    msg("r2", USER, "gmweb2-recent", "2026-09-20T10:00:00.000Z");
    // t-thread: old but thread-linked; t-msg: old but one message linked.
    msg("l1", USER, "gmweb2-thread", "2026-05-01T10:00:00.000Z");
    msg("l2", USER, "gmweb2-msg", "2026-05-01T10:00:00.000Z");
    db.prepare("INSERT INTO communications (id, user_id, transaction_id, thread_id) VALUES ('c1', ?, 'tx-a', 'gmweb2-thread')").run(USER);
    db.prepare("INSERT INTO communications (id, user_id, transaction_id, message_id) VALUES ('c2', ?, 'tx-a', 'l2')").run(USER);
    // Another user's old unlinked gmweb2 chat, and this user's old Android text.
    msg("x1", OTHER, "gmweb2-other", "2026-05-01T10:00:00.000Z");
    msg("a1", USER, "android-thread", "2026-05-01T10:00:00.000Z", { source: "android" });
  });

  const ids = () => (db.prepare("SELECT id FROM messages ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);

  it("deletes the old unlinked chat with its reactions; linked chats are kept (A1)", () => {
    const r = clearUnlinkedOldChats(USER, CUTOFF, rcsAutoDeleteDbOps(), files());
    expect(r).toMatchObject({ chats: 1, messages: 3 });
    expect(ids()).toEqual(["a1", "l1", "l2", "r1", "r2", "x1"]);
  });

  it("a recent unlinked chat is kept (A2)", () => {
    clearUnlinkedOldChats(USER, CUTOFF, rcsAutoDeleteDbOps(), files());
    expect(ids()).toContain("r1");
    expect(ids()).toContain("r2");
  });

  it("only this user's gmweb2 chats (A3)", () => {
    clearUnlinkedOldChats(USER, CUTOFF, rcsAutoDeleteDbOps(), files());
    expect(ids()).toContain("x1");
    expect(ids()).toContain("a1");
  });

  it("deletes the chat's image files, but an image file another row uses is kept (A4)", () => {
    const own = nodePath.join(attachmentsRoot, "own.png");
    const shared = nodePath.join(attachmentsRoot, "shared.png");
    fs.writeFileSync(own, "x");
    fs.writeFileSync(shared, "y");
    db.prepare("INSERT INTO attachments (id, message_id, filename, storage_path) VALUES ('at1', 'o1', 'a.png', ?), ('at2', 'o2', 'b.png', ?), ('at3', 'a1', 'c.png', ?)")
      .run(own, shared, shared);
    const r = clearUnlinkedOldChats(USER, CUTOFF, rcsAutoDeleteDbOps(), files());
    expect(r.filesDeleted).toBe(1);
    expect(fs.existsSync(own)).toBe(false);
    expect(fs.existsSync(shared)).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM attachments")).toBe(1);
  });
});
