/**
 * @jest-environment node
 *
 * BACKLOG-4212 PR3 — learn:list-suppressed / learn:set-override on the REAL
 * driver and the REAL schema.sql. Answers go through the production writers
 * (insertBulkSample / answerBulk / softClearAnswersAndStopSharing); cached
 * mail through the sync's own insert. Synthetic reserved domains only.
 *
 *   H1  list: senders at or above N, with answer counts; hidden = buildUserSuppress
 *   H2  Stop hiding / Hide again flip the row and the scan list (round trip)
 *   H3  two users: another user's Stop hiding never un-hides this user's sender
 *   H4  the key is normalised with fromAddress(): "Name <Mixed@Case>" is the stored sender
 *   H5  the user id comes from the session; a payload user id is ignored / refused
 *   H6  strict schema: an extra field is refused and writes nothing
 *   H7  Stop hiding for a sender not on the list is refused
 *   H8  "Delete my answers" (PR2's clear) empties the list and clears overrides
 *   H9  no session: both channels refuse
 */
import fs from "fs";
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
const logCalls: unknown[][] = [];
jest.mock("../../services/logService", () => {
  const rec = jest.fn((...a: unknown[]) => {
    logCalls.push(a);
    return Promise.resolve();
  });
  return { __esModule: true, default: { info: rec, warn: rec, error: rec, debug: rec } };
});
let sessionUser: string | null = null;
jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: { loadSession: jest.fn(async () => (sessionUser ? { user: { id: sessionUser } } : null)) },
}));
jest.mock("../../services/senderRuleSetStore", () => {
  const { BUNDLED_SENDER_RULES } = jest.requireActual("../../utils/senderFilter/bundledRules");
  return { getActiveSenderRules: () => ({ rules: BUNDLED_SENDER_RULES }) };
});
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

import { setDb } from "../../services/db/core/dbConnection";
import { answerBulk, insertBulkSample, softClearAnswersAndStopSharing } from "../../services/db/learnModeDbService";
import { buildUserSuppress } from "../../services/userSuppressService";
import { BUNDLED_SENDER_RULES } from "../../utils/senderFilter/bundledRules";
import { gmailFrom, insertStoredEmail } from "../../services/__tests__/helpers/storedEmail-4175";
import { LEARN_SUPPRESS_CHANNELS, registerLearnSuppressHandlers } from "../learnSuppressHandlers";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");
const USER = "user-4212-h";
const OTHER = "user-4212-h-other";
const NEWS = "news@mail.example";
const MIXED = gmailFrom("Digest", "News@Mail.Example");
const PROMO = "promo@offers.example";

let db: DatabaseType;
let seq = 0;

function mail(sender: string, user: string): string {
  seq += 1;
  const id = `e-4212h-${seq}`;
  insertStoredEmail(db, { id, userId: user, sender, subject: "Weekly digest", bodyPlain: "Weekly digest", sentAt: "2026-03-01T15:00:00.000Z" });
  return id;
}

function newsletters(sender: string, n: number, user = USER): void {
  for (let i = 0; i < n; i++) {
    const emailId = mail(sender, user);
    insertBulkSample(user, [{ source: "gmail", external_id: `ext-${emailId}` }], 1);
    const r = db
      .prepare(`SELECT id FROM learn_bulk_answers WHERE user_id = ? AND external_id = ? AND deleted_at IS NULL`)
      .get(user, `ext-${emailId}`) as { id: string };
    expect(answerBulk(user, r.id, "newsletter_spam")).toBe(true);
  }
}

type Reply = { success: boolean; error?: string; senders?: Array<{ senderKey: string; newsletterCount: number; hidden: boolean }>; hidden?: boolean };
async function invoke(channel: string, payload?: unknown, as: string | null = USER): Promise<Reply> {
  sessionUser = as;
  const h = ipcHandlers.get(channel);
  if (!h) throw new Error(`no handler ${channel}`);
  return (await (payload === undefined ? h({}) : h({}, payload))) as Reply;
}
const listOf = async (as: string = USER) => (await invoke("learn:list-suppressed", undefined, as)).senders;
const liveOverrides = (user: string) =>
  (db.prepare(`SELECT sender_key FROM learn_sender_overrides WHERE user_id = ? AND deleted_at IS NULL`).all(user) as Array<{ sender_key: string }>).map(
    (r) => r.sender_key,
  );
const scanList = (user = USER) => [...buildUserSuppress(user, BUNDLED_SENDER_RULES)].sort();

beforeAll(() => {
  registerLearnSuppressHandlers();
});

beforeEach(() => {
  seq = 0;
  logCalls.length = 0;
  db = new Database(":memory:") as DatabaseType;
  setDb(db);
  db.exec(SCHEMA);
  const u = db.prepare(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)`);
  u.run(USER, "me@example.test", "o-1");
  u.run(OTHER, "them@example.test", "o-2");
});

afterEach(() => db.close());

describe("channels", () => {
  it("registers exactly the two channels", () => {
    expect([...ipcHandlers.keys()].sort()).toEqual([...LEARN_SUPPRESS_CHANNELS].sort());
  });
});

describe("H1 list", () => {
  it("lists senders at N = 2 with counts; one answer is not listed; hidden rows equal the scan list", async () => {
    newsletters(NEWS, 3);
    newsletters(PROMO, 1);
    expect(await listOf()).toEqual([{ senderKey: NEWS, newsletterCount: 3, hidden: true }]);
    expect(scanList()).toEqual([NEWS]);
  });
  it("logs counts only, never an address", async () => {
    newsletters(NEWS, 2);
    await listOf();
    expect(JSON.stringify(logCalls)).not.toContain("mail.example");
    expect(logCalls.length).toBeGreaterThan(0);
  });
});

describe("H2 toggle round trip", () => {
  it("Stop hiding un-hides (row stays, hidden=false; scan list empty); Hide again re-hides", async () => {
    newsletters(NEWS, 2);
    expect(await invoke("learn:set-override", { senderKey: NEWS, hide: false })).toEqual({ success: true, hidden: false });
    expect(await listOf()).toEqual([{ senderKey: NEWS, newsletterCount: 2, hidden: false }]);
    expect(scanList()).toEqual([]);
    // A repeat Stop hiding keeps one live row.
    await invoke("learn:set-override", { senderKey: NEWS, hide: false });
    expect(liveOverrides(USER)).toEqual([NEWS]);

    expect(await invoke("learn:set-override", { senderKey: NEWS, hide: true })).toEqual({ success: true, hidden: true });
    expect(await listOf()).toEqual([{ senderKey: NEWS, newsletterCount: 2, hidden: true }]);
    expect(scanList()).toEqual([NEWS]);
    expect(liveOverrides(USER)).toEqual([]);
  });
});

describe("H3 two users (PR2 carry-over)", () => {
  it("OTHER's Stop hiding leaves USER's sender hidden, in the scan list and in Settings", async () => {
    newsletters(NEWS, 2, USER);
    newsletters(NEWS, 2, OTHER);
    expect(await invoke("learn:set-override", { senderKey: NEWS, hide: false }, OTHER)).toEqual({ success: true, hidden: false });
    expect(liveOverrides(OTHER)).toEqual([NEWS]);
    expect(liveOverrides(USER)).toEqual([]);
    expect(scanList(OTHER)).toEqual([]);
    expect(scanList(USER)).toEqual([NEWS]);
    expect(await listOf(USER)).toEqual([{ senderKey: NEWS, newsletterCount: 2, hidden: true }]);
  });
});

describe("H4 key normalisation (PR2 carry-over)", () => {
  it("a mixed-case display-name key matches the stored sender and un-hides it", async () => {
    newsletters(MIXED, 2);
    expect(scanList()).toEqual([NEWS]);
    expect(await invoke("learn:set-override", { senderKey: "Digest <News@Mail.Example>", hide: false })).toEqual({
      success: true,
      hidden: false,
    });
    expect(liveOverrides(USER)).toEqual([NEWS]);
    expect(scanList()).toEqual([]);
  });
  it("a key that parses to no address is refused", async () => {
    newsletters(NEWS, 2);
    expect((await invoke("learn:set-override", { senderKey: "not an address", hide: false })).success).toBe(false);
    expect(liveOverrides(USER)).toEqual([]);
  });
});

describe("H5 the user id comes from the session", () => {
  it("list-suppressed ignores a payload user id", async () => {
    newsletters(NEWS, 2, OTHER);
    expect(await invoke("learn:list-suppressed", { userId: OTHER }, USER)).toEqual({ success: true, senders: [] });
  });
  it("set-override with a payload user id is refused and writes nothing for either user", async () => {
    newsletters(NEWS, 2, OTHER);
    newsletters(NEWS, 2, USER);
    const r = await invoke("learn:set-override", { senderKey: NEWS, hide: false, userId: OTHER }, USER);
    expect(r.success).toBe(false);
    expect(liveOverrides(OTHER)).toEqual([]);
    expect(liveOverrides(USER)).toEqual([]);
  });
});

describe("H6 strict schema", () => {
  it("an extra field is refused; a wrong type is refused; nothing is written", async () => {
    newsletters(NEWS, 2);
    expect(await invoke("learn:set-override", { senderKey: NEWS, hide: false, extra: 1 })).toEqual({
      success: false,
      error: "Invalid request.",
    });
    expect((await invoke("learn:set-override", { senderKey: NEWS, hide: "no" })).success).toBe(false);
    expect((await invoke("learn:set-override", { senderKey: NEWS })).success).toBe(false);
    expect(liveOverrides(USER)).toEqual([]);
  });
});

describe("H7 only listed senders", () => {
  it("Stop hiding for a sender below N is refused", async () => {
    newsletters(PROMO, 1);
    expect(await invoke("learn:set-override", { senderKey: PROMO, hide: false })).toEqual({
      success: false,
      error: "That sender is not on your list.",
    });
    expect(liveOverrides(USER)).toEqual([]);
  });
});

describe("H8 Delete my answers", () => {
  it("empties the list and soft-removes the overrides", async () => {
    newsletters(NEWS, 2);
    newsletters(PROMO, 2);
    await invoke("learn:set-override", { senderKey: PROMO, hide: false });
    expect((await listOf())?.length).toBe(2);
    softClearAnswersAndStopSharing(USER);
    expect(await listOf()).toEqual([]);
    expect(liveOverrides(USER)).toEqual([]);
    expect(scanList()).toEqual([]);
  });
});

describe("H9 no session", () => {
  it("both channels refuse", async () => {
    expect((await invoke("learn:list-suppressed", undefined, null)).success).toBe(false);
    expect((await invoke("learn:set-override", { senderKey: NEWS, hide: false }, null)).success).toBe(false);
  });
});
