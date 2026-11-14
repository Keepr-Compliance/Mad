/**
 * @jest-environment node
 *
 * BACKLOG-4212 PR2 — the per-user sender suppress list on the REAL driver and
 * the REAL schema.sql. Cached mail is written with the sync's own insert
 * (helpers/storedEmail-4175); Learn answers through the production writers
 * (insertBulkSample / answerBulk / softClearAnswersAndStopSharing).
 * Synthetic reserved domains only.
 *
 *   L1  N = 2 newsletter answers lists a sender; 1 does not
 *   L2  N comes from the active set when present (server 1 beats bundled 2); N = 0 lists nothing (M3)
 *   L3  one real_estate answer vetoes; skip answers never count (M5)
 *   L4  "Stop hiding" removes the sender; removing the override lists it again (M10)
 *   L5  the user's own addresses are never listed; another user's answers never count
 *   L6  a soft-removed answer stops counting (undo un-counts)
 *   A1  answerBulk snapshots the normalised sender with the answer; uncached = NULL; re-answer re-snapshots
 *   A2  answer and sender_key are one write: an injected failure leaves NO answer (M6)
 *   A3  "Delete my answers" soft-removes the overrides in the same transaction
 *   P1  the address pass drops a listed sender, counted as ruleSkipped (not seedSkipped)
 *   P2  ... even when no central signal is live on the address pass (M12, SR R4)
 */
import fs from "fs";
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";
import type { SenderRuleModes, SenderRuleSet, SenderRuleSignal } from "../../utils/senderFilter/bundledRules";

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
const logInfo = jest.fn().mockResolvedValue(undefined);
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    default: { info: (...a: unknown[]) => logInfo(...a), warn: noop, error: noop, debug: noop },
  };
});
let mockRules: SenderRuleSet | null = null;
jest.mock("../../utils/senderFilter/bundledRules", () => {
  const actual = jest.requireActual("../../utils/senderFilter/bundledRules");
  return {
    ...actual,
    get BUNDLED_SENDER_RULES() {
      return mockRules ?? actual.BUNDLED_SENDER_RULES;
    },
  };
});

import { setDb } from "../db/core/dbConnection";
import * as contactWorkerPool from "../../workers/contactWorkerPool";
import { BUNDLED_SENDER_RULES, USER_SUPPRESS_MIN_ANSWERS_DEFAULT } from "../../utils/senderFilter/bundledRules";
import { answerBulk, insertBulkSample, softClearAnswersAndStopSharing, softDeleteAnswer } from "../db/learnModeDbService";
import { buildUserSuppress } from "../userSuppressService";
import { queueAddressMatchesForTransaction } from "../reviewStateService";
import { gmailFrom, insertStoredEmail } from "./helpers/storedEmail-4175";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");
const USER = "user-4212";
const OTHER = "user-4212-other";
const TXN = "txn-4212";
const NEWS = "news@mail.example";
const BODY = "News about 1428 Maple Ave, Springfield: a new photo set is up.";

let db: DatabaseType;
let shipped: SenderRuleSet;
let seq = 0;

const withN = (n: number | undefined): SenderRuleSet => ({
  ...shipped,
  thresholds: n === undefined ? { ...shipped.thresholds } : { ...shipped.thresholds, userSuppressMinAnswers: n },
});

function rulesWith(modes: Partial<Record<SenderRuleSignal, Partial<SenderRuleModes>>>): SenderRuleSet {
  const next = { ...shipped.modes } as Record<SenderRuleSignal, SenderRuleModes>;
  for (const [s, m] of Object.entries(modes) as Array<[SenderRuleSignal, Partial<SenderRuleModes>]>) {
    next[s] = { ...next[s], ...m };
  }
  return { ...shipped, modes: next };
}

/** A cached message; returns its email id. */
function mail(sender: string, user = USER, body = "Weekly digest"): string {
  seq += 1;
  const id = `e-4212-${seq}`;
  insertStoredEmail(db, {
    id,
    userId: user,
    sender,
    subject: body === BODY ? "1428 Maple Ave update" : "Weekly digest",
    bodyPlain: body,
    sentAt: "2026-03-01T15:00:00.000Z",
  });
  return id;
}

/** Sample the message and answer it through the production writers; returns the sample row id. */
function answer(emailId: string, a: "real_estate" | "newsletter_spam" | "skip", user = USER): string {
  insertBulkSample(user, [{ source: "gmail", external_id: `ext-${emailId}` }], 1);
  const r = db
    .prepare(`SELECT id FROM learn_bulk_answers WHERE user_id = ? AND external_id = ? AND deleted_at IS NULL`)
    .get(user, `ext-${emailId}`) as { id: string };
  expect(answerBulk(user, r.id, a)).toBe(true);
  return r.id;
}

function newsletters(sender: string, n: number, user = USER): void {
  for (let i = 0; i < n; i++) answer(mail(sender, user), "newsletter_spam", user);
}

function override(sender: string, deletedAt: string | null = null): void {
  seq += 1;
  db.prepare(
    `INSERT INTO learn_sender_overrides (id, user_id, sender_key, created_at, updated_at, deleted_at) VALUES (?, ?, ?, 'x', 'x', ?)`,
  ).run(`ov-${seq}`, USER, sender, deletedAt);
}

const list = (rules: SenderRuleSet = shipped) => [...buildUserSuppress(USER, rules)].sort();

beforeAll(() => {
  shipped = BUNDLED_SENDER_RULES;
});

beforeEach(() => {
  mockRules = null;
  logInfo.mockClear();
  seq = 0;
  db = new Database(":memory:") as DatabaseType;
  setDb(db);
  db.exec(SCHEMA);
  const user = db.prepare(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)`);
  user.run(USER, "me@example.test", "o-1");
  user.run(OTHER, "them@example.test", "o-2");
});

afterEach(() => {
  jest.restoreAllMocks();
  db.close();
});

describe("L1 threshold N = 2 (bundled fallback)", () => {
  it("the shipped set has no threshold key; the fallback is 2", () => {
    expect(shipped.thresholds.userSuppressMinAnswers).toBeUndefined();
    expect(USER_SUPPRESS_MIN_ANSWERS_DEFAULT).toBe(2);
  });
  it("one newsletter answer: not listed; two: listed", () => {
    newsletters(NEWS, 1);
    expect(list()).toEqual([]);
    newsletters(NEWS, 1);
    expect(list()).toEqual([NEWS]);
  });
});

describe("L2 N from the active set", () => {
  it("a set with userSuppressMinAnswers = 1 lists after one answer (bundled would need 2)", () => {
    newsletters(NEWS, 1);
    expect(list(withN(1))).toEqual([NEWS]);
    expect(list(withN(undefined))).toEqual([]);
  });
  it("a set with userSuppressMinAnswers = 3 needs three", () => {
    newsletters(NEWS, 2);
    expect(list(withN(3))).toEqual([]);
  });
  it("N = 0 is off: nothing is listed", () => {
    newsletters(NEWS, 5);
    expect(list(withN(0))).toEqual([]);
    expect(list()).toEqual([NEWS]);
  });
});

describe("L3 what counts", () => {
  it("one real_estate answer for the sender vetoes, however many newsletter answers", () => {
    newsletters(NEWS, 4);
    answer(mail(NEWS), "real_estate");
    expect(list()).toEqual([]);
  });
  it("skip answers never count toward N", () => {
    newsletters(NEWS, 1);
    answer(mail(NEWS), "skip");
    answer(mail(NEWS), "skip");
    expect(list()).toEqual([]);
  });
});

describe("L4 Stop hiding", () => {
  it("a live override removes the sender; a soft-removed override does not", () => {
    newsletters(NEWS, 2);
    override(NEWS, "2026-11-01T00:00:00Z");
    expect(list()).toEqual([NEWS]);
    override(NEWS);
    expect(list()).toEqual([]);
  });
  it("removing the live override lists the sender again", () => {
    newsletters(NEWS, 2);
    override(NEWS);
    expect(list()).toEqual([]);
    db.prepare(`UPDATE learn_sender_overrides SET deleted_at = 'y' WHERE user_id = ? AND deleted_at IS NULL`).run(USER);
    expect(list()).toEqual([NEWS]);
  });
});

describe("L5 own addresses and other users", () => {
  it("the user's sign-in address and connected mailbox are never listed", () => {
    db.prepare(
      `INSERT INTO oauth_tokens (id, user_id, provider, purpose, connected_email_address) VALUES ('ot-1', ?, 'google', 'mailbox', ' Box@Mine.Example ')`,
    ).run(USER);
    newsletters("me@example.test", 2);
    newsletters("box@mine.example", 2);
    newsletters(NEWS, 2);
    expect(list()).toEqual([NEWS]);
  });
  it("another user's answers never list a sender for this user", () => {
    newsletters(NEWS, 3, OTHER);
    expect(list()).toEqual([]);
    expect([...buildUserSuppress(OTHER, shipped)]).toEqual([NEWS]);
  });
});

describe("L6 a removed answer stops counting", () => {
  it("soft-removing one of two answers un-lists the sender", () => {
    answer(mail(NEWS), "newsletter_spam");
    const id = answer(mail(NEWS), "newsletter_spam");
    expect(list()).toEqual([NEWS]);
    expect(softDeleteAnswer(USER, "bulk", id, 1)).toBe(true);
    expect(list()).toEqual([]);
  });
});

describe("A1 answerBulk snapshots the sender", () => {
  const key = (rowId: string) =>
    db.prepare(`SELECT answer, sender_key FROM learn_bulk_answers WHERE id = ?`).get(rowId) as {
      answer: string | null;
      sender_key: string | null;
    };
  it("the From header is normalised (display name dropped, lowercased)", () => {
    const id = answer(mail(gmailFrom("Digest", "News@Mail.Example")), "newsletter_spam");
    expect(key(id)).toEqual({ answer: "newsletter_spam", sender_key: NEWS });
  });
  it("an uncached message: answer saved, sender_key NULL", () => {
    insertBulkSample(USER, [{ source: "gmail", external_id: "ext-not-cached" }], 1);
    const r = db.prepare(`SELECT id FROM learn_bulk_answers WHERE external_id = 'ext-not-cached'`).get() as { id: string };
    expect(answerBulk(USER, r.id, "newsletter_spam")).toBe(true);
    expect(key(r.id)).toEqual({ answer: "newsletter_spam", sender_key: null });
  });
  it("a re-answer re-snapshots; a row of another user is refused", () => {
    const e = mail(NEWS);
    const id = answer(e, "newsletter_spam");
    db.prepare(`UPDATE emails SET sender = ? WHERE id = ?`).run("other@mail.example", e);
    expect(answerBulk(USER, id, "real_estate")).toBe(true);
    expect(key(id)).toEqual({ answer: "real_estate", sender_key: "other@mail.example" });
    expect(answerBulk(OTHER, id, "skip")).toBe(false);
    expect(key(id).answer).toBe("real_estate");
  });
});

describe("A2 answer and sender_key are one write", () => {
  it("a failure writing the sender_key leaves no answer behind", () => {
    const e = mail(NEWS);
    insertBulkSample(USER, [{ source: "gmail", external_id: `ext-${e}` }], 1);
    const { id } = db.prepare(`SELECT id FROM learn_bulk_answers WHERE external_id = ?`).get(`ext-${e}`) as { id: string };
    db.exec(`CREATE TRIGGER inject_4212 BEFORE UPDATE OF sender_key ON learn_bulk_answers
             WHEN NEW.sender_key IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected 4212'); END;`);
    expect(() => answerBulk(USER, id, "newsletter_spam")).toThrow(/injected 4212/);
    expect(db.prepare(`SELECT answer, sender_key FROM learn_bulk_answers WHERE id = ?`).get(id)).toEqual({
      answer: null,
      sender_key: null,
    });
  });
});

describe("A3 Delete my answers also clears the overrides", () => {
  const liveOverrides = () =>
    (db.prepare(`SELECT COUNT(*) AS n FROM learn_sender_overrides WHERE user_id = ? AND deleted_at IS NULL`).get(USER) as { n: number }).n;
  const liveAnswers = () =>
    (db.prepare(`SELECT COUNT(*) AS n FROM learn_bulk_answers WHERE user_id = ? AND deleted_at IS NULL`).get(USER) as { n: number }).n;
  it("answers and overrides are soft-removed together", () => {
    newsletters(NEWS, 2);
    override(NEWS);
    softClearAnswersAndStopSharing(USER);
    expect(liveOverrides()).toBe(0);
    expect(liveAnswers()).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM learn_sender_overrides`).get() as { n: number }).n).toBe(1);
  });
  it("in one transaction: a failure on the overrides keeps the answers", () => {
    newsletters(NEWS, 2);
    override(NEWS);
    db.exec(`CREATE TRIGGER inject_4212_ov BEFORE UPDATE ON learn_sender_overrides
             BEGIN SELECT RAISE(ABORT, 'injected 4212 ov'); END;`);
    expect(() => softClearAnswersAndStopSharing(USER)).toThrow(/injected 4212 ov/);
    expect(liveAnswers()).toBe(2);
    expect(liveOverrides()).toBe(1);
  });
});

describe("P address pass", () => {
  function setUpDeal(): { listed: string; plain: string } {
    db.prepare(
      `INSERT INTO transactions (id, user_id, property_address, status, started_at, created_at, submission_status)
       VALUES (?, ?, ?, 'active', '2026-01-01', '2026-01-01', 'not_submitted')`,
    ).run(TXN, USER, "1428 Maple Ave, Springfield");
    newsletters(NEWS, 2);
    return { listed: mail(gmailFrom("Digest", NEWS), USER, BODY), plain: mail(gmailFrom("Client", "client@example.org"), USER, BODY) };
  }
  const pending = () =>
    (db.prepare(`SELECT email_id FROM pending_review_communications WHERE transaction_id = ? ORDER BY email_id`).all(TXN) as Array<{
      email_id: string;
    }>).map((r) => r.email_id);
  const discoveryLog = () => {
    const call = logInfo.mock.calls.find((c) => String(c[0]).includes("address-only discovery"));
    if (!call) throw new Error("no address-only discovery log");
    return call[2] as Record<string, unknown>;
  };

  it("P1 shipped modes: the listed sender is not queued; counted as ruleSkipped", async () => {
    const { plain } = setUpDeal();
    jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(false);
    const r = await queueAddressMatchesForTransaction(TXN);
    expect(r).toEqual({ candidates: 2, matched: 2, queued: 1, seedSkipped: 0 });
    expect(pending()).toEqual([plain]);
    expect(discoveryLog()).toMatchObject({ seedSkipped: 0, ruleSkipped: 1 });
    expect(JSON.stringify(discoveryLog())).not.toContain("@");
  });

  it("P2 every central signal off on addressPass: the listed sender is still not queued", async () => {
    const off = Object.fromEntries(
      (Object.keys(shipped.modes) as SenderRuleSignal[]).map((s) => [s, { addressPass: "off" as const }]),
    ) as Partial<Record<SenderRuleSignal, Partial<SenderRuleModes>>>;
    mockRules = rulesWith(off);
    const { plain } = setUpDeal();
    jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(false);
    const r = await queueAddressMatchesForTransaction(TXN);
    expect(r).toEqual({ candidates: 2, matched: 2, queued: 1, seedSkipped: 0 });
    expect(pending()).toEqual([plain]);
  });

  it("control: with no answers both are queued", async () => {
    db.prepare(
      `INSERT INTO transactions (id, user_id, property_address, status, started_at, created_at, submission_status)
       VALUES (?, ?, ?, 'active', '2026-01-01', '2026-01-01', 'not_submitted')`,
    ).run(TXN, USER, "1428 Maple Ave, Springfield");
    mail(gmailFrom("Digest", NEWS), USER, BODY);
    mail(gmailFrom("Client", "client@example.org"), USER, BODY);
    jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(false);
    expect(await queueAddressMatchesForTransaction(TXN)).toMatchObject({ matched: 2, queued: 2 });
  });
});
