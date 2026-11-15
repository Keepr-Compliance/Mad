/**
 * @jest-environment node
 *
 * BACKLOG-4257 (M3) PR2 — per-email signals measured in Learn (shadow only).
 *
 *   L1  R5: the deal-linked loader keeps NON-rejected deals only (status and
 *       detection_status), pages by keyset without gaps or repeats, caps text in SQL
 *   L2  D1: vendor-role contact emails (lender / mortgage broker / title / escrow)
 *       on non-rejected deals, removed contacts and other roles left out
 *   S1  one pass over a seeded mailbox: counts, a passing signal, R6 form coverage
 *   S2  C6: sender-tier positives are TRUE-detection mail only, never deal-linked mail
 *   S3  keep bar: a signal that never fires on deal mail does not pass; minimum n
 *   S4  R4: the time limit stops the pass and every verdict reads "not enough data"
 *   S5  privacy: the record and its Copy lines carry no address, subject or sender
 *
 * Real driver, real schema.sql, the real baseline 0 run as the producer of
 * detections. Synthetic "Canarytest" streets and reserved domains only.
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

import { runBaseline0 } from "../baselineRunner";
import {
  answerBulk,
  insertBulkSample,
  listAnswerKeyTransactions,
  listDealAnswers,
  listDealContactEmails,
} from "../../db/learnModeDbService";
import { listDealVendorRoleEmails } from "../../db/dealContactEmailsDb";
import { dealLinkedSignalPage, signalLoadersFor, SIGNAL_PAGE_SIZE } from "../../db/learnSignalsDb";
import { MAX_BODY_CHARS } from "../../detectSignals/canonicalText";
import {
  formatSignalLines,
  keepBar,
  KEEP_BAR,
  scoreSignals,
  vendorRoleDomains,
  type SignalScore,
  type SignalValueScore,
} from "../signalScoring";
import { BUNDLED_SENDER_RULES } from "../../../utils/senderFilter/bundledRules";
import { buildKeepSets } from "../../../utils/senderFilter/senderFilter";
import { wilsonInterval } from "../wilson";
import { insertStoredEmail } from "../../__tests__/helpers/storedEmail-4175";

const REPO = nodePath.join(__dirname, "..", "..", "..", "..");
const USER = "user-4257-sig";
const NOW = Date.UTC(2026, 10, 1, 12);
const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));
const noYield = () => Promise.resolve();
let seq = 0;

function freshDb(): void {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(nodePath.join(REPO, "electron", "database", "schema.sql"), "utf8"));
  db.pragma("foreign_keys = ON");
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'sig@example.test', 'google', 'oa-sig')`, USER);
  seq = 0;
}

function mail(sender: string, day: number, subject: string, body: string): string {
  seq += 1;
  const id = `e-4257-${String(seq).padStart(4, "0")}`;
  insertStoredEmail(db, {
    id,
    userId: USER,
    sender,
    subject,
    bodyPlain: body,
    sentAt: `2026-06-${String(1 + (day % 28)).padStart(2, "0")}T10:00:00.000Z`,
  });
  return id;
}

let linkSeq = 0;
function link(txn: string, emailId: string): void {
  linkSeq += 1;
  run(
    `INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id) VALUES (?, ?, ?, ?, ?)`,
    `c-4257-${linkSeq}`,
    USER,
    txn,
    emailId,
    `th-${emailId}`,
  );
}

function deal(id: string, address: string, opts: { status?: string; detectionStatus?: string } = {}): void {
  run(
    `INSERT INTO transactions (id, user_id, property_address, status, detection_status, started_at, closed_at) VALUES (?, ?, ?, ?, ?, '2026-01-01', '2026-12-31')`,
    id,
    USER,
    address,
    opts.status ?? "active",
    opts.detectionStatus ?? "confirmed",
  );
}

function contactOn(txn: string, contactId: string, email: string, role: string | null, removed = false): void {
  run(`INSERT OR IGNORE INTO contacts (id, user_id, display_name) VALUES (?, ?, 'Test Contact')`, contactId, USER);
  run(`INSERT OR IGNORE INTO contact_emails (id, contact_id, email) VALUES (?, ?, ?)`, `ce-${contactId}`, contactId, email);
  run(
    `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role, specific_role, removed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    `tc-${txn}-${contactId}`,
    txn,
    contactId,
    role,
    role,
    removed ? "2026-07-01" : null,
  );
}

function attach(emailId: string, filename: string, text: string | null): void {
  run(
    `INSERT INTO attachments (id, email_id, filename, mime_type, file_size_bytes, text_content) VALUES (?, ?, ?, 'application/pdf', 1234, ?)`,
    `att-${emailId}-${filename}`,
    emailId,
    filename,
    text,
  );
}

const streetOf = (i: number) => `${4200 + i} Canarytest Way, Testville, ZZ 00000`;
const N_DEALS = 20;
const N_NEWSLETTERS = 30;
const NEWSLETTER_SENDER = "news@digest.example";

interface World {
  dealMailIds: string[];
  clientMailIds: string[];
  newsletterIds: string[];
  rejectedMailId: string;
}

/**
 * 20 hand-entered deals, each with two agent messages naming the street in the
 * subject (baseline 0 detects each deal: 20 true detections) and one message
 * from the deal's client contact (linked to the deal, no street). One rejected
 * deal with a linked message. 30 newsletters answered newsletter/spam.
 */
function seedWorld(): World {
  const w: World = { dealMailIds: [], clientMailIds: [], newsletterIds: [], rejectedMailId: "" };
  for (let i = 1; i <= N_DEALS; i++) {
    const t = `t-4257-${i}`;
    const a = streetOf(i);
    deal(t, a);
    contactOn(t, `ct-client-${i}`, `client${i}@client.example`, "client");
    for (let j = 0; j < 2; j++) {
      const id = mail(`agent${i}@brokerage.example`, i + j, `Offer accepted on ${a}`, `Offer accepted on ${a}. Escrow closing, buyer inspection next week.`);
      link(t, id);
      w.dealMailIds.push(id);
    }
    const c = mail(`client${i}@client.example`, i, "Quick question", "Can you call me today? Thanks.");
    link(t, c);
    w.clientMailIds.push(c);
  }
  attach(w.dealMailIds[0], "notes.pdf", "Plain text with no form in it.");

  deal("t-4257-rej", streetOf(90), { status: "rejected" });
  w.rejectedMailId = mail("rejected@rejected.example", 3, "Hello", "Nothing to see.");
  link("t-4257-rej", w.rejectedMailId);

  for (let i = 0; i < N_NEWSLETTERS; i++) {
    w.newsletterIds.push(
      mail(
        NEWSLETTER_SENDER,
        i,
        `Weekly market digest ${i}`,
        "New listing and offer news this week: escrow tips, closing costs, mortgage rates and inspection advice. Unsubscribe.",
      ),
    );
  }
  attach(w.newsletterIds[0], "flyer.pdf", null);
  insertBulkSample(USER, w.newsletterIds.map((id) => ({ source: "gmail" as const, external_id: `ext-${id}` })), 1);
  for (const r of db.prepare(`SELECT id FROM learn_bulk_answers WHERE user_id = ?`).all(USER) as Array<{ id: string }>) {
    expect(answerBulk(USER, r.id, "newsletter_spam")).toBe(true);
  }
  return w;
}

async function signalPass(opts: { nowMs?: () => number; timeLimitMs?: number } = {}): Promise<SignalScore> {
  const rules = BUNDLED_SENDER_RULES;
  const r = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYield, senderRules: rules });
  return scoreSignals({
    run: r,
    keyRows: listAnswerKeyTransactions(USER),
    dealAnswers: listDealAnswers(USER),
    ctx: {
      rules,
      keep: buildKeepSets(listDealContactEmails(USER), rules),
      vendorRoleDomains: vendorRoleDomains(listDealVendorRoleEmails(USER), rules),
    },
    loaders: signalLoadersFor(USER),
    yieldFn: noYield,
    ...opts,
  });
}

function value(s: SignalScore, id: string): SignalValueScore {
  const v = s.values.find((x) => x.id === id);
  if (!v) throw new Error(`no signal value ${id}`);
  return v;
}

beforeEach(freshDb);
afterEach(() => db.close());

describe("L1 (R5) deal-linked loader", () => {
  it("keeps non-rejected deals only: status 'rejected' and detection_status 'rejected' are both out", () => {
    deal("t-a", streetOf(1));
    deal("t-r1", streetOf(2), { status: "rejected" });
    deal("t-r2", streetOf(3), { detectionStatus: "rejected" });
    const kept = mail("a@agent.example", 1, "s", "b");
    const r1 = mail("b@agent.example", 2, "s", "b");
    const r2 = mail("c@agent.example", 3, "s", "b");
    mail("d@agent.example", 4, "s", "not linked");
    link("t-a", kept);
    link("t-r1", r1);
    link("t-r2", r2);
    expect(dealLinkedSignalPage(USER, "").map((r) => r.id)).toEqual([kept]);
  });

  it("pages by id without gaps or repeats, at most SIGNAL_PAGE_SIZE per page", () => {
    deal("t-a", streetOf(1));
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = mail("a@agent.example", i, "s", "b");
      link("t-a", id);
      ids.push(id);
    }
    const seen: string[] = [];
    let cursor = "";
    for (;;) {
      const page = dealLinkedSignalPage(USER, cursor, 3);
      expect(page.length).toBeLessThanOrEqual(3);
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.id));
      cursor = page[page.length - 1].id;
    }
    expect(seen).toEqual([...ids].sort());
    expect(dealLinkedSignalPage(USER, "", 10_000).length).toBeLessThanOrEqual(SIGNAL_PAGE_SIZE);
  });

  it("caps the body in SQL", () => {
    deal("t-a", streetOf(1));
    const id = mail("a@agent.example", 1, "s", "x".repeat(MAX_BODY_CHARS + 5_000));
    link("t-a", id);
    const [row] = dealLinkedSignalPage(USER, "");
    expect(row.body_plain?.length).toBe(MAX_BODY_CHARS);
  });
});

describe("L2 (D1) vendor-role contact emails", () => {
  it("lender / mortgage broker / title / escrow on non-rejected deals; not other roles, removed or rejected", () => {
    deal("t-a", streetOf(1));
    deal("t-r", streetOf(2), { status: "rejected" });
    contactOn("t-a", "ct-l", "loans@lender.example", "lender");
    contactOn("t-a", "ct-m", "mb@broker-mortgage.example", "mortgage_broker");
    contactOn("t-a", "ct-t", "title@title.example", "title_company");
    contactOn("t-a", "ct-e", "esc@escrow.example", "escrow_officer");
    contactOn("t-a", "ct-g", "agent@brokerage.example", "agent");
    contactOn("t-a", "ct-x", "gone@lender2.example", "lender", true);
    contactOn("t-r", "ct-rj", "rej@lender3.example", "lender");
    contactOn("t-a", "ct-f", "lender@freemail.example", "lender");
    const emails = listDealVendorRoleEmails(USER).sort();
    expect(emails).toEqual(
      ["esc@escrow.example", "lender@freemail.example", "loans@lender.example", "mb@broker-mortgage.example", "title@title.example"].sort(),
    );
    // free-mail hosts never become vendor-role domains
    const rules = { ...BUNDLED_SENDER_RULES, freeMailDomains: [...BUNDLED_SENDER_RULES.freeMailDomains, "freemail.example"] };
    expect([...vendorRoleDomains(emails, BUNDLED_SENDER_RULES)]).toContain("freemail.example");
    expect([...vendorRoleDomains(emails, rules)].sort()).toEqual(
      ["broker-mortgage.example", "escrow.example", "lender.example", "title.example"].sort(),
    );
  });
});

describe("S1 one signal pass over a seeded mailbox", () => {
  it("counts the sets, and a subject-placed street passes the keep bar", async () => {
    seedWorld();
    const s = await signalPass();
    expect(s.complete).toBe(true);
    expect(s.stoppedBy).toBeNull();
    expect(s.emails.newsletter).toBe(N_NEWSLETTERS);
    // R5: the rejected deal's message is not deal mail
    expect(s.emails.dealLinked).toBe(N_DEALS * 3);
    expect(s.emails.contentPositives).toBe(N_DEALS * 3);
    expect(s.emails.trueDetection).toBe(N_DEALS * 2);

    const subject = value(s, "anchor.subject");
    expect(subject.newsletter).toMatchObject({ k: 0, n: N_NEWSLETTERS });
    // the old rules flag every newsletter on the same emails
    expect(subject.newsletterBaseline).toMatchObject({ k: N_NEWSLETTERS, n: N_NEWSLETTERS });
    expect(subject.positives).toMatchObject({ k: N_DEALS * 2, n: N_DEALS * 3 });
    expect(subject.gate).toMatchObject({ trueKept: N_DEALS, trueLost: 0, unmeasured: 0 });
    expect(subject.verdict).toBe("passes");
  });

  it("R6: form signals count only emails with attachment text; file names only emails with attachments", async () => {
    seedWorld();
    const s = await signalPass();
    expect(s.textCoverage.newsletter).toEqual({ emails: N_NEWSLETTERS, withAttachments: 1, withAttachmentText: 0 });
    expect(s.textCoverage.contentPositives).toEqual({ emails: N_DEALS * 3, withAttachments: 1, withAttachmentText: 1 });
    const forms = value(s, "forms.anyMatch");
    expect(forms.newsletter.n).toBe(0);
    expect(forms.positives).toMatchObject({ k: 0, n: 1 });
    expect(forms.verdict).toBe("not_enough_data");
    expect(value(s, "filename.other").newsletter).toMatchObject({ k: 1, n: 1 });
  });
});

describe("S2 (C6) sender-tier positives come from true detections only", () => {
  it("the deal contact's own (deal-linked) mail never enters the sender-tier positives", async () => {
    const w = seedWorld();
    const s = await signalPass();
    const dc = value(s, "sender.dealContact");
    // true-detection mail is from agents, who are not deal contacts
    expect(dc.positives).toEqual({ k: 0, n: N_DEALS * 2, interval: wilsonInterval(0, N_DEALS * 2) });
    // positive control: the client mail IS dealContact tier and IS deal-linked
    expect(w.clientMailIds).toHaveLength(N_DEALS);
    const stageAny = value(s, "stage.any");
    expect(stageAny.positives.n).toBe(N_DEALS * 3);
  });
});

describe("S3 keep bar", () => {
  const r = (k: number, n: number) => ({ k, n, interval: wilsonInterval(k, n) });
  const gate = (trueKept: number, trueLost: number) => ({
    trueKept,
    trueLost,
    knownWrongDropped: 0,
    knownWrongTotal: 0,
    cleanupNoDropped: 0,
    cleanupNoTotal: 0,
    cleanupYesLost: 0,
    cleanupYesTotal: 0,
    unmeasured: 0,
  });

  it("a signal that never fires on deal mail does not pass, even with a perfect gate and no newsletter hits", () => {
    expect(keepBar(r(0, 40), r(40, 40), r(0, 60), gate(20, 0), true)).toEqual({
      verdict: "fails",
      reasons: ["positive_fire_rate"],
    });
  });

  it("passes only with every condition met", () => {
    expect(keepBar(r(0, 40), r(40, 40), r(30, 60), gate(20, 0), true)).toEqual({ verdict: "passes", reasons: [] });
    expect(keepBar(r(0, 40), r(40, 40), r(30, 60), gate(19, 2), true).reasons).toEqual(["true_lost"]);
    expect(keepBar(r(20, 40), r(20, 40), r(30, 60), gate(20, 0), true).reasons).toEqual(["newsletter_rate"]);
  });

  it("minimum n: too few emails or detections is 'not enough data', never a pass", () => {
    expect(keepBar(r(0, KEEP_BAR.minN - 1), r(29, 29), r(30, 60), gate(20, 0), true)).toEqual({
      verdict: "not_enough_data",
      reasons: ["newsletter_n"],
    });
    expect(keepBar(r(0, 40), r(40, 40), r(5, 10), gate(5, 0), true)).toEqual({
      verdict: "not_enough_data",
      reasons: ["positive_n", "true_detections_n"],
    });
  });

  it("end to end: a value that never fires anywhere does not pass", async () => {
    seedWorld();
    const s = await signalPass();
    const never = value(s, "sender.platform");
    expect(never.positives.k).toBe(0);
    expect(never.newsletter.k).toBe(0);
    expect(never.verdict).not.toBe("passes");
  });
});

describe("S4 (R4) time limit", () => {
  it("stops the pass and every verdict reads 'not enough data' (incomplete)", async () => {
    seedWorld();
    let t = 0;
    const s = await signalPass({ nowMs: () => (t += 1_000), timeLimitMs: 2_500 });
    expect(s.complete).toBe(false);
    expect(s.stoppedBy).toBe("time");
    expect(s.values.length).toBeGreaterThan(30);
    for (const v of s.values) {
      expect(v.verdict).toBe("not_enough_data");
      expect(v.reasons).toContain("incomplete");
    }
    expect(formatSignalLines(s)[0]).toContain("stopped early (time limit 2500 ms)");
  });
});

describe("S5 privacy", () => {
  it("the record and its Copy lines carry no address, street, subject or sender", async () => {
    seedWorld();
    const s = await signalPass();
    const text = JSON.stringify(s) + "\n" + formatSignalLines(s).join("\n");
    // positive control: the seeded mail does contain these
    expect(db.prepare(`SELECT COUNT(*) AS n FROM emails WHERE subject LIKE '%Canarytest%'`).get()).toEqual({ n: 40 });
    for (const needle of ["@", "Canarytest", "canarytest", "digest", "brokerage", "Quick question", "notes.pdf", "flyer"]) {
      expect(text).not.toContain(needle);
    }
    expect(formatSignalLines(null)).toEqual(["Signals (measured only): not available"]);
  });
});
