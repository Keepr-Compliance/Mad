/**
 * @jest-environment node
 *
 * BACKLOG-4120 PR1 — Learn mode on the REAL driver and the REAL schema.sql.
 *
 *   C6  window from the request: supabaseService gets 0 calls
 *   C7  keyset paging: 450 rows on one sent_at + 50 later + 10 NULL
 *   C8  one yield per page
 *   C10 CHECK constraints, UUID ids, timestamps, soft removal + re-answer
 *   C12 the bulk sample survives a force re-cache (new emails.id, same provider id)
 *   C13 Learn mode is OFF with no row
 *   N1  cleanup Yes / No and a full run change no non-learn_ table
 *   N2  no cloud AI, no provider fetch, no network
 *   P2  the public run summary and every progress event carry no address or subject
 *
 * Synthetic data only: ids are obviously fake, addresses use the "Canarytest"
 * street and @example.test mail.
 */
import * as nodePath from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;
jest.mock("../../db/core/dbConnection", () => ({
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
  dbTransaction: (fn: () => unknown) => db.transaction(fn)(),
  ensureDb: () => db,
  getRawDatabase: () => db,
}));

// C6 / P3: the window must never come from the cloud preference.
const supabaseCalls: string[] = [];
jest.mock("../../supabaseService", () => {
  const handler: ProxyHandler<object> = {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      return (..._args: unknown[]) => {
        supabaseCalls.push(String(prop));
        return Promise.resolve({});
      };
    },
  };
  const proxy = new Proxy({}, handler);
  return { __esModule: true, default: proxy };
});
jest.mock("../../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

// N2: these modules must never even be LOADED by Learn mode.
const loaded: string[] = [];
jest.mock("../../extraction/hybridExtractorService", () => {
  loaded.push("hybridExtractorService");
  return { hybridExtractorService: { extract: jest.fn(), analyzeMessages: jest.fn() } };
});
jest.mock("../../gmailFetchService", () => {
  loaded.push("gmailFetchService");
  return { __esModule: true, default: {} };
});
jest.mock("../../outlookFetchService", () => {
  loaded.push("outlookFetchService");
  return { __esModule: true, default: {} };
});
jest.mock("../../llm/anthropicService", () => {
  loaded.push("anthropicService");
  return { AnthropicService: jest.fn() };
});
jest.mock("../../llm/openAIService", () => {
  loaded.push("openAIService");
  return { OpenAIService: jest.fn() };
});
jest.mock("../../llm/llmConfigService", () => {
  loaded.push("llmConfigService");
  return { __esModule: true, default: {} };
});
jest.mock("../../transactionService", () => {
  loaded.push("transactionService");
  return { __esModule: true, default: {} };
});

import { getLastRun, runBaseline0, setLastRun, toPublicRunSummary, type LearnRunProgress } from "../baselineRunner";
import { answerCleanupQuestion, nextCleanupQuestion } from "../cleanupPass";
import { answerBulkQuestion, ensureBulkSample, nextBulkQuestion } from "../bulkSample";
import { buildAnswerKey } from "../answerKey";
import { scoreRun } from "../scoring";
import {
  getLearnModeEnabled,
  listAnswerKeyTransactions,
  listAnsweredBulkWithText,
  listDealAnswers,
  setLearnModeEnabled,
  softClearAnswers,
} from "../../db/learnModeDbService";

const SCHEMA = nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-4120-a";
const OTHER = "user-4120-b";
const NOW = Date.UTC(2026, 10, 1, 12); // 2026-11-01
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANARY_ADDRESS = "4120 Canarytest Lane, Testville, ZZ 00000";
const CANARY_SUBJECT = "Canarysubject offer accepted";

const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));
const get = (q: string, ...p: unknown[]) => db.prepare(q).get(...(p as never[])) as Record<string, unknown> | undefined;
const all = (q: string, ...p: unknown[]) => db.prepare(q).all(...(p as never[])) as Array<Record<string, unknown>>;

let emailSeq = 0;
function seedEmail(opts: {
  sentAt: string | null;
  subject?: string;
  body?: string;
  id?: string;
  externalId?: string;
  source?: "gmail" | "outlook";
  user?: string;
}): string {
  emailSeq += 1;
  const id = opts.id ?? `e-${String(emailSeq).padStart(5, "0")}`;
  run(
    `INSERT INTO emails (id, user_id, external_id, source, account_id, subject, sender, recipients, sent_at, body_plain)
     VALUES (?, ?, ?, ?, 'acct-0', ?, 'agent@example.test', 'me@example.test', ?, ?)`,
    id,
    opts.user ?? USER,
    opts.externalId ?? `ext-${emailSeq}`,
    opts.source ?? "gmail",
    opts.subject ?? "Hello",
    opts.sentAt,
    opts.body ?? "Lunch on Friday?",
  );
  return id;
}

function seedDeal(id: string, address: string, extra: Record<string, string | null> = {}): void {
  run(`INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)`, id, USER, address);
  for (const [col, val] of Object.entries(extra)) {
    run(`UPDATE transactions SET ${col} = ? WHERE id = ?`, val, id);
  }
}

/** Row count of every table that is not a learn_ table. */
function nonLearnCounts(): Record<string, number> {
  const tables = all(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'learn_%' AND name NOT LIKE 'sqlite_%'`,
  ).map((r) => String(r.name));
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = Number(get(`SELECT COUNT(*) AS n FROM "${t}"`)?.n);
  return out;
}

const noYield = () => Promise.resolve();

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'a@example.test', 'google', 'oa-a')`, USER);
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'b@example.test', 'google', 'oa-b')`, OTHER);
  supabaseCalls.length = 0;
  emailSeq = 0;
});

afterEach(() => db.close());

// ---------------------------------------------------------------------------
describe("C13 Learn mode switch", () => {
  it("is OFF on a fresh database with no row, and the column default is 0", () => {
    expect(getLearnModeEnabled(USER)).toBe(false);
    run(
      `INSERT INTO learn_mode_settings (id, user_id, created_at, updated_at) VALUES ('learn-row-1', ?, 'x', 'x')`,
      USER,
    );
    expect(getLearnModeEnabled(USER)).toBe(false);
  });

  it("a toggle updates the live row in place; it never adds or removes a row", () => {
    setLearnModeEnabled(USER, true);
    expect(getLearnModeEnabled(USER)).toBe(true);
    setLearnModeEnabled(USER, false);
    expect(getLearnModeEnabled(USER)).toBe(false);
    setLearnModeEnabled(USER, true);
    const rows = all(`SELECT id, enabled, deleted_at FROM learn_mode_settings`);
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(1);
    expect(String(rows[0].id)).toMatch(UUID_RE);
    expect(getLearnModeEnabled(OTHER)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("C10 learn tables: CHECKs, ids, timestamps, soft removal", () => {
  const BASE = `'learn-row-aa'`;
  it.each([
    ["learn_mode_settings.enabled", `INSERT INTO learn_mode_settings (id, user_id, enabled, created_at, updated_at) VALUES (${BASE}, '${USER}', 2, 'x', 'x')`],
    ["learn_deal_answers.answer", `INSERT INTO learn_deal_answers (id, user_id, run_id, address_key, property_address, answer, answered_at, rule_version, created_at, updated_at) VALUES (${BASE}, '${USER}', 'r', 'k', 'a', 'maybe', 'x', 1, 'x', 'x')`],
    ["learn_bulk_answers.answer", `INSERT INTO learn_bulk_answers (id, user_id, source, external_id, sampled_at, answer, rule_version, created_at, updated_at) VALUES (${BASE}, '${USER}', 'gmail', 'x', 'x', 'person', 1, 'x', 'x')`],
    ["learn_bulk_answers.source", `INSERT INTO learn_bulk_answers (id, user_id, source, external_id, sampled_at, rule_version, created_at, updated_at) VALUES (${BASE}, '${USER}', 'imap', 'x', 'x', 1, 'x', 'x')`],
  ])("%s rejects an out-of-set value", (_name, stmt) => {
    expect(() => run(stmt)).toThrow(/CHECK constraint failed/);
  });

  it("answer rows get a UUID id, created/updated timestamps and the rule version", () => {
    seedEmail({ sentAt: "2026-06-01T10:00:00.000Z" });
    ensureBulkSample(USER, 12, NOW);
    const b = get(`SELECT * FROM learn_bulk_answers`)!;
    expect(String(b.id)).toMatch(UUID_RE);
    expect([typeof b.created_at, typeof b.updated_at, b.rule_version, b.answer, b.deleted_at]).toEqual([
      "string",
      "string",
      2,
      null,
      null,
    ]);
  });

  it("'delete my answers' soft-removes (rows stay), reads hide them, and a re-answer succeeds", async () => {
    seedEmail({ sentAt: "2026-06-01T10:00:00.000Z", subject: "Escrow", body: `Offer accepted on ${CANARY_ADDRESS}. Escrow closing, buyer inspection.` });
    const result = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield });
    const q = nextCleanupQuestion(USER, result)!;
    expect(answerCleanupQuestion(USER, result, q.detectionId, "no")).toBe(true);
    ensureBulkSample(USER, 12, NOW);

    expect(softClearAnswers(USER)).toEqual({ deal: 1, bulk: 1 });
    expect(Number(get(`SELECT COUNT(*) AS n FROM learn_deal_answers`)?.n)).toBe(1);
    expect(Number(get(`SELECT COUNT(*) AS n FROM learn_bulk_answers`)?.n)).toBe(1);
    expect(listDealAnswers(USER)).toEqual([]);
    expect(nextBulkQuestion(USER)).toBeNull();

    expect(answerCleanupQuestion(USER, result, q.detectionId, "yes")).toBe(true);
    expect(listDealAnswers(USER).map((a) => a.answer)).toEqual(["yes"]);
    expect(ensureBulkSample(USER, 12, NOW).drawn).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("C7 / C8 keyset paging over local mail", () => {
  const SAME = "2026-06-01T10:00:00.000Z";
  beforeEach(() => {
    for (let i = 0; i < 450; i++) seedEmail({ sentAt: SAME });
    for (let i = 0; i < 50; i++) seedEmail({ sentAt: `2026-07-01T10:00:${String(i).padStart(2, "0")}.000Z` });
    for (let i = 0; i < 10; i++) seedEmail({ sentAt: null });
  });

  it("reads all 500 dated rows exactly once, in 3 pages, and counts the 10 NULL rows", async () => {
    let yields = 0;
    const r = await runBaseline0(USER, 12, {
      nowMs: NOW,
      maxPages: 10,
      yieldFn: () => {
        yields += 1;
        return Promise.resolve();
      },
    });
    expect([r.rowsScanned, r.pages, r.nullSentAt]).toEqual([500, 3, 10]);
    expect(yields).toBe(r.pages); // C8: one yield per page
  });

  it("the window is cut from the request's months, not the cloud preference (C6)", async () => {
    seedEmail({ sentAt: "2025-01-01T10:00:00.000Z" }); // 22 months before NOW
    const twelve = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield });
    const twentyFour = await runBaseline0(USER, 24, { nowMs: NOW, yieldFn: noYield });
    expect([twelve.rowsScanned, twentyFour.rowsScanned]).toEqual([500, 501]);
    expect(supabaseCalls).toEqual([]);
  });

  it.each([0, 25, 1.5, "12", null])("refuses windowMonths %p", async (bad) => {
    await expect(runBaseline0(USER, bad, { nowMs: NOW, yieldFn: noYield })).rejects.toThrow(/windowMonths/);
  });
});

// ---------------------------------------------------------------------------
describe("C12 bulk sample key survives a force re-cache", () => {
  it("re-inserting the email under a new local id keeps the sample row resolvable", () => {
    seedEmail({ id: "e-old", externalId: "ext-keep", sentAt: "2026-06-01T10:00:00.000Z", subject: "Weekly market newsletter" });
    expect(ensureBulkSample(USER, 12, NOW)).toEqual({ sampleSize: 1, drawn: 1 });
    const q = nextBulkQuestion(USER)!;
    expect(answerBulkQuestion(USER, q.rowId, "newsletter_spam")).toBe(true);

    // What a force re-cache does to an unprotected email: remove the row and
    // insert the fresh copy under a NEW local id, same provider id.
    run(`DELETE FROM emails WHERE id = 'e-old'`);
    seedEmail({ id: "e-new", externalId: "ext-keep", sentAt: "2026-06-01T10:00:00.000Z", subject: "Weekly market newsletter" });

    const rows = listAnsweredBulkWithText(USER);
    expect(rows).toHaveLength(1);
    expect([rows[0].answer, rows[0].cached, rows[0].subject]).toEqual(["newsletter_spam", 1, "Weekly market newsletter"]);
    // Drawn once: a second call does not redraw.
    expect(ensureBulkSample(USER, 12, NOW)).toEqual({ sampleSize: 1, drawn: 0 });
  });

  it("an unknown answer value or another user's row is refused", () => {
    seedEmail({ sentAt: "2026-06-01T10:00:00.000Z" });
    ensureBulkSample(USER, 12, NOW);
    const q = nextBulkQuestion(USER)!;
    expect(answerBulkQuestion(USER, q.rowId, "person")).toBe(false);
    expect(answerBulkQuestion(OTHER, q.rowId, "skip")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("answer key reads one user's transactions, with created_at", () => {
  it("another user's manual deal at the same address is not in the key or the positives", async () => {
    seedDeal("t-mine", CANARY_ADDRESS);
    run(`INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)`, "t-theirs", OTHER, CANARY_ADDRESS);
    run(`INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)`, "t-theirs-2", OTHER, "77 Canarytest Way, Testville, ZZ 00000");
    expect(all(`SELECT id FROM transactions`)).toHaveLength(3);
    const rows = listAnswerKeyTransactions(USER);
    expect(rows).toHaveLength(1);
    expect(rows[0].property_address).toBe(CANARY_ADDRESS);
    expect(buildAnswerKey(rows, { firstMs: NOW - 1e9, lastMs: NOW }).positives).toHaveLength(1);
    expect(listAnswerKeyTransactions(OTHER)).toHaveLength(2);
  });

  it("created_at is returned, and a pre-2.33.0 manual row is split out of the positives count", () => {
    seedDeal("t-old", CANARY_ADDRESS, { created_at: "2026-08-01 10:00:00" });
    seedDeal("t-new", "77 Canarytest Way, Testville, ZZ 00000");
    const rows = listAnswerKeyTransactions(USER);
    expect(rows.find((r) => r.property_address === CANARY_ADDRESS)?.created_at).toBe("2026-08-01 10:00:00");
    const k = buildAnswerKey(rows, { firstMs: NOW - 1e9, lastMs: NOW });
    expect([k.positives.length, k.legacyManualPositives]).toEqual([2, 1]);
  });
});

// ---------------------------------------------------------------------------
describe("N1 / N2 / P2 a full Learn mode session", () => {
  async function session() {
    seedDeal("t-found", "4120 Canarytest Lane, Testville, ZZ 00000", { transaction_type: "purchase" });
    seedDeal("t-missed", "77 Canarytest Way, Testville, ZZ 00000");
    seedEmail({
      sentAt: "2026-06-01T10:00:00.000Z",
      subject: CANARY_SUBJECT,
      body: `Offer accepted on ${CANARY_ADDRESS}. Escrow closing, buyer inspection next week.`,
    });
    seedEmail({
      sentAt: "2026-06-02T10:00:00.000Z",
      subject: "Escrow",
      body: "Purchase agreement for 900 Canarytest Court, Testville, ZZ 00000, escrow closing, buyer offer.",
    });
    seedEmail({
      sentAt: "2026-06-03T10:00:00.000Z",
      subject: "Escrow",
      body: "Listing agreement for 901 Canarytest Court, Testville, ZZ 00000, escrow closing, seller offer.",
    });
    for (let i = 0; i < 5; i++) seedEmail({ sentAt: `2026-06-1${i}T10:00:00.000Z` });

    const progress: LearnRunProgress[] = [];
    const result = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield, onProgress: (p) => progress.push(p) });
    setLastRun(USER, result);
    return { result, progress };
  }

  it("Yes and No answers and a full run change no non-learn table (N1)", async () => {
    const before = nonLearnCounts();
    const { result } = await session();
    const afterSeed = nonLearnCounts();
    // the seed itself added 2 deals and 8 emails; nothing else may move from here on
    expect(afterSeed.transactions - before.transactions).toBe(2);

    const q1 = nextCleanupQuestion(USER, result)!;
    expect(answerCleanupQuestion(USER, result, q1.detectionId, "yes")).toBe(true);
    const q2 = nextCleanupQuestion(USER, result)!;
    expect(q2.detectionId).not.toBe(q1.detectionId);
    expect(answerCleanupQuestion(USER, result, q2.detectionId, "no")).toBe(true);
    expect(nextCleanupQuestion(USER, result)).toBeNull();
    ensureBulkSample(USER, 12, NOW);
    const b = nextBulkQuestion(USER)!;
    answerBulkQuestion(USER, b.rowId, "real_estate");
    await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield });

    expect(nonLearnCounts()).toEqual(afterSeed);
  });

  it("a detection that matched a hand-entered deal is never asked; the score adds up", async () => {
    const { result } = await session();
    expect(result.detections).toHaveLength(3);
    const q1 = nextCleanupQuestion(USER, result)!;
    answerCleanupQuestion(USER, result, q1.detectionId, "yes");
    const q2 = nextCleanupQuestion(USER, result)!;
    answerCleanupQuestion(USER, result, q2.detectionId, "no");
    // the found deal's detection is not a candidate
    const found = result.detections.find((d) => d.addressKey === "4120 canarytest|00000")!;
    expect(answerCleanupQuestion(USER, result, found.id, "yes")).toBe(false);

    const s = scoreRun(result, listAnswerKeyTransactions(USER), listDealAnswers(USER), listAnsweredBulkWithText(USER), 0);
    expect([s.positives, s.found, s.missed, s.trueDetections, s.cleanupYes, s.cleanupNo]).toEqual([2, 1, 1, 1, 1, 1]);
    expect(s.side).toEqual({ correct: 1, wrong: 0, notPredicted: 0, skipped: 0 });
  });

  it("loads no AI / provider / transactionService module and makes no network call (N2)", async () => {
    const fetchSpy = jest.fn();
    const realFetch = global.fetch;
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;
    try {
      const { result } = await session();
      const q = nextCleanupQuestion(USER, result)!;
      answerCleanupQuestion(USER, result, q.detectionId, "yes");
      ensureBulkSample(USER, 12, NOW);
      scoreRun(result, listAnswerKeyTransactions(USER), listDealAnswers(USER), listAnsweredBulkWithText(USER), 0);
    } finally {
      (global as unknown as { fetch: unknown }).fetch = realFetch;
    }
    expect(loaded).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(supabaseCalls).toEqual([]);
  });

  it("the public summary and every progress event hold ids and counts only (P2)", async () => {
    const { result, progress } = await session();
    expect(result.detections.some((d) => /canarytest/i.test(d.address))).toBe(true); // the canary is really in the run
    const payloads = JSON.stringify([toPublicRunSummary(result), ...progress]);
    expect(progress.length).toBeGreaterThan(0);
    expect(payloads).not.toMatch(/canarytest/i);
    expect(payloads).not.toContain("Canarysubject");
    expect(payloads).not.toContain("example.test");
    expect(getLastRun(USER)).toBe(result);
  });
});
