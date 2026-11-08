/**
 * @jest-environment node
 *
 * BACKLOG-4180 MEASUREMENT PROBE — not a gate. Skipped unless KEEPR_PERF_4180=1.
 *
 * The Windows freeze on "Edit Contacts -> pick a contact" and on opening Clients & Contacts.
 * Drives the REGISTERED IPC handlers (captured from ipcMain.handle) against a seeded,
 * encrypted better-sqlite3 store built from the real schema.sql, in two modes:
 *   - pool NOT ready (main-thread fallback)
 *   - pool ready (real contactQueryWorker, bundled with esbuild as in probe-3868)
 * For each IPC it prints wall ms, max event-loop stall (= longest main-thread block), the
 * main-thread SQL time per statement (db.prepare is wrapped on the main connection only;
 * the worker opens its own connection, so worker SQL is NOT counted), and which worker
 * query types ran.
 *
 * Fixture shapes are transcribed from the producers:
 *   messages      iPhoneSyncStorageService.ts:816-859 (participants JSON, participants_flat = handle digits, ios-chat-<id>)
 *   external rows externalContactDbService.upsertFromiPhone (real writer)
 *   emails        emailDbService.createEmailSync (real writer; derives email_participants)
 *   phone_last_message  messageDbService.backfillPhoneLastMessageTableSync (real writer)
 *   saved contacts      contacts:import handler fed with contacts:get-available rows (real flow)
 *
 * Run (Node ABI driver — requires a worktree-local node_modules COPY rebuilt for node; never the shared tree):
 *   KEEPR_PERF_4180=1 KEEPR_PERF_4180_SIZE=M npx jest --bail=0 --testTimeout=1800000 \
 *     electron/__tests__/perf/contactAddFreeze.probe-4180.test.ts
 *   SIZE: M = 2k contacts / 20k address-book / 100k texts / 2k emails
 *         L = 10k contacts / 50k address-book / 300k texts / 5k emails
 * Handles are reserved 555-01xx numbers and .test addresses (public repo).
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import * as inspector from "inspector";
import { monitorEventLoopDelay } from "perf_hooks";
import type { Database as DatabaseType } from "better-sqlite3";

const mockHandlers = new Map<string, (...args: unknown[]) => unknown>();

jest.mock("electron", () => ({
  app: { isPackaged: false, getPath: jest.fn(() => "/tmp/keepr-4180-probe"), getVersion: () => "0.0.0" },
  ipcMain: {
    handle: jest.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      mockHandlers.set(channel, fn);
    }),
    on: jest.fn(),
    removeHandler: jest.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  shell: {},
}));
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  setUser: jest.fn(),
  setTag: jest.fn(),
}));
jest.mock("../../services/logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  for (const f of Object.values(m)) f.mockResolvedValue(undefined);
  return { __esModule: true, default: m, logService: m };
});
// Preferences come from Supabase: answer at once (offline, no 6 s race timeout), with the
// Windows user's effective sources: iPhone contacts on (the Windows default), macOS off
// (no macOS source on Windows; also keeps the darwin-only address-book read from running).
jest.mock("../../services/supabaseService", () => {
  const target: Record<string | symbol, unknown> = {
    getPreferences: async () => ({ contactSources: { direct: { iphoneContacts: true, macosContacts: false } } }),
  };
  const svc = new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "then" || k === "__esModule" || typeof k === "symbol") return undefined;
      return async () => null;
    },
  });
  return { __esModule: true, default: svc };
});
// The macOS address-book read must never run on this machine.
const mockGetContactNames = jest.fn(async () => {
  throw new Error("PROBE: getContactNames must not run");
});
jest.mock("../../services/contactsService", () => ({
  ...jest.requireActual("../../services/contactsService"),
  getContactNames: (...a: unknown[]) => mockGetContactNames(...(a as [])),
}));
jest.mock("../../handlers/featureGateHandlers", () => ({
  ...jest.requireActual("../../handlers/featureGateHandlers"),
  resolveContactInferenceState: async () => "allowed",
  isContactInferenceAllowed: async () => true,
}));

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const REPO = nodePath.resolve(__dirname, "..", "..", "..");
const PERF = process.env.KEEPR_PERF_4180 === "1";
function loadDriver(): (new (file: string) => DatabaseType) | null {
  if (!PERF) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(DRIVER);
}
const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

const SIZE = process.env.KEEPR_PERF_4180_SIZE === "L" ? "L" : "M";
const CFG = SIZE === "L"
  ? { contacts: 10_000, external: 50_000, messages: 300_000, threads: 8_000, emails: 5_000 }
  : { contacts: 2_000, external: 20_000, messages: 100_000, threads: 4_000, emails: 2_000 };
const TARGETS = 50; // unimported address-book people with a few texts and no email (the symptom contact)
const TEXTS_PER_TARGET = 3;

const USER = "41800000-0000-4000-8000-000000000001"; // pii-allow-uuid: invented, not from any live row
const KEY_HEX = "4180".repeat(16);
const USER_HANDLE_DIGITS = "19995550100";

function phoneOf(i: number): string {
  // reserved 555-01xx; area code varies per hundred people (200..699 for 50k)
  return `+1${200 + Math.floor(i / 100)}5550${String(100 + (i % 100)).padStart(3, "0")}`;
}
const targetIndex = (k: number) => CFG.external - 1 - k;
const isTarget = (i: number) => i >= CFG.external - TARGETS;
const hasEmail = (i: number) => !isTarget(i) && i % 5 < 2;

// ---------------------------------------------------------------- instrumentation
type SqlStat = { ms: number; calls: number; src: string; params: unknown[] };
let sqlStats = new Map<string, SqlStat>();
function wrapPrepare(db: DatabaseType): void {
  const orig = db.prepare.bind(db);
  (db as unknown as { prepare: (s: string) => unknown }).prepare = (src: string) => {
    const st = orig(src) as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of ["all", "get", "run"]) {
      const fn = st[m].bind(st);
      st[m] = (...a: unknown[]) => {
        const t0 = performance.now();
        try {
          return fn(...a);
        } finally {
          const dt = performance.now() - t0;
          const key = src.replace(/\s+/g, " ").trim().slice(0, 110);
          const s = sqlStats.get(key) ?? { ms: 0, calls: 0, src, params: a };
          s.ms += dt;
          s.calls++;
          sqlStats.set(key, s);
        }
      };
    }
    return st;
  };
}

let workerCalls: string[] = [];
type Result = { label: string; wall: number; stall: number; mainSql: number; worker: string[]; top: Array<[string, SqlStat]> };
const results: Result[] = [];

async function measure<T>(label: string, work: () => Promise<T> | T, opts: { profile?: boolean } = {}): Promise<T> {
  sqlStats = new Map();
  workerCalls = [];
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  await new Promise((r) => setTimeout(r, 20));
  let session: inspector.Session | null = null;
  const post = (m: string, p?: object) =>
    new Promise<unknown>((res, rej) => session!.post(m, p ?? {}, (e, r) => (e ? rej(e) : res(r))));
  if (opts.profile) {
    session = new inspector.Session();
    session.connect();
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: 500 });
    await post("Profiler.start");
  }
  const t0 = performance.now();
  const value = await work();
  const wall = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 20));
  h.disable();
  const stall = h.max / 1e6;
  const top = [...sqlStats.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 6);
  const mainSql = [...sqlStats.values()].reduce((a, s) => a + s.ms, 0);
  results.push({ label, wall, stall, mainSql, worker: [...workerCalls], top });
  const out = [`[4180 ${SIZE}] ${label}: wall ${wall.toFixed(0)} ms, max stall ${stall.toFixed(0)} ms, main SQL ${mainSql.toFixed(0)} ms, worker [${workerCalls.join(",")}]`];
  for (const [k, s] of top) out.push(`      ${s.ms.toFixed(0)} ms x${s.calls}  ${k}`);
  if (session) {
    const { profile } = (await post("Profiler.stop")) as {
      profile: { nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }>; samples: number[]; timeDeltas: number[] };
    };
    session.disconnect();
    const selfUs = new Map<number, number>();
    profile.samples.forEach((id, i) => selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
    const parent = new Map<number, number>();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const repoElectron = REPO + "/electron/";
    const isRepo = (id: number) => {
      const u = byId.get(id)?.callFrame.url ?? "";
      return u.includes(repoElectron) && !/__tests__|dbTiming|wrappers|dbConnection/.test(u);
    };
    const byFrame = new Map<string, number>();
    for (const n of profile.nodes) {
      const us = selfUs.get(n.id) ?? 0;
      if (!us) continue;
      let id: number | undefined = n.id;
      while (id !== undefined && !isRepo(id)) id = parent.get(id);
      const f = id !== undefined ? byId.get(id)!.callFrame : n.callFrame;
      const key = `${f.functionName || "(anon)"} ${f.url.replace(REPO + "/", "")}:${f.lineNumber + 1}`;
      byFrame.set(key, (byFrame.get(key) ?? 0) + us);
    }
    out.push("    top self time (native SQL charged to the calling repo frame):");
    for (const [k, us] of [...byFrame.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) out.push(`      ${Math.round(us / 1000)} ms  ${k}`);
  }
  process.stderr.write(out.join("\n") + "\n");
  return value;
}

maybe(`BACKLOG-4180 contact add / Clients & Contacts on a large store (probe, size ${SIZE})`, () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let logMock: any;
  let txnId: string;

  const invoke = async <T = Record<string, unknown>>(channel: string, ...args: unknown[]): Promise<T> => {
    const fn = mockHandlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return (await fn({ sender: {} }, ...args)) as T;
  };

  beforeAll(async () => {
    dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-4180-probe-"));
    dbPath = nodePath.join(dir, "mad.db");
    db = new (Database as NonNullable<typeof Database>)(dbPath);
    db.pragma(`key = "x'${KEY_HEX}'"`);
    db.pragma("cipher_compatibility = 4");
    db.pragma("journal_mode = WAL");
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "../../database/schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner@example.test', 'google', 'o-4180')").run(USER);
    wrapPrepare(db);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../../services/db/core/dbConnection").setDb(db);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    logMock = require("../../services/logService").default;

    // Count worker query types without changing behaviour.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pool = require("../../workers/contactWorkerPool");
    const origQ = pool.queryContacts;
    jest.spyOn(pool, "queryContacts").mockImplementation((...a: unknown[]) => {
      workerCalls.push(`pool:${a[0]}`);
      return origQ(...a);
    });
    const origD = pool.queryOnDedicatedWorker;
    jest.spyOn(pool, "queryOnDedicatedWorker").mockImplementation((...a: unknown[]) => {
      workerCalls.push(`dedicated:${a[0]}`);
      return origD(...a);
    });

    const t0 = Date.now();
    // 1. Address book (iPhone sync on Windows) through the real writer.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const externalContactDb = require("../../services/db/externalContactDbService");
    const book = Array.from({ length: CFG.external }, (_, i) => ({
      name: `Person ${String(i).padStart(5, "0")} Probe`,
      phones: [phoneOf(i)],
      emails: hasEmail(i) ? [`person${i}@example.test`] : [],
      recordId: String(i + 1),
    }));
    externalContactDb.upsertFromiPhone(USER, book, "s-4180");

    // 2. Texts, iPhone-sync shape. Threads 0..threads-1 talk to address-book person t; targets get 3 texts each.
    const ins = db.prepare(
      `INSERT INTO messages (id, user_id, external_id, channel, direction, body_text, participants, participants_flat, thread_id, sent_at, message_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'text')`,
    );
    const put = (i: number, person: number, chat: string) => {
      const handle = phoneOf(person);
      const out = i % 2 === 1;
      ins.run(
        `m${i}`,
        USER,
        `guid-${i}`,
        i % 3 ? "imessage" : "sms",
        out ? "outbound" : "inbound",
        `message body ${i} about the closing and the inspection`,
        JSON.stringify({ from: out ? "me" : handle, to: out ? [handle] : ["me"] }),
        handle.replace(/\D/g, ""),
        `ios-chat-${chat}`,
        new Date(Date.UTC(2021, 0, 1) + (i % 1500) * 86400000).toISOString(),
      );
    };
    db.transaction(() => {
      let i = 0;
      for (let k = 0; k < TARGETS; k++) for (let j = 0; j < TEXTS_PER_TARGET; j++) put(i++, targetIndex(k), `t${k}`);
      for (; i < CFG.messages; i++) {
        const t = i % CFG.threads;
        put(i, t, String(t));
      }
    })();
    // 3. Emails through the real writer (derives email_participants).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const emailDb = require("../../services/db/emailDbService");
    db.transaction(() => {
      for (let e = 0; e < CFG.emails; e++) {
        const person = (e * 5) % CFG.contacts; // i%5===0 -> has an email
        emailDb.createEmailSync({
          user_id: USER,
          external_id: `gm-${e}`,
          source: "gmail",
          sender: `Person ${person} <person${person}@example.test>`,
          recipients: "owner@example.test",
          subject: `Re: offer ${e}`,
          body_plain: "see attached",
          thread_id: `gt-${e}`,
          sent_at: new Date(Date.UTC(2022, 0, 1) + (e % 900) * 86400000).toISOString(),
        });
      }
    })();
    // 4. phone_last_message through the real writer.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../../services/db/messageDbService").backfillPhoneLastMessageTableSync(USER);
    process.stderr.write(`[4180 ${SIZE}] seeded external/messages/emails in ${Date.now() - t0} ms\n`);

    // 5. Register the real handlers.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../../handlers/contactHandlers").registerContactHandlers(null);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../../handlers/transactionCrudHandlers").registerTransactionCrudHandlers(null);

    // 6. Saved contacts: import the first CFG.contacts address-book rows through the real flow.
    const t1 = Date.now();
    const avail = await invoke<{ success: boolean; contacts: Array<Record<string, unknown>> }>("contacts:get-available", USER);
    expect(avail.success).toBe(true);
    process.stderr.write(`[4180 ${SIZE}] seed picker: ${avail.contacts.length} rows; sample ${JSON.stringify(avail.contacts[0])}; warns ${JSON.stringify(logMock.warn.mock.calls.slice(0, 3))}\n`);
    const byRecord = new Map(avail.contacts.map((c) => [String(c.externalRecordId), c]));
    for (let start = 0; start < CFG.contacts; start += 5000) {
      const batch: Array<Record<string, unknown>> = [];
      for (let i = start; i < Math.min(CFG.contacts, start + 5000); i++) {
        const row = byRecord.get(String(i + 1));
        if (row) batch.push(row);
      }
      const r = await invoke<{ success: boolean; error?: string }>("contacts:import", USER, batch);
      if (!r.success) throw new Error(`seed import failed: ${r.error}`);
    }
    // the communication-dates backfill has run on these profiles; stamp it so it does not fire mid-measurement
    db.prepare("UPDATE contacts SET last_inbound_at = '2024-01-01T00:00:00Z' WHERE user_id = ? AND is_imported = 1").run(USER);
    const saved = db.prepare("SELECT COUNT(*) n FROM contacts WHERE user_id = ? AND is_imported = 1").get(USER) as { n: number };
    const links = db.prepare("SELECT COUNT(*) n FROM contact_source_links").get() as { n: number };
    process.stderr.write(`[4180 ${SIZE}] seeded ${saved.n} saved contacts (${links.n} crosswalk rows) via contacts:import in ${Date.now() - t1} ms\n`);
    expect(saved.n).toBe(CFG.contacts);

    // 7. A deal to add to (deal writes are audited; wire the audit service as authHandlers.ts:58 does).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../../services/auditService").default.initialize(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../../services/databaseService").default,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../../services/supabaseService").default,
    );
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const transactionService = require("../../services/transactionService").default;
    const created = await transactionService.createAuditedTransaction(USER, {
      property_address: "1420 Marlin Court",
      transaction_type: "purchase",
      started_at: "2021-01-01T00:00:00Z",
      contact_assignments: [{ contact_id: (db.prepare("SELECT id FROM contacts WHERE user_id = ? LIMIT 1").get(USER) as { id: string }).id, role: "buyer", role_category: "client", is_primary: true }],
    });
    txnId = created.id;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../../services/contactLinkingScheduler").cancelPendingContactLinking();
  }, 1_800_000);

  afterAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../../workers/contactWorkerPool").shutdownPool();
    db?.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
    process.stderr.write(`\n[4180 ${SIZE}] SUMMARY (label | wall ms | max stall ms | main SQL ms | worker)\n`);
    for (const r of results) process.stderr.write(`  ${r.label} | ${r.wall.toFixed(0)} | ${r.stall.toFixed(0)} | ${r.mainSql.toFixed(0)} | ${r.worker.join(",")}\n`);
  });

  async function startWorkerPool(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { build } = require("esbuild");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pool = require("../../workers/contactWorkerPool");
    const workerScript = nodePath.join(dir, "contactQueryWorker.js");
    await build({
      entryPoints: [nodePath.join(__dirname, "..", "..", "workers", "contactQueryWorker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: workerScript,
      plugins: [
        {
          name: "driver-from-repo",
          setup(b: { onResolve: (o: { filter: RegExp }, cb: () => { path: string; external: boolean }) => void }) {
            b.onResolve({ filter: /^better-sqlite3-multiple-ciphers$/ }, () => ({ path: DRIVER, external: true }));
          },
        },
      ],
      logLevel: "silent",
    });
    pool.setContactWorkerPathForTests(workerScript);
    await pool.initializePool(dbPath, KEY_HEX);
  }

  /** One Edit Contacts add, as the renderer drives it, plus Clients & Contacts. */
  async function addFlow(mode: string, k: number): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pool = require("../../workers/contactWorkerPool");
    process.stderr.write(`[4180 ${SIZE}] ---- mode ${mode}: isPoolReady()=${pool.isPoolReady()}\n`);
    const avail = await measure(`${mode} get-available (picker open)`, () =>
      invoke<{ success: boolean; contacts: Array<Record<string, unknown>> }>("contacts:get-available", USER),
    );
    expect(avail.success).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../../services/contactLinkingScheduler").cancelPendingContactLinking();
    const target = avail.contacts.find((c) => String(c.externalRecordId) === String(targetIndex(k) + 1));
    expect(target).toBeDefined();
    expect((target!.allEmails as string[]).length).toBe(0);

    logMock.info.mockClear();
    const imp = await measure(
      `${mode} contacts:import (1 contact, no email, ${TEXTS_PER_TARGET} texts) incl. linking`,
      () => invoke<{ success: boolean; contacts: Array<{ id: string }>; error?: string }>("contacts:import", USER, [target]),
    );
    expect(imp.success).toBe(true);
    const passLine = logMock.info.mock.calls.map((c: unknown[]) => String(c[0])).find((s: string) => (s.startsWith("[Contacts] import-scoped linking:") || s.startsWith("[Contacts] linking pass:")));
    const backfillLine = logMock.info.mock.calls.map((c: unknown[]) => String(c[0])).find((s: string) => /re-ran backfill|Backfilled/.test(s));
    process.stderr.write(`[4180 ${SIZE}] control: linking ran -> ${passLine ?? "NO LINKING LINE"}; backfill line -> ${backfillLine ?? "(none: no contact changed)"}\n`);
    expect(passLine).toBeDefined();
    const newId = imp.contacts[0].id;
    // the same import again (a second target), under the CPU profiler, for file:line attribution only
    const target2 = avail.contacts.find((c) => String(c.externalRecordId) === String(targetIndex(k + 10) + 1));
    await measure(`${mode} contacts:import [PROFILED, timing inflated]`, () => invoke("contacts:import", USER, [target2]), { profile: true });

    await measure(`${mode} get-sorted-by-activity (refresh)`, () => invoke("contacts:get-sorted-by-activity", USER, "1420 Marlin Court"));
    await measure(`${mode} get-available (refresh)`, () => invoke("contacts:get-available", USER));
    await measure(`${mode} get-available [PROFILED, timing inflated]`, () => invoke("contacts:get-available", USER), { profile: true });
    await measure(`${mode} refreshBothLists (both, in parallel)`, () =>
      Promise.all([invoke("contacts:get-sorted-by-activity", USER, "1420 Marlin Court"), invoke("contacts:get-available", USER)]),
    );
    const save = await measure(`${mode} batchUpdateContacts (add 1)`, () =>
      invoke<{ success: boolean; error?: string }>("transactions:batchUpdateContacts", txnId, [
        { action: "add", contactId: newId, role: "seller", roleCategory: "client", isPrimary: false },
      ]),
    );
    expect(save.success).toBe(true);
    const cc = await measure(`${mode} Clients & Contacts: get-all`, () => invoke<{ success: boolean; contacts: unknown[] }>("contacts:get-all", USER));
    expect(cc.success).toBe(true);
    await measure(`${mode} Clients & Contacts: get-all + get-available (parallel)`, () =>
      Promise.all([invoke("contacts:get-all", USER), invoke("contacts:get-available", USER)]),
    );
    // let any background work the handlers kicked off (get-all's backfill) finish before the next mode
    await new Promise((r) => setTimeout(r, 200));

    // BACKLOG-4180 PR 2: the scheduler's full pass with nothing new (what runs after a sync or the
    // get-available reconciliation). Before PR 2 it re-ran the backfill over every contact.
    logMock.info.mockClear();
    await measure(`${mode} scheduler pass, nothing new`, () =>
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../../services/contactLinkingScheduler").runContactLinkingNow(USER),
    );
    const lines = logMock.info.mock.calls.map((c: unknown[]) => String(c[0]));
    process.stderr.write(
      `[4180 ${SIZE}] control: ${lines.find((s: string) => s.startsWith("[Contacts] linking pass:")) ?? "NO PASS LINE"}; ` +
        `backfill line -> ${lines.find((s: string) => /re-ran backfill|Backfilled/.test(s)) ?? "(none)"}\n`,
    );
  }

  it("pool NOT ready (main-thread fallback)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pool = require("../../workers/contactWorkerPool");
    expect(pool.isPoolReady()).toBe(false);
    await addFlow("NO-POOL", 0);
    // control: the fallback really ran the address-book recency query on the main connection
    const ext = results.find((r) => r.label === "NO-POOL get-available (refresh)")!;
    expect(ext.worker.length).toBe(0);
  });

  it("pool READY (contact query worker up)", async () => {
    await startWorkerPool();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pool = require("../../workers/contactWorkerPool");
    expect(pool.isPoolReady()).toBe(true);
    await addFlow("POOL", 1);
    const ext = results.find((r) => r.label === "POOL get-available (refresh)")!;
    expect(ext.worker).toContain("pool:external");
  });

  it("EXPLAIN QUERY PLAN of the statements that dominate", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EXTERNAL_CONTACTS_GET_ALL_SQL } = require("../../services/db/contactRecencySql");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { candidateMessageThreadsSql } = require("../../services/db/autoLinkSql");
    const plan = (label: string, src: string) => {
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${src}`).all(...Array(((src.match(/\?/g) ?? []).length)).fill(null)) as Array<{ detail: string }>;
      process.stderr.write(`[4180 ${SIZE}] PLAN ${label}\n${rows.map((r) => "      " + r.detail).join("\n")}\n`);
    };
    plan("EXTERNAL_CONTACTS_GET_ALL_SQL", String(EXTERNAL_CONTACTS_GET_ALL_SQL));
    plan("candidateMessageThreadsSql(1)", String(candidateMessageThreadsSql(1)));
    // and every main-thread statement over 50 ms seen in any measurement
    const seen = new Set<string>();
    for (const r of results) {
      for (const [k, s] of r.top) {
        if (s.ms < 50 || seen.has(k)) continue;
        seen.add(k);
        try {
          plan(`${r.label} :: ${k.slice(0, 70)}`, s.src);
        } catch (e) {
          process.stderr.write(`[4180] plan failed for ${k}: ${e}\n`);
        }
      }
    }
  });
});
