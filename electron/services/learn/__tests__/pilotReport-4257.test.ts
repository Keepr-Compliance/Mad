/**
 * @jest-environment node
 *
 * BACKLOG-4257 PR B — the Learn pilot report, schema 2 (signal counts).
 *
 *   C1/R8  a schema-2 report built from a REAL signal pass over a seeded mailbox
 *          whose subjects, bodies, senders, recipients, attachment names,
 *          attachment text and form text carry canaries: the signals block is
 *          first shown to be non-trivial, then every leaf is an integer 0..10^7
 *          or a boolean (three string slots, all schema 1), and no key or string
 *          carries "@", a domain shape or a canary.
 *   C2     the key tree is PILOT_SIGNAL_VALUE_NAMES; drift vs SIGNAL_VALUES (ids
 *          split on "."); parity vs the migration's ARRAY text (value names,
 *          gate, coverage, emails, top-level signals keys).
 *   C5     schema 2 minus `signals`, schema 1 = the schema-1 build, key order too;
 *          `schema1` is that build.
 *   C4     no / null / incomplete signals -> the schema-1 report, unchanged.
 *   C9     the max-valued schema 2 (build.py's shape) = 28,299 compact and
 *          30,802 jsonb-text bytes (keepr-test octet_length, SR R18) and builds;
 *          jsonbTextLength is exact on strings holding ':' and ','.
 *   C10/R3 signalsVersion 7 -> schema 1; termsVersion 7 -> schema 2 carrying 7.
 *   R6     an extra key at EVERY object node of a valid schema-2 report is refused.
 *   BASE   the per-family baseline: values disagreeing -> schema 1.
 *
 * Synthetic data only: "Canary*" tokens, reserved domains.
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
import { signalLoadersFor } from "../../db/learnSignalsDb";
import { scoreSignals, SIGNAL_VALUES, vendorRoleDomains, type SignalScore } from "../signalScoring";
import {
  buildPilotReport,
  buildPilotSignals,
  jsonbTextLength,
  PILOT_MAX_BYTES_V2,
  PILOT_SIGNAL_FAMILIES,
  PILOT_SIGNAL_VALUE_NAMES,
  PilotReportSchema,
  PilotReportV2Schema,
  PilotSignalsSchema,
} from "../pilotReport";
import { BUNDLED_SENDER_RULES } from "../../../utils/senderFilter/bundledRules";
import { buildKeepSets } from "../../../utils/senderFilter/senderFilter";
import { insertStoredEmail } from "../../__tests__/helpers/storedEmail-4175";
import { fixtureReport, scoreFromFixture, syntheticSignals } from "../../__tests__/helpers/pilotFixtureScore-4257";
import { fixtureText } from "../../formRecognition/__tests__/fixtures/nwmlsHeaders";
import { AZ5_AAR_RPC } from "../../formRecognition/__tests__/fixtures/azHeaders";

const REPO = nodePath.join(__dirname, "..", "..", "..", "..");
const MIGRATION = nodePath.join(REPO, "supabase", "migrations", "20261117120000_backlog_4257_learn_pilot_signals.sql");
const USER = "user-4257-pr-b";
const NOW = Date.UTC(2026, 10, 1, 12);
const MAXI = 10_000_000;
const run = (q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));
const noYield = () => Promise.resolve();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Every token the seed writes into mail content; none may reach the report. */
const CANARIES = [
  "Canarytest",
  "Canarybody",
  "Canarysender",
  "Canaryrecipient",
  "Canaryfile",
  "Canaryform",
  "Canarynews",
  "Residential Resale",
  "Arizona",
  "Testville",
  "example",
];

// ---- seeded mailbox (the learnSignals-4257 shape, plus attachment and form canaries) ----

let seq = 0;
function mail(sender: string, day: number, subject: string, body: string, recipients?: string): string {
  seq += 1;
  const id = `e-4257b-${String(seq).padStart(4, "0")}`;
  insertStoredEmail(db, {
    id,
    userId: USER,
    sender,
    subject,
    bodyPlain: body,
    recipients,
    hasAttachments: false,
    sentAt: `2026-06-${String(1 + (day % 28)).padStart(2, "0")}T10:00:00.000Z`,
  });
  return id;
}
function link(txn: string, emailId: string): void {
  run(
    `INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id) VALUES (?, ?, ?, ?, ?)`,
    `c-${emailId}`,
    USER,
    txn,
    emailId,
    `th-${emailId}`,
  );
}
function attach(emailId: string, filename: string, text: string | null): void {
  run(
    `INSERT INTO attachments (id, email_id, filename, mime_type, file_size_bytes, text_content) VALUES (?, ?, ?, 'application/pdf', 1234, ?)`,
    `att-${emailId}-${filename.length}`,
    emailId,
    filename,
    text,
  );
}
const streetOf = (i: number) => `${4200 + i} Canarytest Way, Testville, ZZ 00000`;

function seed(): void {
  seq = 0;
  for (let i = 1; i <= 20; i++) {
    const t = `t-4257b-${i}`;
    const a = streetOf(i);
    run(
      `INSERT INTO transactions (id, user_id, property_address, status, detection_status, started_at, closed_at) VALUES (?, ?, ?, 'active', 'confirmed', '2026-01-01', '2026-12-31')`,
      t,
      USER,
      a,
    );
    run(`INSERT OR IGNORE INTO contacts (id, user_id, display_name) VALUES (?, ?, 'Test Contact')`, `ct-${i}`, USER);
    run(`INSERT OR IGNORE INTO contact_emails (id, contact_id, email) VALUES (?, ?, ?)`, `ce-${i}`, `ct-${i}`, `canaryrecipient${i}@client.example`);
    run(
      `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role, specific_role) VALUES (?, ?, ?, 'client', 'client')`,
      `tc-${i}`,
      t,
      `ct-${i}`,
    );
    for (let j = 0; j < 2; j++) {
      const id = mail(
        `canarysender${i}@brokerage.example`,
        i + j,
        `Offer accepted on ${a}`,
        `Canarybody: offer accepted on ${a}. Escrow closing, buyer inspection next week.`,
        `canaryrecipient${i}@client.example`,
      );
      link(t, id);
      if (j === 0) {
        attach(id, `Canaryfile ${i} Purchase Agreement.pdf`, `${fixtureText(AZ5_AAR_RPC)}\nCanaryform note for ${a}`);
      }
    }
  }
  const news: string[] = [];
  for (let i = 0; i < 30; i++) {
    news.push(
      mail(
        "canarynews@digest.example",
        i,
        `Canarynews market digest ${i}`,
        "New listing and offer news this week: escrow tips, closing costs and inspection advice. Unsubscribe.",
      ),
    );
  }
  insertBulkSample(USER, news.map((id) => ({ source: "gmail" as const, external_id: `ext-${id}` })), 1);
  for (const r of db.prepare(`SELECT id FROM learn_bulk_answers WHERE user_id = ?`).all(USER) as Array<{ id: string }>) {
    expect(answerBulk(USER, r.id, "newsletter_spam")).toBe(true);
  }
}

async function realPass(): Promise<SignalScore> {
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
  });
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(nodePath.join(REPO, "electron", "database", "schema.sql"), "utf8"));
  db.pragma("foreign_keys = ON");
  run(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'b@example.test', 'google', 'oa-b')`, USER);
});
afterEach(() => db.close());

// ---- sweeps (pilotReport-4219 P1) ------------------------------------------------

function leaves(v: unknown, path = ""): Array<[string, unknown]> {
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, `${path}[${i}]`));
  if (v !== null && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => leaves(x, path ? `${path}.${k}` : k));
  return [[path, v]];
}
function allKeys(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(allKeys);
  if (v !== null && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [k, ...allKeys(x)]);
  return [];
}
/** Every object node (array elements included), as a path of keys / indexes. */
function objectPaths(v: unknown, path: Array<string | number> = []): Array<Array<string | number>> {
  if (Array.isArray(v)) return v.flatMap((x, i) => objectPaths(x, [...path, i]));
  if (v !== null && typeof v === "object") {
    return [path, ...Object.entries(v).flatMap(([k, x]) => objectPaths(x, [...path, k]))];
  }
  return [];
}
function at(root: unknown, path: Array<string | number>): Record<string, unknown> {
  return path.reduce<unknown>((o, k) => (o as Record<string | number, unknown>)[k], root) as Record<string, unknown>;
}

function v1(): ReturnType<typeof scoreFromFixture> & { report: Record<string, unknown> } {
  const { score, detector } = scoreFromFixture();
  const built = buildPilotReport(score, detector, "2.46.2");
  if (!built.ok) throw new Error("fixture did not build");
  return { score, detector, report: built.report };
}

describe("C1/R8 a schema-2 report from a REAL signal pass carries counts only", () => {
  it("non-trivial block first; then every leaf, key and string is swept", async () => {
    seed();
    const s = await realPass();
    expect(s.complete).toBe(true);
    const { score, detector } = scoreFromFixture();
    const built = buildPilotReport(score, detector, "2.46.2", s);
    expect(built.ok && built.signalsLeftOut).toBe(undefined);
    if (!built.ok) throw new Error("not built");
    expect(built.report.schema).toBe(2);
    const sig = (built.report as unknown as { signals: unknown }).signals as {
      emails: Record<string, number>;
      text_coverage: Record<string, Record<string, number>>;
      values: Record<string, Record<string, { newsletter: { k: number; n: number }; positives: { k: number; n: number } }>>;
    };

    // R8: the pass read the canary mail (a zero block would pass every sweep below).
    expect(sig.emails.content_positives).toBeGreaterThan(0);
    expect(sig.emails.newsletter).toBe(30);
    expect(sig.emails.true_detection).toBeGreaterThan(0);
    expect(sig.text_coverage.content_positives.with_attachment_text).toBe(20);
    for (const fam of PILOT_SIGNAL_FAMILIES) {
      const fired = Object.values(sig.values[fam]).filter((v) => v.positives.k > 0 || v.newsletter.k > 0);
      expect([fam, fired.length > 0]).toEqual([fam, true]);
    }
    expect(sig.values.filename.purchaseAgreement.positives.k).toBe(20);
    expect(sig.values.forms.purchase_agreement.positives.k).toBe(20);
    expect(sig.values.anchor.subject.positives.k).toBeGreaterThan(0);
    expect(sig.values.stage.offer.positives.k).toBeGreaterThan(0);

    // Leaves: ints 0..10^7 or booleans; the only strings are the three schema-1 slots.
    const strings = leaves(built.report).filter(([, v]) => typeof v === "string");
    expect(new Set(strings.map(([p]) => p.replace(/\[\d+\]/g, "[]")))).toEqual(
      new Set(["app_version", "sender_rules_source", "census.learn_questions.mailboxes[].provider", "census.detector.mailboxes[].provider"]),
    );
    const sigLeaves = leaves(sig, "signals");
    expect(sigLeaves.length).toBeGreaterThan(40 * 13);
    for (const [p, v] of leaves(built.report)) {
      if (typeof v === "string" || typeof v === "boolean") continue;
      expect([p, Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAXI]).toEqual([p, true]);
    }
    // P1: no "@", no domain-shaped token in any key or string; no canary anywhere.
    const texts = [...allKeys(built.report), ...strings.map(([, v]) => v as string)];
    expect(texts.length).toBeGreaterThan(500);
    expect(texts.filter((t) => t.includes("@") || /[a-z0-9-]+\.[a-z]{2,}/i.test(t))).toEqual([]);
    const json = JSON.stringify(built.report);
    for (const c of CANARIES) expect([c, json.toLowerCase().includes(c.toLowerCase())]).toEqual([c, false]);
    // The canaries ARE in the mail the pass read (the sweep is not vacuous).
    expect(db.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE text_content LIKE '%Canaryform%'`).get()).toEqual({ n: 20 });
  });
});

describe("C2 key tree = PILOT_SIGNAL_VALUE_NAMES = SIGNAL_VALUES = the migration", () => {
  it("drift: SIGNAL_VALUES ids split on '.', same order", () => {
    const fromScoring = SIGNAL_VALUES.map((v) => v.id);
    const fromNames = PILOT_SIGNAL_FAMILIES.flatMap((f) => PILOT_SIGNAL_VALUE_NAMES[f].map((n) => `${f}.${n}`));
    expect(fromScoring).toEqual(fromNames);
    for (const v of SIGNAL_VALUES) expect(v.family).toBe(v.id.split(".")[0]);
    expect(fromNames).toHaveLength(40);
  });

  it("parity: the migration's ARRAYs and key lists", () => {
    const sql = fs.readFileSync(MIGRATION, "utf8");
    const arr = (name: string): string[] => {
      const m = new RegExp(`  ${name} CONSTANT TEXT\\[\\] := ARRAY\\[([^\\]]*)\\];`).exec(sql);
      if (!m) throw new Error(`no ARRAY ${name}`);
      return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    };
    for (const f of PILOT_SIGNAL_FAMILIES) expect([f, arr(`v_${f}`)]).toEqual([f, [...PILOT_SIGNAL_VALUE_NAMES[f]]]);
    expect(arr("v_families")).toEqual([...PILOT_SIGNAL_FAMILIES]);
    const shape = PilotSignalsSchema.shape;
    const keysOf = (o: object) => Object.keys(o);
    expect(arr("v_gate")).toEqual(keysOf(shape.values.shape.anchor.shape.subject.shape.gate.shape));
    expect(arr("v_coverage")).toEqual(keysOf(shape.text_coverage.shape.newsletter.shape));
    const top = /_sender_rule_set_keys_exact\(s, ARRAY\[([^\]]*)\]\)/.exec(sql);
    expect([...(top?.[1] ?? "").matchAll(/'([^']*)'/g)].map((x) => x[1])).toEqual(keysOf(shape));
    const emails = /_learn_pilot_counts_ok\(s->'emails', ARRAY\[([^\]]*)\]\)/.exec(sql);
    expect([...(emails?.[1] ?? "").matchAll(/'([^']*)'/g)].map((x) => x[1])).toEqual(keysOf(shape.emails.shape));
    expect(keysOf(shape.text_coverage.shape)).toEqual(["newsletter", "content_positives", "true_detection"]);
    expect(keysOf(shape.baseline.shape)).toEqual([...PILOT_SIGNAL_FAMILIES]);
    for (const f of PILOT_SIGNAL_FAMILIES) {
      expect(keysOf(shape.values.shape[f].shape)).toEqual([...PILOT_SIGNAL_VALUE_NAMES[f]]);
    }
    expect(sql).toContain("IF octet_length(p::text) > 65536 THEN");
    expect(PILOT_MAX_BYTES_V2).toBe(65_536);
  });
});

describe("C5 schema 2 = schema 1 + signals, nothing else moves", () => {
  it("minus signals, schema 1: JSON-identical to the schema-1 build (key order included)", () => {
    const base = v1();
    const built = buildPilotReport(base.score, base.detector, "2.46.2", syntheticSignals(3));
    if (!built.ok) throw new Error("not built");
    expect(built.report.schema).toBe(2);
    const { signals, ...rest } = built.report as Record<string, unknown>;
    expect(signals).toBeDefined();
    expect(JSON.stringify({ ...rest, schema: 1 })).toBe(JSON.stringify(base.report));
    expect(Object.keys(built.report).slice(-1)).toEqual(["signals"]);
    expect(Object.keys(built.report)[0]).toBe("schema");
    expect(JSON.stringify(built.schema1)).toBe(JSON.stringify(base.report));
    expect(built.report).toEqual({ ...base.report, schema: 2, signals });
  });
});

describe("C4 no usable signals -> the schema-1 report, unchanged", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["incomplete", syntheticSignals(1, { complete: false, stoppedBy: "time" })],
  ])("%s", (_name, s) => {
    const base = v1();
    const built = buildPilotReport(base.score, base.detector, "2.46.2", s as SignalScore | null | undefined);
    if (!built.ok) throw new Error("not built");
    expect(JSON.stringify(built.report)).toBe(JSON.stringify(base.report));
    expect(built.schema1).toBeUndefined();
  });

  it("a value list that is not PILOT_SIGNAL_VALUE_NAMES -> schema 1", () => {
    const base = v1();
    const s = syntheticSignals(2);
    const extra = syntheticSignals(2, { values: [...s.values, { ...s.values[0], id: "anchor.newThing" }] });
    const missing = syntheticSignals(2, { values: s.values.slice(1) });
    const renamed = syntheticSignals(2, { values: [{ ...s.values[0], id: "anchor.other" }, ...s.values.slice(1)] });
    for (const bad of [extra, missing, renamed]) {
      const built = buildPilotReport(base.score, base.detector, "2.46.2", bad);
      if (!built.ok) throw new Error("not built");
      expect(built.report.schema).toBe(1);
      expect(built.signalsLeftOut).toMatch(/^values/);
    }
  });
});

describe("BASE the baseline is per family", () => {
  it("one family's first value; values that disagree -> schema 1", () => {
    const s = syntheticSignals(4);
    const ok = buildPilotSignals(s);
    if (!ok.ok) throw new Error(ok.reason);
    const block = ok.signals as { baseline: Record<string, { k: number; n: number }> };
    for (const f of PILOT_SIGNAL_FAMILIES) {
      const first = s.values.find((v) => v.family === f);
      expect(block.baseline[f]).toEqual({ k: first?.newsletterBaseline.k, n: first?.newsletterBaseline.n });
    }
    const values = s.values.map((v) => (v.id === "stage.any" ? { ...v, newsletterBaseline: { k: 999, n: 999, interval: null } } : v));
    expect(buildPilotSignals({ ...s, values })).toEqual({ ok: false, reason: "baseline.stage" });
  });
});

describe("C10/R3 versions come from the pass; an unknown signals_version is never sent as schema 2", () => {
  it("signalsVersion 7 -> schema 1, JSON-identical to the schema-1 build", () => {
    const base = v1();
    const built = buildPilotReport(base.score, base.detector, "2.46.2", syntheticSignals(5, { signalsVersion: 7 }));
    if (!built.ok) throw new Error("not built");
    expect(JSON.stringify(built.report)).toBe(JSON.stringify(base.report));
    expect(built.signalsLeftOut).toBe("signals.signals_version");
  });

  it("termsVersion 7 -> schema 2 carrying 7 (the server does not pin terms_version)", () => {
    const base = v1();
    const built = buildPilotReport(base.score, base.detector, "2.46.2", syntheticSignals(5, { termsVersion: 7 }));
    if (!built.ok) throw new Error("not built");
    expect(built.report.schema).toBe(2);
    expect((built.report as { signals: { terms_version: number; signals_version: number } }).signals).toMatchObject({
      terms_version: 7,
      signals_version: 1,
    });
  });
});

describe("R6 strict at every node", () => {
  it("an extra key at ANY object node of a valid schema-2 report is refused", () => {
    const base = v1();
    const built = buildPilotReport(base.score, base.detector, "2.46.2", syntheticSignals(6));
    if (!built.ok || built.report.schema !== 2) throw new Error("not schema 2");
    expect(PilotReportV2Schema.safeParse(built.report).success).toBe(true);
    const paths = objectPaths(built.report);
    const inSignals = paths.filter((p) => p[0] === "signals");
    // root + signals + emails + text_coverage(1+3) + baseline(1+5) + values(1+5+40*4)
    expect(inSignals).toHaveLength(1 + 1 + 4 + 6 + 1 + 5 + 40 * 4);
    expect(paths.length).toBeGreaterThan(inSignals.length + 40);
    const accepted: string[] = [];
    for (const p of paths) {
      const r = clone(built.report);
      at(r, p).x_extra = 0;
      if (PilotReportV2Schema.safeParse(r).success) accepted.push(p.join("."));
    }
    expect(accepted).toEqual([]);
    // The schema-1 schema refuses `signals` outright.
    expect(PilotReportSchema.safeParse({ ...built.report, schema: 1 }).success).toBe(false);
  });
});

describe("C9 size: the client measures what the server measures", () => {
  /** build.py's max2 (PR A harness): every int 10^7, booleans false, longest strings, 10 + 10 mailboxes. */
  function max2(): Record<string, unknown> {
    const maxed = (o: unknown): unknown => {
      if (typeof o === "boolean") return false;
      if (typeof o === "number") return MAXI;
      if (Array.isArray(o)) return o.map(maxed);
      if (o !== null && typeof o === "object") return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, maxed(v)]));
      return o;
    };
    const base = maxed(fixtureReport()) as Record<string, unknown> & {
      answers_by_rule_version: unknown[];
      census: Record<string, { mailboxes: Array<Record<string, unknown>> }>;
    };
    base.schema = 1;
    base.sender_rules_version = MAXI;
    base.app_version = "9999.9999.999999";
    base.sender_rules_source = "download";
    base.answers_by_rule_version = Array.from({ length: 10 }, () => clone(base.answers_by_rule_version[0]));
    for (const blk of Object.values(base.census)) {
      const mb = blk.mailboxes[0];
      blk.mailboxes = Array.from({ length: 10 }, () => ({ ...clone(mb), provider: "outlook" }));
    }
    const sig = buildPilotSignals(syntheticSignals(1));
    if (!sig.ok) throw new Error(sig.reason);
    return { ...base, schema: 2, signals: { ...(maxed(sig.signals) as object), signals_version: 1 } };
  }

  it("max-valued schema 2: 28,299 compact, 30,802 jsonb text (keepr-test octet_length), valid, under 65,536", () => {
    const m = max2();
    expect(PilotReportV2Schema.safeParse(m).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(m), "utf8")).toBe(28_299);
    expect(jsonbTextLength(m)).toBe(30_802);
    expect(jsonbTextLength(m)).toBeLessThanOrEqual(PILOT_MAX_BYTES_V2);
  });

  it("jsonbTextLength: one byte per ':' and ',' outside strings, none inside, escapes respected", () => {
    // Postgres jsonb::text of this value is `{"a": [1, 2], "b": "x:,y\"", "c": {"d": true}}`.
    const pg = `{"a": [1, 2], "b": "x:,y\\"", "c": {"d": true}}`;
    expect(jsonbTextLength({ a: [1, 2], b: 'x:,y"', c: { d: true } })).toBe(Buffer.byteLength(pg, "utf8"));
    expect(jsonbTextLength({})).toBe(2);
    expect(jsonbTextLength({ s: "é" })).toBe(Buffer.byteLength(`{"s": "é"}`, "utf8"));
  });
});
