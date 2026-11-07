/**
 * @jest-environment node
 *
 * BACKLOG-4175 PR1a — the sender census in the Learn score, on the REAL driver
 * and the REAL schema.sql. Rows are written with the sync's own insert
 * statement (helpers/storedEmail-4175.ts), labels and headers JSON-encoded as
 * emailSyncService.ts:962-977 encodes them.
 *
 *   C6   the census counts every deal-linked message, not only the ones
 *        analyzeEmail flags (precondition asserted)
 *   C7   deals lost are counted per deal (a missed deal is not "lost")
 *   C8   header / label coverage per provider
 *   C10  cleanup is built from the unfiltered run: a measured-only S3 deal is
 *        still asked, and once answered Yes it is reported lost
 *   C11  per mailbox (emails.account_id), NULL as its own bucket, never the id
 *   C12  the census is reported twice: full, and without K1 AND K3
 *   C13  K1 = contacts on NON-rejected deals, not removed from the deal
 *   TH   thread-only links count, once per message; rejected deals do not
 *   BS   the filter on the bulk sample (newsletter caught, real estate suppressed)
 *
 * Synthetic data only: "Canarytest" streets, reserved domains.
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
jest.mock("../../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import transactionExtractorService from "../../transactionExtractorService";
import { runBaseline0, type LearnRunResult } from "../baselineRunner";
import { answerCleanupQuestion, nextCleanupQuestion } from "../cleanupPass";
import { formatCopyBlock, scoreRun, type SenderCensusInput } from "../scoring";
import {
  listAnswerKeyTransactions,
  listAnsweredBulkWithText,
  listDealAnswers,
  listDealContactEmails,
  listDealLinkedEmails,
} from "../../db/learnModeDbService";
import { BUNDLED_SENDER_RULES, type SenderRuleSet } from "../../../utils/senderFilter/bundledRules";
import { buildKeepSets, decide } from "../../../utils/senderFilter/senderFilter";
import { insertStoredEmail } from "../../__tests__/helpers/storedEmail-4175";

const SCHEMA = nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-4175-c";
const NOW = Date.UTC(2026, 10, 1, 12);
const UNSUB = { list_unsubscribe: "<mailto:unsub@list.example>" };
const AUTH_ONLY = { authentication_results: ["mx.example; spf=pass"] };

/** The shipped rules plus one approved host, for the K1 cases. */
const WITH_HOST: SenderRuleSet = {
  ...BUNDLED_SENDER_RULES,
  suppress: { ...BUNDLED_SENDER_RULES.suppress, hosts: ["corp.example", "corp2.example"] },
};

const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));
const noYield = () => Promise.resolve();

let seq = 0;
interface MailOpts {
  body?: string;
  subject?: string;
  source?: "gmail" | "outlook";
  accountId?: string | null;
  labels?: string[];
  headers?: Record<string, string | string[]>;
  threadId?: string;
}
function mail(sender: string, day: number, o: MailOpts = {}): string {
  seq += 1;
  const id = `e-4175c-${String(seq).padStart(3, "0")}`;
  insertStoredEmail(db, {
    id,
    userId: USER,
    sender,
    subject: o.subject ?? "Hello",
    bodyPlain: o.body ?? "Lunch on Thursday?",
    sentAt: `2026-06-${String(day).padStart(2, "0")}T10:00:00.000Z`,
    source: o.source,
    accountId: o.accountId,
    labels: o.labels,
    bulkMailHeaders: o.headers,
    threadId: o.threadId,
  });
  return id;
}

/** A message baseline 0 groups under `address`. */
function dealMail(sender: string, address: string, day: number, o: MailOpts = {}): string {
  return mail(sender, day, {
    subject: "Offer accepted",
    body: `Offer accepted on ${address}. Escrow closing, buyer inspection.`,
    ...o,
  });
}

function deal(id: string, address: string, status = "active", detectionStatus: string | null = null): void {
  run(
    `INSERT INTO transactions (id, user_id, property_address, status, detection_status, started_at, closed_at) VALUES (?, ?, ?, ?, ?, '2026-01-01', '2026-12-31')`,
    id,
    USER,
    address,
    status,
    detectionStatus,
  );
}

let linkSeq = 0;
/** An email link carries the email's own thread_id (schema trigger, BACKLOG-1768); a thread-only link has no email_id. */
function link(txn: string, emailId: string | null, threadOnly: string | null = null): void {
  linkSeq += 1;
  const threadId = emailId
    ? (db.prepare(`SELECT thread_id FROM emails WHERE id = ?`).get(emailId) as { thread_id: string }).thread_id
    : threadOnly;
  run(
    `INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id) VALUES (?, ?, ?, ?, ?)`,
    `c-4175c-${linkSeq}`,
    USER,
    txn,
    emailId,
    threadId,
  );
}

let contactSeq = 0;
function contactOn(txn: string, email: string, removed = false): void {
  contactSeq += 1;
  const cid = `ct-4175c-${contactSeq}`;
  run(`INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, 'Test Contact')`, cid, USER);
  run(`INSERT INTO contact_emails (id, contact_id, email) VALUES (?, ?, ?)`, `ce-${cid}`, cid, email);
  run(
    `INSERT INTO transaction_contacts (id, transaction_id, contact_id, removed_at) VALUES (?, ?, ?, ?)`,
    `tc-${cid}`,
    txn,
    cid,
    removed ? "2026-06-01T00:00:00Z" : null,
  );
}

function census(rules: SenderRuleSet = BUNDLED_SENDER_RULES): SenderCensusInput {
  return { rules, keep: buildKeepSets(listDealContactEmails(USER), rules), linked: listDealLinkedEmails(USER) };
}

function score(r: LearnRunResult, rules: SenderRuleSet = BUNDLED_SENDER_RULES) {
  return scoreRun(r, listAnswerKeyTransactions(USER), listDealAnswers(USER), listAnsweredBulkWithText(USER), 0, census(rules));
}

async function baseline(rules: SenderRuleSet = BUNDLED_SENDER_RULES): Promise<LearnRunResult> {
  return runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield, senderRules: rules });
}

const A1 = "4180 Canarytest Way, Testville, ZZ 00000";
const A2 = "4181 Canarytest Way, Testville, ZZ 00000";
const A3 = "4182 Canarytest Way, Testville, ZZ 00000";

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'c@example.test', 'google', 'oa-c')`, USER);
  seq = 0;
  linkSeq = 0;
  contactSeq = 0;
});

afterEach(() => db.close());

// ---------------------------------------------------------------------------
describe("C6 every deal-linked message is in the denominator", () => {
  it("a non-real-estate bulk message linked to a deal counts: k=1, n=2", async () => {
    deal("t1", A1);
    const bulk = mail("news@list.example", 1, { headers: UNSUB });
    const person = mail("client@client.example", 2);
    link("t1", bulk);
    link("t1", person);
    // Precondition: analyzeEmail does NOT flag the suppressed message.
    expect(
      transactionExtractorService.analyzeEmail({ subject: "Hello", bodyPlain: "Lunch on Thursday?", date: "" }).isRealEstateRelated,
    ).toBe(false);
    const sc = score(await baseline());
    expect(sc.senderCensus.dealLinkedSuppressed).toEqual([
      expect.objectContaining({ label: "mailbox 1", n: 2, full: { k: 1, bySignal: { bulkHeaders: 1 } } }),
    ]);
  });
});

describe("C11 per mailbox, NULL as its own bucket, labelled by ordinal", () => {
  it("A 0/3, B 1/2, unknown 0/1", async () => {
    deal("t1", A1);
    for (let i = 0; i < 3; i++) link("t1", mail(`p${i}@client.example`, i + 1, { accountId: "acct-a" }));
    link("t1", mail("q@client.example", 5, { accountId: "acct-b", source: "outlook" }));
    link("t1", mail("news@list.example", 6, { accountId: "acct-b", source: "outlook", headers: UNSUB }));
    link("t1", mail("r@client.example", 7, { accountId: null }));
    const c = score(await baseline()).senderCensus.dealLinkedSuppressed;
    expect(c.map((m) => [m.label, m.provider, m.full.k, m.n, m.addressPassReady])).toEqual([
      ["mailbox 1", "gmail", 0, 3, true],
      ["mailbox 2", "outlook", 1, 2, false],
      ["unknown mailbox", "gmail", 0, 1, true],
    ]);
    // The detector criterion also needs n >= minCensusLinkedEmails (20).
    expect(c.every((m) => m.detectorReady === false)).toBe(true);
    const block = formatCopyBlock(score(await baseline()));
    expect(block).toContain("mailbox 2 (outlook): 1/2 (bulkHeaders 1)");
    expect(block).not.toContain("acct-");
  });
});

describe("TH thread-only links count once per message; rejected deals do not", () => {
  it("one direct link, one thread-only link, one message linked both ways, one on a rejected deal", async () => {
    deal("t1", A1);
    deal("t-rej", A2, "rejected");
    const direct = mail("a@client.example", 1);
    const inThread = mail("news@list.example", 2, { threadId: "th-shared", headers: UNSUB });
    const both = mail("b@client.example", 3, { threadId: "th-shared" });
    const onRejected = mail("c@client.example", 4, { threadId: "th-rej" });
    link("t1", direct);
    link("t1", null, "th-shared");
    link("t1", both);
    link("t-rej", null, "th-rej");
    link("t-rej", onRejected);
    expect(listDealLinkedEmails(USER).map((r) => r.id)).toEqual([direct, inThread, both].sort());
    const [m] = score(await baseline()).senderCensus.dealLinkedSuppressed;
    expect([m.n, m.full.k]).toEqual([3, 1]);
  });
});

describe("C13 K1 = contacts on non-rejected deals, not removed", () => {
  it("rejected-deal contact and removed contact -> suppressed; active-deal contact -> kept by K1", async () => {
    deal("t-active", A1);
    deal("t-rej", A2, "rejected");
    deal("t-det-rej", A3, "active", "rejected");
    contactOn("t-rej", "newsletter@corp.example");
    contactOn("t-det-rej", "newsletter@corp.example");
    contactOn("t-active", "Keeper@Corp.example");
    contactOn("t-active", "gone@corp2.example", true);

    const contacts = listDealContactEmails(USER);
    expect(contacts.map((e) => e.toLowerCase()).sort()).toEqual(["keeper@corp.example"]);
    const keep = buildKeepSets(contacts, WITH_HOST);
    // Precondition: corp.example IS a K3 domain here (the keeper's domain).
    expect([...keep.contactDomains]).toEqual(["corp.example"]);

    const d = (s: string) => decide({ sender: s, source: "gmail" }, WITH_HOST, "learnQuestions", keep);
    expect(d("gone@corp2.example")).toMatchObject({ outcome: "suppress", rule: "S1" });
    expect(d("keeper@corp.example")).toMatchObject({ outcome: "keep", rule: "K1" });
    // Not a contact on a live deal: kept only by the domain rule, never by K1.
    expect(d("newsletter@corp.example")).toMatchObject({ outcome: "keep", rule: "K3" });
    const noDomain = { contactAddresses: keep.contactAddresses, contactDomains: new Set<string>() };
    expect(decide({ sender: "newsletter@corp.example" }, WITH_HOST, "learnQuestions", noDomain)).toMatchObject({
      outcome: "suppress",
      rule: "S1",
    });
  });

  it("a seed sender that is a contact on an active deal is still suppressed; keepConflicts = 1", async () => {
    deal("t-active", A1);
    contactOn("t-active", "my-saved-home@mail.zillow.com");
    mail('"Zillow" <my-saved-home@mail.zillow.com>', 1);
    const r = await baseline();
    expect(r.senderStats.keepConflicts).toBe(1);
    expect(score(r).senderCensus.keepConflicts).toBe(1);
  });
});

describe("C12 the census is reported with and without the contact keeps (K1 and K3)", () => {
  it("a K1-kept and a K3-kept bulk message: full 0, without contact keeps 2", async () => {
    deal("t1", A1);
    contactOn("t1", "agent@corp.example");
    link("t1", mail("agent@corp.example", 1, { headers: UNSUB }));
    link("t1", mail("news@corp.example", 2, { headers: UNSUB }));
    const sc = score(await baseline());
    const [m] = sc.senderCensus.dealLinkedSuppressed;
    expect([m.full.k, m.minusContactKeeps.k, m.n]).toEqual([0, 2, 2]);
    expect(sc.senderCensus.keptBy).toEqual({ K1: 1, K2: 0, K3: 1 });
  });
});

describe("C7 deals lost are counted per deal", () => {
  it("one deal lost to a measured signal, one deal never found -> lost 1", async () => {
    deal("t-lost", A1);
    deal("t-missed", A2);
    // A1 is found only through bulk-headed mail (S3, measure on Learn questions).
    dealMail("listings@portal.example", A1, 1, { headers: UNSUB });
    dealMail("listings@portal.example", A1, 2, { headers: UNSUB });
    const r = await baseline();
    const sc = score(r);
    // Preconditions: A1 found by the unfiltered run, A2 by nothing.
    expect([sc.found, sc.missed]).toEqual([1, 1]);
    expect(r.filtered.full).toEqual([]);
    expect(sc.senderCensus.foundDealsLost).toEqual({ full: 1, minusContactKeeps: 1 });
  });

  it("a contact keeps the deal in the full run and loses it without the contact keeps", async () => {
    deal("t1", A1);
    contactOn("t1", "listings@portal.example");
    dealMail("listings@portal.example", A1, 1, { headers: UNSUB });
    const sc = score(await baseline());
    expect(sc.senderCensus.foundDealsLost).toEqual({ full: 0, minusContactKeeps: 1 });
  });
});

describe("C10 cleanup is built from the unfiltered run", () => {
  it("an all-S3 (measure) detection is asked; answered Yes, it is reported lost", async () => {
    const id = dealMail("listings@portal.example", A1, 1, { headers: UNSUB });
    const r = await baseline();
    const q = nextCleanupQuestion(USER, r);
    expect(q).not.toBeNull();
    const d = r.detections.find((x) => x.emailIds.includes(id));
    expect(q?.detectionId).toBe(d?.id);
    expect(d?.hiddenEmailIds).toEqual([]);
    expect(answerCleanupQuestion(USER, r, q?.detectionId as string, "yes")).toBe(true);
    const sc = score(r);
    expect(sc.cleanupYes).toBe(1);
    expect(sc.senderCensus.cleanupYesLost).toEqual({ full: 1, minusContactKeeps: 1 });
    expect(sc.hiddenBySeed).toEqual({ keys: 0, detections: 0, emails: 0 });
  });

  it("an all-host-suppressed detection with the host LIVE is hidden", async () => {
    dealMail("listings@corp.example", A1, 1);
    const r = await baseline(WITH_HOST);
    expect(nextCleanupQuestion(USER, r)).toBeNull();
    expect(score(r, WITH_HOST).hiddenBySeed).toEqual({ keys: 1, detections: 1, emails: 1 });
  });
});

describe("C8 coverage per provider", () => {
  it("gmail headers 1/2 labels 1/2; outlook headers 0/1", async () => {
    mail("a@x.example", 1, { headers: AUTH_ONLY, labels: ["INBOX"] });
    mail("b@x.example", 2);
    mail("c@x.example", 3, { source: "outlook" });
    const r = await baseline();
    expect(r.senderStats.coverage).toEqual({
      gmail: { rows: 2, headers: 1, labels: 1 },
      outlook: { rows: 1, headers: 0, labels: 0 },
      unknown: { rows: 0, headers: 0, labels: 0 },
    });
    // Authentication-Results alone is coverage, not bulk.
    expect(score(r).senderCensus.dealLinkedSuppressed).toEqual([]);
    expect(formatCopyBlock(score(r))).toContain("Stored header coverage: gmail headers 1/2, labels 1/2; outlook headers 0/1, labels 0/1");
  });
});

describe("BS the filter on the answered bulk sample", () => {
  function sample(emailId: string, answer: string, n: number): void {
    run(
      `INSERT INTO learn_bulk_answers (id, user_id, source, external_id, sampled_at, answer, answered_at, rule_version, created_at, updated_at)
       VALUES (?, ?, 'gmail', ?, '2026-10-01T00:00:00Z', ?, '2026-10-01T00:00:00Z', 2, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
      `lba-4175c-${n}`,
      USER,
      `ext-${emailId}`,
      answer,
    );
  }

  it("newsletter caught 1/2, real estate suppressed 1/1", async () => {
    sample(mail("news@list.example", 1, { headers: UNSUB }), "newsletter_spam", 1);
    sample(mail("promo@shop.example", 2), "newsletter_spam", 2);
    sample(mail("alerts@listings.example", 3, { labels: ["CATEGORY_PROMOTIONS"] }), "real_estate", 3);
    const sc = score(await baseline());
    expect([sc.senderCensus.bulkCaught.k, sc.senderCensus.bulkCaught.n]).toEqual([1, 2]);
    expect([sc.senderCensus.realEstateSuppressed.k, sc.senderCensus.realEstateSuppressed.n]).toEqual([1, 1]);
    expect(sc.senderCensus.realEstateSuppressed.interval).not.toBeNull();
  });
});
